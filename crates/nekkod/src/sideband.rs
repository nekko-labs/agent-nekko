//! One-shot completions the TS host asks for beside a turn (`provider:complete`):
//! a chat's title, the suggested replies, a prompt part to fill in.
//!
//! The host still builds the prompt and resolves the provider (a subscription
//! token is refreshed there); the call itself, and its stream, run here on the
//! Rust providers, so they stay off the TS event loop while a turn streams.

use nekko_agent::{ChatRequest, Io, Provider, ProviderChunk, ProviderConfig, create_provider_with};
use serde_json::{Value, json};
use std::time::Duration;

/// Used when the request names no timeout; the host's own calls give up at 30 s.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// `provider:complete`: run `request` on `provider` and return the reply's text.
pub async fn complete(spec: &Value) -> Result<Value, String> {
    complete_with(spec, Io::default()).await
}

async fn complete_with(spec: &Value, io: Io) -> Result<Value, String> {
    let config: ProviderConfig = serde_json::from_value(spec.get("provider").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("provider: {e}"))?;
    let request: ChatRequest = serde_json::from_value(spec.get("request").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("request: {e}"))?;
    let timeout = spec.get("timeoutMs").and_then(Value::as_u64).map_or(DEFAULT_TIMEOUT, Duration::from_millis);
    let provider = create_provider_with(config, io);
    let mut stream = provider.chat(request);
    let mut text = String::new();
    let read = async {
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(ProviderChunk::Text { delta }) => text.push_str(&delta),
                Ok(ProviderChunk::Done) => break,
                Ok(_) => {}
                Err(e) => return Err(e.message),
            }
        }
        Ok(())
    };
    match tokio::time::timeout(timeout, read).await {
        Ok(Ok(())) => Ok(json!({ "text": text })),
        Ok(Err(e)) => Err(e),
        // Dropping the stream closes the connection.
        Err(_) => Err("The model took too long to answer.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nekko_agent::http::{BoxFuture, HttpRequest, HttpResponse, ResponseBody, Transport, TransportError};
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    struct Body(VecDeque<Vec<u8>>, bool);

    impl ResponseBody for Body {
        fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
            let next = self.0.pop_front();
            let hang = self.1;
            Box::pin(async move {
                match next {
                    Some(c) => Ok(Some(c)),
                    None if hang => std::future::pending().await,
                    None => Ok(None),
                }
            })
        }
    }

    /// One scripted reply (server-sent events, or a status), recording the request.
    struct Wire {
        events: Vec<&'static str>,
        status: u16,
        hang: bool,
        sent: Mutex<Vec<HttpRequest>>,
    }

    impl Transport for Wire {
        fn send<'a>(&'a self, req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
            self.sent.lock().unwrap().push(req.clone());
            let chunks = self.events.iter().map(|e| format!("data: {e}\n\n").into_bytes()).collect();
            let (status, hang) = (self.status, self.hang);
            Box::pin(async move {
                Ok(HttpResponse {
                    status,
                    headers: vec![("content-type".into(), "text/event-stream".into())],
                    body: Box::new(Body(chunks, hang)),
                })
            })
        }
    }

    fn wire(events: Vec<&'static str>, status: u16, hang: bool) -> Arc<Wire> {
        Arc::new(Wire { events, status, hang, sent: Mutex::default() })
    }

    fn spec(timeout_ms: u64) -> Value {
        json!({
            "provider": { "id": "p", "kind": "llamacpp", "label": "P", "baseUrl": "http://127.0.0.1:1/v1", "enabled": true },
            "request": {
                "model": "gemma",
                "messages": [{ "id": "title", "role": "user", "content": "Name this chat", "createdAt": 1 }],
                "temperature": 0.2,
                "maxOutputTokens": 24,
                "think": false,
                "purpose": "title"
            },
            "timeoutMs": timeout_ms
        })
    }

    #[tokio::test]
    async fn returns_the_reply_text_and_sends_the_request_as_given() {
        let w = wire(
            vec![
                r#"{"choices":[{"delta":{"reasoning_content":"thinking"}}]}"#,
                r#"{"choices":[{"delta":{"content":"Fix the "}}]}"#,
                r#"{"choices":[{"delta":{"content":"parser"},"finish_reason":"stop"}]}"#,
                "[DONE]",
            ],
            200,
            false,
        );
        let out = complete_with(&spec(5_000), Io { transport: w.clone(), ..Io::default() }).await;
        assert_eq!(out, Ok(json!({ "text": "Fix the parser" })));
        let sent = w.sent.lock().unwrap();
        let body = sent[0].body.clone().unwrap_or_default();
        assert_eq!(body["model"], "gemma");
        assert_eq!(body["max_tokens"], 24);
        assert_eq!(body["messages"][0]["content"], "Name this chat");
    }

    #[tokio::test]
    async fn reports_a_failed_request_and_gives_up_at_the_timeout() {
        let failed = complete_with(&spec(5_000), Io { transport: wire(vec![], 500, false), ..Io::default() }).await;
        assert!(failed.is_err());
        let silent = complete_with(&spec(50), Io { transport: wire(vec![], 200, true), ..Io::default() }).await;
        assert_eq!(silent, Err("The model took too long to answer.".to_string()));
    }
}
