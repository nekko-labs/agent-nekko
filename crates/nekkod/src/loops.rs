//! Agent runs the daemon drives (PF14): `loop:run` and `loop:abort`.
//!
//! The TS host still decides everything about a turn (the provider and its
//! fresh token, the tools on offer, the context, the system prompt) and still
//! runs the tools, with their approvals, questions, MCP calls and sub-agents.
//! What moves here is the run itself: the Rust agent loop (`nekko-loop`)
//! streaming from the Rust providers (`nekko-agent`). Its events go to the UI
//! from here, in order, so a reply's tokens never wait on the TS event loop.
//!
//! `loop:run` returns at once and the run carries on in a task, because a
//! run can outlast any HTTP request (Node's fetch gives up on headers after
//! five minutes); `loop:end` hands the host the final transcript.
//!
//! The host hears about the run through `loop:event` (every event, text and
//! reasoning deltas batched, and the transcript at each checkpoint so it can
//! save it) and runs each tool call through `loop:tool`. A reply's `done` or
//! `error` reaches the UI only after the host has saved the transcript, so a
//! chat that reloads on `done` finds the step it was just told about.

use crate::backend::Backend;
use crate::hub::Hub;
use nekko_agent::{ProviderConfig, create_provider};
use nekko_chat::ProviderClient;
use nekko_loop::{Cancel, DEFAULT_MAX_STEPS, RunOptions, ToolRunner, run_agent};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

/// How long text and reasoning deltas are batched before the host gets them.
/// The UI gets each one at once; the host only relays them.
const DELTA_BATCH: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct Loops {
    runs: Arc<Mutex<HashMap<String, Cancel>>>,
}

/// Tool calls, run by the TS host.
struct HostTools {
    backend: Arc<Backend>,
    run_id: String,
}

impl ToolRunner for HostTools {
    async fn run(&self, call: &Value) -> Result<Value, String> {
        self.backend.call("loop:tool", json!([self.run_id, call])).await
    }
}

fn opt_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn is_delta(e: &Value) -> bool {
    matches!(e.get("type").and_then(Value::as_str), Some("text" | "reasoning"))
}

fn is_checkpoint(e: &Value) -> bool {
    matches!(e.get("type").and_then(Value::as_str), Some("tool_result" | "done" | "error"))
}

fn is_final(e: &Value) -> bool {
    matches!(e.get("type").and_then(Value::as_str), Some("done" | "error"))
}

/// Deltas of one kind in a row, joined, as the host relays them.
fn coalesce(batch: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for e in batch {
        if let Some(last) = out.last_mut()
            && last["type"] == e["type"]
        {
            let joined = format!("{}{}", last["delta"].as_str().unwrap_or(""), e["delta"].as_str().unwrap_or(""));
            last["delta"] = json!(joined);
            continue;
        }
        out.push(e);
    }
    out
}

/// Forward a run's events: to the UI straight away, to the host after, and a
/// final event to the UI only once the host has it.
async fn forward(
    mut rx: mpsc::UnboundedReceiver<(Value, Option<Vec<Value>>)>,
    backend: Arc<Backend>,
    hub: Hub,
    run_id: String,
) {
    let mut deltas: Vec<Value> = Vec::new();
    let flush = |deltas: &mut Vec<Value>| {
        let batch = std::mem::take(deltas);
        let backend = backend.clone();
        let run_id = run_id.clone();
        async move {
            if !batch.is_empty() {
                let _ = backend.call("loop:event", json!([run_id, { "events": coalesce(batch) }])).await;
            }
        }
    };
    loop {
        let next = if deltas.is_empty() {
            rx.recv().await
        } else {
            match tokio::time::timeout(DELTA_BATCH, rx.recv()).await {
                Ok(v) => v,
                Err(_) => {
                    flush(&mut deltas).await;
                    continue;
                }
            }
        };
        let Some((event, history)) = next else { break };
        if is_delta(&event) {
            hub.publish("agent:event", event.clone(), false);
            deltas.push(event);
            continue;
        }
        flush(&mut deltas).await;
        let mut payload = json!({ "events": [event.clone()] });
        if let Some(h) = history {
            payload["history"] = Value::Array(h);
        }
        if is_final(&event) {
            // The host saves the transcript first; then the UI may reload it.
            let _ = backend.call("loop:event", json!([run_id, payload])).await;
            hub.publish("agent:event", event, false);
        } else {
            hub.publish("agent:event", event, false);
            let _ = backend.call("loop:event", json!([run_id, payload])).await;
        }
    }
    flush(&mut deltas).await;
}

impl Loops {
    /// `loop:run`: start driving one reply; `loop:end` reports when it is over.
    pub fn start(&self, backend: Arc<Backend>, hub: Hub, spec: Value) -> Result<Value, String> {
        let run_id = spec.get("runId").and_then(Value::as_str).ok_or("loop:run needs a runId")?.to_string();
        let config: ProviderConfig = serde_json::from_value(spec.get("provider").cloned().unwrap_or(Value::Null))
            .map_err(|e| format!("provider: {e}"))?;
        let cancel = Cancel::default();
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).insert(run_id.clone(), cancel.clone());
        let runs = self.runs.clone();
        tokio::spawn(async move {
            let history = Self::drive(backend.clone(), hub, &spec, &run_id, config, cancel).await;
            runs.lock().unwrap_or_else(|e| e.into_inner()).remove(&run_id);
            let _ = backend.call("loop:end", json!([run_id, { "history": history }])).await;
        });
        Ok(json!({ "started": true }))
    }

    async fn drive(
        backend: Arc<Backend>,
        hub: Hub,
        spec: &Value,
        run_id: &str,
        config: ProviderConfig,
        cancel: Cancel,
    ) -> Vec<Value> {
        let run_id = run_id.to_string();
        let mut history = spec.get("history").and_then(Value::as_array).cloned().unwrap_or_default();

        let (tx, rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(forward(rx, backend.clone(), hub, run_id.clone()));
        let client = ProviderClient::new(create_provider(config));
        let tools = HostTools { backend, run_id: run_id.clone() };
        let str_of = |k: &str| spec.get(k).and_then(Value::as_str).map(str::to_string);
        let opts = RunOptions {
            session_id: str_of("sessionId").unwrap_or_default(),
            model: str_of("model").unwrap_or_default(),
            system: str_of("system").unwrap_or_default(),
            history: &mut history,
            tools: spec.get("tools").and_then(Value::as_array).cloned().unwrap_or_default(),
            max_iterations: spec.get("maxIterations").and_then(Value::as_u64).map_or(DEFAULT_MAX_STEPS, |n| n as usize),
            temperature: opt_f64(spec, "temperature"),
            effort: str_of("effort"),
            think: spec.get("think").and_then(Value::as_bool),
            max_history_turns: opt_f64(spec, "maxHistoryTurns"),
            max_output_tokens: spec.get("maxOutputTokens").and_then(Value::as_u64),
            resume: spec.get("resume") == Some(&json!(true)),
            cancel,
        };
        run_agent(opts, &client, &tools, &mut |event: Value, transcript: &[Value]| {
            let snapshot = is_checkpoint(&event).then(|| transcript.to_vec());
            let _ = tx.send((event, snapshot));
        })
        .await;
        drop(tx);
        let _ = forwarder.await;
        history
    }

    /// `loop:abort`: stop a run; true when there was one.
    pub fn abort(&self, run_id: &str) -> bool {
        match self.runs.lock().unwrap_or_else(|e| e.into_inner()).get(run_id) {
            Some(c) => {
                c.cancel();
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_runs_of_the_same_delta_kind_only() {
        let e = |t: &str, d: &str| json!({ "type": t, "sessionId": "s", "delta": d });
        let out = coalesce(vec![
            e("reasoning", "a"),
            e("reasoning", "b"),
            e("text", "c"),
            e("text", "d"),
            e("reasoning", "e"),
        ]);
        assert_eq!(out, vec![e("reasoning", "ab"), e("text", "cd"), e("reasoning", "e")]);
    }
}
