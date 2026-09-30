//! One streamed chat completion against any OpenAI-compatible server, timed.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Label in the report ("Agent Nekko engine", "Ollama", ...).
    pub name: String,
    /// Up to and including `/v1`.
    pub base_url: String,
    /// The model name this server knows the file by.
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// Extra body fields for this server only (for example Ollama's `options`).
    #[serde(default)]
    pub extra: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// Request sent to first generated token.
    pub ttft_ms: f64,
    pub total_ms: f64,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: u64,
    /// Whether `completion_tokens` came from the server's usage report
    /// (exact) or from counting streamed deltas (approximate).
    pub counted_by_server: bool,
}

impl Sample {
    /// Generated tokens per second after the first one arrived.
    pub fn decode_tps(&self) -> Option<f64> {
        let secs = (self.total_ms - self.ttft_ms) / 1000.0;
        (self.completion_tokens > 1 && secs > 0.0).then(|| (self.completion_tokens - 1) as f64 / secs)
    }

    /// Prompt tokens processed per second before the first token.
    pub fn prefill_tps(&self) -> Option<f64> {
        let p = self.prompt_tokens? as f64;
        (self.ttft_ms > 0.0).then(|| p / (self.ttft_ms / 1000.0))
    }
}

pub async fn chat(
    http: &reqwest::Client,
    target: &Target,
    messages: &[Value],
    max_tokens: u32,
) -> anyhow::Result<(Sample, String)> {
    let mut body = json!({
        "model": target.model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0,
        "seed": 1,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if let (Some(Value::Object(extra)), Value::Object(b)) = (&target.extra, &mut body) {
        for (k, v) in extra {
            b.insert(k.clone(), v.clone());
        }
    }
    let url = format!("{}/chat/completions", target.base_url.trim_end_matches('/'));
    let mut req = http.post(url).json(&body).timeout(Duration::from_secs(900));
    if let Some(key) = &target.api_key {
        req = req.bearer_auth(key);
    }
    let started = Instant::now();
    let mut res = req.send().await?;
    if !res.status().is_success() {
        let status = res.status();
        anyhow::bail!("{}: HTTP {status}: {}", target.name, res.text().await.unwrap_or_default());
    }

    let mut first: Option<f64> = None;
    let mut deltas = 0u64;
    let mut usage: Option<(Option<u64>, u64)> = None;
    let mut text = String::new();
    let mut pending = String::new();
    'outer: while let Some(chunk) = res.chunk().await? {
        pending.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = pending.find('\n') {
            let line: String = pending.drain(..=end).collect();
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                break 'outer;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                let completion = u.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0);
                usage = Some((u.get("prompt_tokens").and_then(Value::as_u64), completion));
            }
            let delta = v.pointer("/choices/0/delta");
            // Reasoning models stream their thinking in a separate field; it is
            // generated tokens all the same.
            let piece = delta
                .and_then(|d| {
                    // The first non-empty one: a server may send `content: ""`
                    // beside the reasoning text it is actually streaming.
                    ["content", "reasoning_content", "reasoning"]
                        .iter()
                        .filter_map(|k| d.get(*k).and_then(Value::as_str))
                        .find(|s| !s.is_empty())
                })
                .unwrap_or("");
            if !piece.is_empty() {
                if first.is_none() {
                    first = Some(started.elapsed().as_secs_f64() * 1000.0);
                }
                deltas += 1;
                text.push_str(piece);
            }
        }
    }
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    let (prompt_tokens, completion_tokens, counted_by_server) = match usage {
        Some((p, c)) if c > 0 => (p, c, true),
        Some((p, _)) => (p, deltas, false),
        None => (None, deltas, false),
    };
    Ok((
        Sample { ttft_ms: first.unwrap_or(total_ms), total_ms, prompt_tokens, completion_tokens, counted_by_server },
        text,
    ))
}
