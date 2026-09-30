//! Any OpenAI-compatible `/chat/completions` endpoint: OpenAI, OpenRouter,
//! LM Studio, vLLM, the Nekko engine's router (`llamacpp`) and generic
//! servers. They differ only in base URL, auth header and a few extras, which
//! come from the config. A port of `openai-compat.ts`.

use super::{Io, extract_api_error, friendly_error};
use crate::http::{HttpRequest, HttpResponse, headers};
use crate::js;
use crate::sse::SseParser;
use crate::stream::{ChunkStream, DecodeClock, Sink, Stop, spawn};
use crate::types::*;
use serde_json::{Map, Value, json};

#[derive(Clone)]
pub struct OpenAiCompatProvider {
    config: ProviderConfig,
    io: Io,
}

impl OpenAiCompatProvider {
    pub fn new(config: ProviderConfig, io: Io) -> Self {
        Self { config, io }
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    /// The API base. Users often paste `http://host:port` for a server that
    /// serves the OpenAI routes under `/v1`, so a URL with no path gets `/v1`;
    /// one that has a path is left alone, as is anything that does not parse.
    pub fn base(&self) -> String {
        let url = js::trim(&self.config.base_url).trim_end_matches('/');
        match reqwest::Url::parse(url) {
            Ok(u) if u.path().is_empty() || u.path() == "/" => format!("{url}/v1"),
            _ => url.to_string(),
        }
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut h = headers(&[("Content-Type", "application/json")]);
        if let Some(key) = self.config.api_key.as_deref().filter(|k| !k.is_empty()) {
            h.push(("Authorization".into(), format!("Bearer {key}")));
        }
        if self.config.kind == ProviderKind::Openrouter {
            h.push(("HTTP-Referer".into(), "https://github.com/nekko-labs/agent-nekko".into()));
            h.push(("X-Title".into(), "Agent Nekko".into()));
        }
        h
    }

    /// The request `chat` sends.
    pub fn chat_request(&self, req: &ChatRequest) -> HttpRequest {
        // `chat_template_kwargs.enable_thinking` (Qwen3 and friends) only goes
        // to local kinds: cloud endpoints reject unknown body fields.
        let local = matches!(
            self.config.kind,
            ProviderKind::Lmstudio | ProviderKind::Vllm | ProviderKind::Llamacpp | ProviderKind::OpenaiCompat
        );
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        body.insert("stream".into(), json!(true));
        body.insert("stream_options".into(), json!({ "include_usage": true }));
        body.insert("temperature".into(), json!(req.temperature.unwrap_or(0.7)));
        // Output cap: without it a looping local model streams until its
        // context window fills. Zero means unset, as the TS truthiness test reads it.
        if let Some(max) = req.max_output_tokens.filter(|m| *m > 0) {
            body.insert("max_tokens".into(), json!(max));
        }
        body.insert("messages".into(), Value::Array(to_openai_messages(req)));
        if let Some(tools) = &req.tools {
            body.insert("tools".into(), tools.iter().map(openai_tool).collect());
        }
        if let (Some(think), true) = (req.think, local) {
            body.insert("chat_template_kwargs".into(), json!({ "enable_thinking": think }));
        }
        HttpRequest::post(format!("{}/chat/completions", self.base()), self.headers(), Value::Object(body))
    }

    pub fn chat(&self, req: ChatRequest) -> ChunkStream {
        let me = self.clone();
        spawn(req.signal.clone(), move |sink| async move { me.run(req, sink).await })
    }

    async fn run(self, req: ChatRequest, sink: Sink) -> Result<(), Stop> {
        let http = self.chat_request(&req);
        let mut res = match sink.send(&*self.io.transport, &http).await? {
            Ok(res) => res,
            Err(e) => return Err(ProviderError::new(friendly_error(&e.message, || self.unreachable())).into()),
        };
        if !res.ok() {
            let text = sink.text(&mut res).await?;
            // OpenAI-style bodies carry { error: { message } }: surface that
            // instead of raw JSON, so 401/402/429 replies read like sentences.
            let detail = if text.is_empty() { String::new() } else { format!(": {}", extract_api_error(&text)) };
            return Err(
                ProviderError::http(res.status, format!("Model request failed (HTTP {}){detail}", res.status)).into()
            );
        }
        let mut parser = ChatParser::new(DecodeClock::new(self.io.clock.clone()));
        let mut sse = SseParser::default();
        while let Some(bytes) = sink.read(&mut res).await? {
            let batch = sse.feed(&bytes);
            for data in &batch.data {
                for chunk in parser.event(data) {
                    sink.emit(chunk).await?;
                }
            }
            if batch.done {
                break;
            }
        }
        sink.emit(ProviderChunk::Done).await
    }

    fn unreachable(&self) -> String {
        format!("Can't reach the model server at {}. Is it running and reachable on the network?", self.base())
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        // LM Studio's native REST API reports per-model load state, which
        // /v1/models does not. Prefer it there, falling back on any failure.
        if self.config.kind == ProviderKind::Lmstudio
            && let Some(models) = self.lm_studio_models().await
        {
            return Ok(models);
        }
        let req = HttpRequest::get(format!("{}/models", self.base()), self.headers());
        let mut res = self.io.transport.send(&req).await.map_err(|e| ProviderError::new(e.message))?;
        let text = res.text().await;
        if !res.ok() {
            return Err(ProviderError::http(
                res.status,
                format!("listModels {}: {}", res.status, extract_api_error(&text)),
            ));
        }
        let json: Value = serde_json::from_str(&text).map_err(|e| ProviderError::new(format!("listModels: {e}")))?;
        let openrouter = self.config.kind == ProviderKind::Openrouter;
        let data = json.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(data
            .iter()
            .map(|m| {
                let id = m.get("id").map(js::display).unwrap_or_default();
                let input = js::to_number(m.pointer("/pricing/prompt"));
                let output = js::to_number(m.pointer("/pricing/completion"));
                let priced = openrouter && input.is_finite() && output.is_finite();
                // OpenRouter supplies a display name ("OpenAI: GPT-5"); everyone
                // else only has the id.
                let name = match m.get("name") {
                    n if openrouter && js::truthy(n) => n.map(js::display).unwrap_or_default(),
                    _ => id.clone(),
                };
                let context = js::coalesce(m.get("context_length"), m.pointer("/top_provider/context_length"));
                let tools = openrouter && supports_tools(m.get("supported_parameters"));
                ModelInfo {
                    id,
                    provider_id: self.config.id.clone(),
                    name,
                    context_length: context.and_then(Value::as_u64),
                    input_price_per_m: priced.then_some(input * 1e6),
                    output_price_per_m: priced.then_some(output * 1e6),
                    details: tools.then(|| Map::from_iter([("tools".to_string(), json!("yes"))])),
                    // vLLM serves exactly the model(s) it was launched with.
                    loaded: (self.config.kind == ProviderKind::Vllm).then_some(true),
                    ..Default::default()
                }
            })
            .collect())
    }

    /// LM Studio's model list with load state (`/api/v0/models`), or `None`
    /// on any failure, so the caller falls back to `/v1/models`.
    async fn lm_studio_models(&self) -> Option<Vec<ModelInfo>> {
        let base = self.base();
        let root = base.strip_suffix("/v1").unwrap_or(&base);
        let req = HttpRequest::get(format!("{root}/api/v0/models"), self.headers());
        let mut res: HttpResponse = self.io.transport.send(&req).await.ok()?;
        if !res.ok() {
            return None;
        }
        let text = res.text().await;
        let json: Value = serde_json::from_str(&text).ok()?;
        if json.is_null() {
            return None;
        }
        let data = json.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        Some(
            data.iter()
                .map(|m| {
                    let id = m.get("id").map(js::display).unwrap_or_default();
                    let context = js::coalesce(m.get("loaded_context_length"), m.get("max_context_length"));
                    ModelInfo {
                        name: id.clone(),
                        id,
                        provider_id: self.config.id.clone(),
                        context_length: context.and_then(Value::as_u64),
                        loaded: Some(m.get("state").and_then(Value::as_str) == Some("loaded")),
                        ..Default::default()
                    }
                })
                .collect(),
        )
    }
}

/// `supported_parameters?.includes('tools')`, for an array or a string.
fn supports_tools(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(a)) => a.iter().any(|x| x == "tools"),
        Some(Value::String(s)) => s.contains("tools"),
        _ => false,
    }
}

fn openai_tool(t: &ToolSpec) -> Value {
    json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } })
}

fn to_openai_messages(req: &ChatRequest) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        out.push(json!({ "role": "system", "content": system }));
    }
    for m in &req.messages {
        if let (Role::Tool, Some(r)) = (m.role, &m.tool_result) {
            out.push(json!({ "role": "tool", "tool_call_id": r.tool_call_id, "content": r.output }));
        } else if let (Role::Assistant, Some(calls)) = (m.role, m.calls()) {
            let calls: Vec<Value> = calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "type": "function",
                        "function": { "name": c.name, "arguments": js::stringify(&c.input) },
                    })
                })
                .collect();
            let content = if m.content.is_empty() { Value::Null } else { json!(m.content) };
            out.push(json!({ "role": "assistant", "content": content, "tool_calls": calls }));
        } else {
            let content = match m.user_images() {
                Some(images) => {
                    let mut parts = vec![json!({ "type": "text", "text": m.content })];
                    parts.extend(images.iter().map(|url| json!({ "type": "image_url", "image_url": { "url": url } })));
                    Value::Array(parts)
                }
                None => json!(m.content),
            };
            out.push(json!({ "role": m.role, "content": content }));
        }
    }
    out
}

/// A tool call being assembled from streamed fragments.
struct PartialCall {
    id: String,
    name: String,
    args: String,
}

/// Turns `/chat/completions` stream events into chunks.
pub(crate) struct ChatParser {
    /// By `index`, in first-seen order (a JS `Map`).
    calls: Vec<(String, PartialCall)>,
    /// `include_usage` puts the usage event after the last content event, so
    /// the clock covers exactly the span its tokens were generated in.
    decode: DecodeClock,
}

impl ChatParser {
    pub(crate) fn new(decode: DecodeClock) -> Self {
        Self { calls: Vec::new(), decode }
    }

    pub(crate) fn event(&mut self, data: &str) -> Vec<ProviderChunk> {
        let mut out = Vec::new();
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { return out };
        let choice = chunk.get("choices").and_then(|c| c.get(0));
        let delta = choice.and_then(|c| c.get("delta"));
        // Reasoning models stream their chain of thought as `reasoning_content`
        // (or `reasoning`). `??`, not `||`: an empty `reasoning_content` wins.
        let reasoning =
            js::coalesce(delta.and_then(|d| d.get("reasoning_content")), delta.and_then(|d| d.get("reasoning")));
        if let Some(r) = js::truthy_str(reasoning) {
            self.decode.mark();
            out.push(ProviderChunk::Reasoning { delta: r.to_string() });
        }
        if let Some(text) = js::truthy_str(delta.and_then(|d| d.get("content"))) {
            self.decode.mark();
            out.push(ProviderChunk::Text { delta: text.to_string() });
        }
        let tool_calls = delta.and_then(|d| d.get("tool_calls"));
        if js::truthy(tool_calls) {
            // Tool arguments are generated tokens too, so a response that only
            // calls a tool still has a decode rate.
            self.decode.mark();
            for tc in tool_calls.and_then(Value::as_array).into_iter().flatten().filter(|t| t.is_object()) {
                self.fragment(tc);
            }
        }
        if let Some(usage) = chunk.get("usage").filter(|u| js::truthy(Some(u))) {
            self.decode.stop();
            out.push(ProviderChunk::Usage {
                input_tokens: usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
                output_tokens: usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
                output_ms: self.decode.elapsed(),
            });
        }
        if js::truthy(choice.and_then(|c| c.get("finish_reason"))) {
            for (_, acc) in self.calls.drain(..) {
                out.push(ProviderChunk::ToolCall {
                    call: ToolCall { id: acc.id, name: acc.name, input: js::safe_parse(&acc.args) },
                });
            }
        }
        out
    }

    fn fragment(&mut self, tc: &Value) {
        let index = js::coalesce(tc.get("index"), None).cloned().unwrap_or(json!(0));
        let key = js::stringify(&index);
        let pos = match self.calls.iter().position(|(k, _)| *k == key) {
            Some(p) => p,
            None => {
                let id = match tc.get("id") {
                    Some(id) if !js::nullish(Some(id)) => js::display(id),
                    _ => format!("call_{}", js::display(&index)),
                };
                self.calls.push((key, PartialCall { id, name: String::new(), args: String::new() }));
                self.calls.len() - 1
            }
        };
        let cur = &mut self.calls[pos].1;
        if let Some(id) = tc.get("id").filter(|v| js::truthy(Some(v))) {
            cur.id = js::display(id);
        }
        if let Some(name) = tc.pointer("/function/name").filter(|v| js::truthy(Some(v))) {
            cur.name.push_str(&js::display(name));
        }
        if let Some(args) = tc.pointer("/function/arguments").filter(|v| js::truthy(Some(v))) {
            cur.args.push_str(&js::display(args));
        }
    }
}
