//! Path resolution and the workspace jail (`resolvePath`, `assertInJail`,
//! `asksEverything` in `packages/host/src/tools.ts`).
//!
//! The jail is a string check on resolved paths, not on the filesystem: a
//! target is inside a root when `relative(root, target)` is empty, or neither
//! starts with `..` nor is absolute. That rule has a quirk kept on purpose:
//! a child literally named `..foo` reads as outside. It also does not follow
//! links, which is a known limit of the TS sandbox and stays one here.

use crate::context::{ChatMode, SandboxMode, ToolContext};
use crate::js;
use crate::path::{self, native};
use serde_json::Value;

/// Whether a mutating tool needs an up-front confirm in this mode.
pub fn asks_everything(ctx: &ToolContext) -> bool {
    ctx.mode == ChatMode::Ask || ctx.sandbox_mode == SandboxMode::AskEverything
}

/// The first workspace's path, as settings hold it (not resolved).
pub fn first_workspace(ctx: &ToolContext) -> Option<&str> {
    ctx.workspaces.first().map(|w| w.path.as_str())
}

pub fn process_cwd() -> String {
    path::process_cwd()
}

/// `resolvePath(p)`: absolute paths are normalized, relative ones resolve
/// against the chat's directory, else the first workspace, else the process's.
pub fn resolve_path(p: Option<&Value>, ctx: &ToolContext) -> Result<String, String> {
    let Some(Value::String(p)) = p else { return Err(js::invalid_string_arg("path", p)) };
    let base = ctx.default_cwd.clone().or_else(|| first_workspace(ctx).map(str::to_string)).unwrap_or_else(process_cwd);
    Ok(if native::is_absolute(p) { native::resolve(&[p]) } else { native::resolve(&[&base, p]) })
}

/// `assertInJail(target)`.
pub fn assert_in_jail(target: &str, ctx: &ToolContext) -> Result<(), String> {
    if ctx.sandbox_mode != SandboxMode::WorkspaceJail {
        return Ok(());
    }
    let roots: Vec<String> = ctx.workspaces.iter().map(|w| native::resolve(&[&w.path])).collect();
    // Nothing to jail against yet.
    if roots.is_empty() {
        return Ok(());
    }
    let inside = roots.iter().any(|root| {
        let rel = native::relative(root, target);
        rel.is_empty() || (!rel.starts_with("..") && !native::is_absolute(&rel))
    });
    if inside {
        Ok(())
    } else {
        Err(format!(
            "Sandbox: {target} is outside the workspace folders. Add the folder or switch sandbox mode in Settings."
        ))
    }
}
