//! ChatGPT-plan models through the Codex backend: the Responses API over SSE
//! at `{baseUrl}/codex/responses`. A port of `chatgpt.ts`.
//!
//! Only usable with a subscription token. The OAuth sign-in and refresh stay
//! in the TS host, which passes the fresh access token as `config.api_key`
//! and the ChatGPT account id as `config.account_id`.

use super::{Io, friendly_error};
use crate::http::HttpRequest;
use crate::js;
use crate::sse::SseParser;
use crate::stream::{ChunkStream, DecodeClock, Sink, Stop, spawn};
use crate::types::*;
use serde_json::{Map, Value, json};

/// The Codex backend has no public /models route, so the subscription model
/// set ships as a curated list.
const CHATGPT_MODELS: &[(&str, &str, u64)] = &[
    ("gpt-5-codex", "GPT-5 Codex", 400_000),
    ("gpt-5", "GPT-5", 400_000),
    ("codex-mini-latest", "Codex Mini", 200_000),
];

/// Required for Responses-API streaming on the Codex backend.
const RESPONSES_BETA: &str = "responses=experimental";
/// What the first-party Codex CLI sends.
const ORIGINATOR: &str = "codex_cli_rs";

const MISSING_ACCOUNT_ID: &str = "This ChatGPT sign-in is missing an account id. Sign out and sign in again so it can be captured (sessions signed in before this version may lack one).";

#[derive(Clone)]
pub struct ChatGptProvider {
    config: ProviderConfig,
    io: Io,
    /// One per provider instance (about one agent run): scopes a conversation
    /// for the backend's caching.
    session_id: String,
}

impl ChatGptProvider {
    pub fn new(config: ProviderConfig, io: Io) -> Self {
        Self { config, io, session_id: uuid_v4() }
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn base(&self) -> &str {
        js::trim(&self.config.base_url).trim_end_matches('/')
    }

    /// Fails without an account id: the backend 401s without it, and a clear
    /// sign-in-again error beats a cryptic upstream rejection.
    fn headers(&self) -> Result<Vec<(String, String)>, ProviderError> {
        let account = self.config.account_id.as_deref().filter(|a| !a.is_empty());
        let account = account.ok_or_else(|| ProviderError::new(MISSING_ACCOUNT_ID))?;
        let key = self.config.api_key.as_deref().unwrap_or("");
        Ok(vec![
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), format!("Bearer {key}")),
            ("chatgpt-account-id".into(), account.into()),
            ("OpenAI-Beta".into(), RESPONSES_BETA.into()),
            ("originator".into(), ORIGINATOR.into()),
            ("session_id".into(), self.session_id.clone()),
        ])
    }

    /// The request `chat` sends.
    pub fn chat_request(&self, req: &ChatRequest) -> Result<HttpRequest, ProviderError> {
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        if let Some(system) = &req.system {
            body.insert("instructions".into(), json!(system));
        }
        body.insert("input".into(), Value::Array(to_response_items(req)));
        if let Some(tools) = &req.tools {
            let tools = tools
                .iter()
                .map(|t| json!({ "type": "function", "name": t.name, "description": t.description, "parameters": t.parameters }))
                .collect();
            body.insert("tools".into(), Value::Array(tools));
        }
        body.insert("stream".into(), json!(true));
        body.insert("store".into(), json!(false));
        if let Some(t) = req.temperature {
            body.insert("temperature".into(), json!(t));
        }
        if let Some(max) = req.max_output_tokens.filter(|m| *m > 0) {
            body.insert("max_output_tokens".into(), json!(max));
        }
        if req.think == Some(true) {
            body.insert("reasoning".into(), json!({ "summary": "auto" }));
        }
        Ok(HttpRequest::post(format!("{}/codex/responses", self.base()), self.headers()?, Value::Object(body)))
    }

    pub fn chat(&self, req: ChatRequest) -> ChunkStream {
        let me = self.clone();
        spawn(req.signal.clone(), move |sink| async move { me.run(req, sink).await })
    }

    async fn run(self, req: ChatRequest, sink: Sink) -> Result<(), Stop> {
        let http = self.chat_request(&req)?;
        let mut res = match sink.send(&*self.io.transport, &http).await? {
            Ok(res) => res,
            Err(e) => {
                let reach = || format!("Can't reach ChatGPT at {}. Check the network connection.", self.base());
                return Err(ProviderError::new(friendly_error(&e.message, reach)).into());
            }
        };
        // Before the status check: a 429's headers carry the limit that was hit.
        if let Some(hook) = &req.on_headers {
            hook(&res.headers);
        }
        if !res.ok() {
            let text = sink.text(&mut res).await?;
            let message = format!("chatgpt {}: {}", res.status, js::slice16(&text, 200));
            return Err(ProviderError::http(res.status, message).into());
        }

        // From the first generated delta to the event that reports usage.
        let mut decode = DecodeClock::new(self.io.clock.clone());
        let mut sse = SseParser::default();
        while let Some(bytes) = sink.read(&mut res).await? {
            let batch = sse.feed(&bytes);
            for data in &batch.data {
                let Ok(ev) = serde_json::from_str::<Value>(data) else { continue };
                match ev.get("type").and_then(Value::as_str) {
                    Some("response.output_text.delta") => {
                        if let Some(d) = js::truthy_str(ev.get("delta")) {
                            decode.mark();
                            sink.emit(ProviderChunk::Text { delta: d.to_string() }).await?;
                        }
                    }
                    Some("response.reasoning_summary_text.delta") => {
                        if let Some(d) = js::truthy_str(ev.get("delta")) {
                            decode.mark();
                            sink.emit(ProviderChunk::Reasoning { delta: d.to_string() }).await?;
                        }
                    }
                    Some("response.output_item.done") => {
                        let item = ev.get("item");
                        if item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("function_call") {
                            decode.mark();
                            let item = item.unwrap_or(&Value::Null);
                            let id = js::coalesce(item.get("call_id"), item.get("id")).map(js::display);
                            let args = item.get("arguments").and_then(Value::as_str).unwrap_or("");
                            let call = ToolCall {
                                id: id.unwrap_or_default(),
                                name: item.get("name").map(js::display).unwrap_or_default(),
                                input: js::safe_parse(args),
                            };
                            sink.emit(ProviderChunk::ToolCall { call }).await?;
                        }
                    }
                    // `incomplete`: hit the output cap (or another length
                    // stop). Keep what streamed, and end the same way.
                    Some("response.completed" | "response.incomplete") => {
                        decode.stop();
                        if let Some(usage) = ev.pointer("/response/usage").filter(|u| js::truthy(Some(u))) {
                            sink.emit(ProviderChunk::Usage {
                                input_tokens: usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
                                output_tokens: usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
                                output_ms: decode.elapsed(),
                            })
                            .await?;
                        }
                        return sink.emit(ProviderChunk::Done).await;
                    }
                    Some("response.failed" | "error") => {
                        let message =
                            [ev.pointer("/response/error/message"), ev.pointer("/error/message"), ev.get("message")]
                                .into_iter()
                                .find(|v| !js::nullish(*v))
                                .flatten()
                                .map(js::display)
                                .unwrap_or_else(|| "unknown error".into());
                        return Err(ProviderError::new(format!("chatgpt response failed: {message}")).into());
                    }
                    _ => {}
                }
            }
            if batch.done {
                break;
            }
        }
        sink.emit(ProviderChunk::Done).await
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let mut all: Vec<ModelInfo> = CHATGPT_MODELS
            .iter()
            .map(|(id, name, ctx)| ModelInfo {
                id: id.to_string(),
                provider_id: self.config.id.clone(),
                name: name.to_string(),
                context_length: Some(*ctx),
                ..Default::default()
            })
            .collect();
        let custom = self.config.custom_model_id.as_deref().map(js::trim).filter(|c| !c.is_empty());
        if let Some(custom) = custom
            && !all.iter().any(|m| m.id == custom)
        {
            all.push(ModelInfo {
                id: custom.to_string(),
                provider_id: self.config.id.clone(),
                name: format!("{custom} (custom)"),
                context_length: Some(128_000),
                ..Default::default()
            });
        }
        Ok(all)
    }
}

/// Map normalized chat history onto Responses API input items. A `system`
/// message in history is covered by `instructions` and dropped here.
fn to_response_items(req: &ChatRequest) -> Vec<Value> {
    let mut out = Vec::new();
    for m in &req.messages {
        if let (Role::Tool, Some(r)) = (m.role, &m.tool_result) {
            out.push(json!({ "type": "function_call_output", "call_id": r.tool_call_id, "output": r.output }));
        } else if m.role == Role::Assistant {
            if !m.content.is_empty() {
                out.push(json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": m.content }],
                }));
            }
            for c in m.tool_calls.iter().flatten() {
                out.push(json!({
                    "type": "function_call",
                    "call_id": c.id,
                    "name": c.name,
                    "arguments": js::stringify(&c.input),
                }));
            }
        } else if m.role == Role::User {
            let mut content = vec![json!({ "type": "input_text", "text": m.content })];
            for url in m.images.iter().flatten() {
                content.push(json!({ "type": "input_image", "image_url": url }));
            }
            out.push(json!({ "type": "message", "role": "user", "content": content }));
        }
    }
    out
}

/// A random (version 4) UUID, as `crypto.randomUUID()` makes.
fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    // Without entropy the id is still unique enough for a cache scope.
    if getrandom::fill(&mut b).is_err() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        b = nanos.to_le_bytes();
    }
    b[6] = (b[6] & 0x0F) | 0x40;
    b[8] = (b[8] & 0x3F) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    #[test]
    fn makes_v4_uuids() {
        let id = super::uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(id, super::uuid_v4());
    }
}
