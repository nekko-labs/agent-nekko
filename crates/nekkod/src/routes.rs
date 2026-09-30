//! Channel routing: the strangler table.
//!
//! A channel listed here is served by the daemon; any other is forwarded to
//! the TS backend unchanged. Porting a service means adding its channels here
//! and deleting the TS implementation, with no change to any client.

use crate::backend::Backend;
use crate::hub::Hub;
use nekko_term::{CreateSpec, Registry, RegistryEvent, UpdatePatch, detect_shells, resolve_shell};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
pub struct Ctx {
    pub terminals: Arc<Registry>,
    pub backend: Arc<Backend>,
    pub hub: Hub,
    pub engine: Arc<crate::engine::Engine>,
    /// Session reads (`nekko-store`), when the data directory is known.
    pub sessions: Option<Arc<nekko_store::SessionStore>>,
}

/// Terminals whose ids start with this are the TS host's read-only agent
/// command logs; everything else is a daemon pty.
const AGENT_PREFIX: &str = "agent_";

/// How long a daemon-served call waits on the backend for supporting data
/// (settings, the agent logs) before carrying on without it.
const AUX_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

fn str_arg(args: &[Value], i: usize) -> Option<&str> {
    arg(args, i).as_str()
}

fn is_agent(id: &str) -> bool {
    id.starts_with(AGENT_PREFIX)
}

pub async fn route(ctx: &Ctx, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    match channel {
        "daemon:info" => Ok(json!({
            "app": "nekkod",
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "backend": match ctx.backend.state() {
                crate::backend::State::Disabled => "disabled",
                crate::backend::State::Starting => "starting",
                crate::backend::State::Ready { .. } => "ready",
                crate::backend::State::Down { .. } => "down",
            },
            "owned": OWNED,
        })),
        "terminals:list" => {
            let mut all = serde_json::to_value(ctx.terminals.list()).unwrap_or(json!([]));
            // The agent command logs still live in the TS host.
            // A starting backend must not hold the terminal list hostage.
            let agent = tokio::time::timeout(AUX_WAIT, ctx.backend.call("terminals:list:agent", json!([]))).await;
            if let Ok(Ok(Value::Array(agent))) = agent
                && let Value::Array(list) = &mut all
            {
                list.extend(agent);
            }
            Ok(all)
        }
        "terminals:list:native" => Ok(serde_json::to_value(ctx.terminals.list()).unwrap_or(json!([]))),
        "terminal:shells" => Ok(serde_json::to_value(detect_shells()).unwrap_or(json!([]))),
        "terminal:create" => create_terminal(ctx, arg(&args, 0)).await,
        "terminal:snapshot" | "terminal:update" | "terminal:write" | "terminal:resize" | "terminal:run"
        | "terminal:signal" | "terminal:close" => {
            let id = str_arg(&args, 0).unwrap_or_default().to_string();
            if is_agent(&id) {
                return ctx.backend.call(channel, Value::Array(args)).await;
            }
            terminal_op(ctx, channel, &id, &args)
        }
        "sessions:summaries" | "sessions:list" | "session:get" | "session:images" if ctx.sessions.is_some() => {
            session_read(ctx.sessions.clone().expect("checked"), channel, args).await
        }
        _ => {
            if let Some(r) = crate::engine::route(&ctx.engine, channel, &args).await {
                return r;
            }
            ctx.backend.call(channel, Value::Array(args)).await
        }
    }
}

/// Channels the daemon serves itself (reported by `daemon:info`).
pub const OWNED: &[&str] = &[
    "daemon:info",
    "sessions:summaries",
    "sessions:list",
    "session:get",
    "session:images",
    "terminals:list",
    "terminals:list:native",
    "terminal:shells",
    "terminal:create",
    "terminal:snapshot",
    "terminal:update",
    "terminal:write",
    "terminal:resize",
    "terminal:run",
    "terminal:signal",
    "terminal:close",
    "infer:serve",
    "infer:stopServing",
    "infer:serving",
    "infer:spawn",
    "infer:kill",
    "infer:list",
    "infer:log",
    "decide:load",
    "decide:unload",
    "decide:status",
    "decide:run",
];

fn terminal_op(ctx: &Ctx, channel: &str, id: &str, args: &[Value]) -> Result<Value, String> {
    let reg = &ctx.terminals;
    match channel {
        "terminal:snapshot" => Ok(match reg.snapshot(id) {
            Some(s) => json!({
                "info": s.info,
                "buffer": String::from_utf8_lossy(&s.buffer),
                "cols": s.cols,
                "rows": s.rows,
            }),
            None => Value::Null,
        }),
        "terminal:update" => {
            let patch = arg(args, 1);
            reg.update(
                id,
                UpdatePatch {
                    workspace_id: patch.get("workspaceId").map(|v| v.as_str().map(str::to_string)),
                    order: patch.get("order").and_then(Value::as_f64),
                    title: patch.get("title").and_then(Value::as_str).map(str::to_string),
                },
            );
            Ok(Value::Null)
        }
        "terminal:write" => {
            if let Some(data) = str_arg(args, 1) {
                reg.write(id, data.as_bytes());
            }
            Ok(Value::Null)
        }
        "terminal:resize" => {
            let cols = arg(args, 1).as_u64().unwrap_or(80).min(u16::MAX as u64) as u16;
            let rows = arg(args, 2).as_u64().unwrap_or(24).min(u16::MAX as u64) as u16;
            reg.resize(id, cols, rows);
            Ok(Value::Null)
        }
        "terminal:run" => {
            if let Some(cmd) = str_arg(args, 1) {
                reg.run(id, cmd);
            }
            Ok(Value::Null)
        }
        "terminal:signal" => {
            reg.interrupt(id);
            Ok(Value::Null)
        }
        "terminal:close" => {
            reg.close(id);
            Ok(Value::Null)
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

/// Where a new terminal starts: the explicit directory, else the project's,
/// else the first project's, else home. Needs the user's settings, which the
/// TS host still owns.
fn resolve_cwd(settings: &Value, workspace_id: Option<&str>, cwd: Option<&str>) -> PathBuf {
    if let Some(c) = cwd.filter(|c| Path::new(c).is_dir()) {
        return c.into();
    }
    let workspaces = settings.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default();
    let path_of = |w: &Value| w.get("path").and_then(Value::as_str).map(str::to_string);
    if let Some(id) = workspace_id
        && let Some(p) = workspaces
            .iter()
            .find(|w| w.get("id").and_then(Value::as_str) == Some(id))
            .and_then(path_of)
            .filter(|p| Path::new(p).is_dir())
    {
        return p.into();
    }
    if let Some(p) = workspaces.first().and_then(path_of).filter(|p| Path::new(p).is_dir()) {
        return p.into();
    }
    home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

async fn create_terminal(ctx: &Ctx, opts: &Value) -> Result<Value, String> {
    let settings = match tokio::time::timeout(AUX_WAIT, ctx.backend.call("settings:get", json!([]))).await {
        Ok(Ok(v)) => v,
        _ => Value::Null,
    };
    let s = |k: &str| opts.get(k).and_then(Value::as_str);
    let dim = |k: &str, d: u16| opts.get(k).and_then(Value::as_u64).map(|n| n.clamp(1, 1000) as u16).unwrap_or(d);
    let shell = resolve_shell(s("shell"), settings.get("defaultShellPath").and_then(Value::as_str));
    let spec = CreateSpec {
        title: s("title").map(str::to_string),
        workspace_id: s("workspaceId").map(str::to_string),
        cwd: resolve_cwd(&settings, s("workspaceId"), s("cwd")),
        shell,
        cols: dim("cols", 80),
        rows: dim("rows", 24),
        env: Vec::new(),
    };
    Ok(serde_json::to_value(ctx.terminals.create(spec)).unwrap_or(Value::Null))
}

/// Mirror the registry's events onto the JSON bus as `terminal:event`.
pub fn forward_terminal_events(ctx: &Ctx) {
    let mut rx = ctx.terminals.events();
    let hub = ctx.hub.clone();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(RegistryEvent::Data { id, text }) => {
                    hub.publish("terminal:event", json!({ "type": "data", "terminalId": id, "data": text }), true)
                }
                Ok(RegistryEvent::Exit { id, code }) => {
                    hub.publish("terminal:event", json!({ "type": "exit", "terminalId": id, "code": code }), false)
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}

/// The session reads, off the async threads: a listing reads every changed
/// chat file, and one image chat can be tens of megabytes.
async fn session_read(store: Arc<nekko_store::SessionStore>, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    let channel = channel.to_string();
    tokio::task::spawn_blocking(move || match channel.as_str() {
        "sessions:summaries" => Value::Array(store.summaries()),
        "sessions:list" => Value::Array(store.list()),
        "session:get" => str_arg(&args, 0).and_then(|id| store.get(id)).unwrap_or(Value::Null),
        _ => Value::Array(store.images(str_arg(&args, 0).unwrap_or_default(), arg(&args, 1).as_f64().unwrap_or(1.0))),
    })
    .await
    .map_err(|e| format!("session read failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_prefers_the_explicit_directory_then_the_project() {
        let tmp = std::env::temp_dir();
        let t = tmp.to_string_lossy().to_string();
        let settings = json!({ "workspaces": [{ "id": "w1", "path": t }] });
        assert_eq!(resolve_cwd(&settings, None, Some(&t)), tmp);
        assert_eq!(resolve_cwd(&settings, Some("w1"), Some("/no/such/dir")), tmp);
        assert_eq!(resolve_cwd(&settings, Some("missing"), None), tmp);
    }

    #[test]
    fn agent_logs_are_recognised() {
        assert!(is_agent("agent_s1"));
        assert!(!is_agent("term_abc_1"));
    }
}
