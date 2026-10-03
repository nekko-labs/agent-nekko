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
use nekko_loop::{Cancel, RunOptions, ToolRunner, run_agent};
use nekko_tools::{ChangeTracker, CommandLog, ToolCall, ToolContext, approver_fn, is_ported};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

/// How long text and reasoning deltas are batched before the host gets them.
/// The UI gets each one at once; the host only relays them.
const DELTA_BATCH: Duration = Duration::from_millis(100);

pub struct Loops {
    runs: Arc<Mutex<HashMap<String, Cancel>>>,
    /// Pending changes, shared with the `changes:*` channels and the TS
    /// host's own tool executor (`changes:record`), so there is one list.
    pub changes: Arc<ChangeTracker>,
}

impl Loops {
    pub fn new(changes: Arc<ChangeTracker>) -> Self {
        Self { runs: Arc::default(), changes }
    }
}

/// A run's tool calls. The built-in file and shell tools the host lists in
/// `toolContext.native` run here (`nekko-tools`), asking the host only for
/// approvals (`loop:approve`) and mirroring commands into its agent terminal
/// (`loop:log`); everything else (questions, sub-agents, MCP, plans, the
/// browser) runs in the host through `loop:tool`.
struct HostTools {
    backend: Arc<Backend>,
    run_id: String,
    native: Option<(Vec<String>, ToolContext)>,
}

impl ToolRunner for HostTools {
    async fn run(&self, call: &Value) -> Result<Value, String> {
        let name = call.get("name").and_then(Value::as_str).unwrap_or_default();
        if let Some((names, ctx)) = &self.native
            && is_ported(name)
            && names.iter().any(|n| n == name)
        {
            let call: ToolCall = serde_json::from_value(call.clone()).map_err(|e| e.to_string())?;
            return serde_json::to_value(nekko_tools::execute(&call, ctx).await).map_err(|e| e.to_string());
        }
        self.backend.call("loop:tool", json!([self.run_id, call])).await
    }
}

/// The agent terminal lines of one run, sent to the host in order.
struct HostLog(mpsc::UnboundedSender<Value>);

impl CommandLog for HostLog {
    fn append(&self, session_id: &str, workspace_id: Option<&str>, data: &str) {
        let _ = self.0.send(json!([session_id, workspace_id, data]));
    }
}

/// The tool context the host described in `spec.toolContext`, or `None` to
/// run every tool in the host (no context given, or one this build cannot
/// read, such as a guardrail rule it does not know).
fn native_tools(
    spec: &Value,
    backend: &Arc<Backend>,
    run_id: &str,
    changes: Arc<ChangeTracker>,
    cancel: &Cancel,
) -> Option<(Vec<String>, ToolContext)> {
    let tc = spec.get("toolContext")?;
    let names: Vec<String> = serde_json::from_value(tc.get("native")?.clone()).ok()?;
    let parse = |key: &str| tc.get(key).filter(|v| !v.is_null()).cloned();
    let (b, id) = (backend.clone(), run_id.to_string());
    let approver = approver_fn(move |call: ToolCall, reason: String, severity| {
        let (b, id) = (b.clone(), id.clone());
        async move { b.call("loop:approve", json!([id, call, reason, severity])).await.is_ok_and(|v| v == json!(true)) }
    });
    let mut ctx = ToolContext::new(approver);
    if let Some(v) = parse("sandboxMode") {
        ctx.sandbox_mode = serde_json::from_value(v).ok()?;
    }
    if let Some(v) = parse("guardrails") {
        ctx.guardrails = Some(serde_json::from_value(v).ok()?);
    }
    if let Some(v) = parse("workspaces") {
        ctx.workspaces = serde_json::from_value(v).ok()?;
    }
    if let Some(v) = parse("mode") {
        ctx.mode = serde_json::from_value(v).ok()?;
    }
    ctx.default_cwd = tc.get("defaultCwd").and_then(Value::as_str).map(str::to_string);
    ctx.session_id = tc.get("sessionId").and_then(Value::as_str).map(str::to_string);
    ctx.changes = Some(changes);
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let b = backend.clone();
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            let _ = b.call("loop:log", line).await;
        }
    });
    ctx.command_log = Some(Arc::new(HostLog(tx)));
    // Stop stops a running command too.
    let tools_cancel = ctx.cancel.clone();
    cancel.on_cancel(move || tools_cancel.cancel());
    Some((names, ctx))
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
        let changes = self.changes.clone();
        tokio::spawn(async move {
            let history = Self::drive(backend.clone(), hub, &spec, &run_id, config, cancel, changes).await;
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
        changes: Arc<ChangeTracker>,
    ) -> Vec<Value> {
        let run_id = run_id.to_string();
        let mut history = spec.get("history").and_then(Value::as_array).cloned().unwrap_or_default();

        let (tx, rx) = mpsc::unbounded_channel();
        let forwarder = tokio::spawn(forward(rx, backend.clone(), hub, run_id.clone()));
        let client = ProviderClient::new(create_provider(config));
        let native = native_tools(spec, &backend, &run_id, changes, &cancel);
        let tools = HostTools { backend, run_id: run_id.clone(), native };
        let str_of = |k: &str| spec.get(k).and_then(Value::as_str).map(str::to_string);
        let opts = RunOptions {
            session_id: str_of("sessionId").unwrap_or_default(),
            model: str_of("model").unwrap_or_default(),
            system: str_of("system").unwrap_or_default(),
            history: &mut history,
            tools: spec.get("tools").and_then(Value::as_array).cloned().unwrap_or_default(),
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

    fn workspace() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("nekkod-tools-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("app.ts"),
            "export const secret = 'pineapple';
",
        )
        .unwrap();
        dir
    }

    fn tools(dir: &std::path::Path, mode: &str, native: &[&str], changes: Arc<ChangeTracker>) -> HostTools {
        let spec = json!({ "toolContext": {
            "native": native,
            "sessionId": "s1",
            "mode": mode,
            "sandboxMode": "workspace-jail",
            "workspaces": [{ "id": "w1", "path": dir.to_string_lossy() }],
            "defaultCwd": dir.to_string_lossy(),
        } });
        // A host that is not there: any call back to it fails, and an
        // approval it cannot answer is a no.
        let backend = Backend::disabled();
        let native = native_tools(&spec, &backend, "run_1", changes, &Cancel::default());
        HostTools { backend, run_id: "run_1".into(), native }
    }

    #[tokio::test]
    async fn runs_the_listed_builtin_tools_here_and_the_rest_in_the_host() {
        let dir = workspace();
        let changes = Arc::new(ChangeTracker::new());
        let t = tools(&dir, "guardrails", &["read_file", "write_file"], changes.clone());

        let read = t.run(&json!({ "id": "c1", "name": "read_file", "input": { "path": "app.ts" } })).await.unwrap();
        assert_eq!(
            read,
            json!({ "toolCallId": "c1", "output": "export const secret = 'pineapple';
" })
        );

        let wrote = t
            .run(&json!({ "id": "c2", "name": "write_file", "input": { "path": "app.ts", "content": "x" } }))
            .await
            .unwrap();
        assert_eq!(wrote["isError"], Value::Null);
        let listed = changes.list_changes("s1");
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].original,
            "export const secret = 'pineapple';
"
        );
        assert_eq!(listed[0].current, "x");

        // Not listed as native (bash), or not a built-in at all: the host's.
        assert!(t.run(&json!({ "id": "c3", "name": "bash", "input": { "command": "echo hi" } })).await.is_err());
        assert!(t.run(&json!({ "id": "c4", "name": "ask_user", "input": {} })).await.is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn asks_the_host_to_approve_in_ask_mode() {
        let dir = workspace();
        let t = tools(&dir, "ask", &["write_file"], Arc::new(ChangeTracker::new()));
        let out = t
            .run(&json!({ "id": "c1", "name": "write_file", "input": { "path": "new.ts", "content": "x" } }))
            .await
            .unwrap();
        assert_eq!(out, json!({ "toolCallId": "c1", "output": "Write not approved by user.", "isError": true }));
        assert!(!dir.join("new.ts").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn leaves_every_tool_to_the_host_when_the_context_is_missing_or_unreadable() {
        let backend = Backend::disabled();
        let changes = Arc::new(ChangeTracker::new());
        assert!(native_tools(&json!({}), &backend, "r", changes.clone(), &Cancel::default()).is_none());
        let odd = json!({ "toolContext": { "native": ["bash"], "workspaces": [], "guardrails": [{ "id": "x" }] } });
        assert!(native_tools(&odd, &backend, "r", changes, &Cancel::default()).is_none());
    }
}
