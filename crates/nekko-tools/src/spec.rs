//! The tool definitions sent to the model, as `BUILTIN_TOOLS` in
//! `packages/core/src/agent/tools.ts` declares them (the ported subset).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// A tool as the model sees it: `ToolSpec` from `providers/types.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema for the input.
    pub parameters: Value,
}

/// The tools this crate executes, in `BUILTIN_TOOLS` order.
pub const PORTED_TOOLS: &[&str] = &["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "bash"];

/// Built-in tools that still run in the TS host: `browser` and `spawn_agent`
/// from `BUILTIN_TOOLS`, and the session-scoped extras (`ask_user`,
/// `update_plan`, `report_experiment`, `report_artifact`, `decide`).
pub const NOT_PORTED: &[&str] =
    &["browser", "spawn_agent", "ask_user", "update_plan", "report_experiment", "report_artifact", "decide"];

pub fn is_ported(name: &str) -> bool {
    PORTED_TOOLS.contains(&name)
}

fn spec(name: &str, description: &str, parameters: Value) -> ToolSpec {
    ToolSpec { name: name.into(), description: description.into(), parameters }
}

/// The specs for [`PORTED_TOOLS`], word for word.
pub fn builtin_tools() -> Vec<ToolSpec> {
    vec![
        spec(
            "read_file",
            "Read the contents of a file at an absolute or workspace-relative path.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Path to the file." } },
                "required": ["path"],
            }),
        ),
        spec(
            "write_file",
            "Create or overwrite a file with the given contents.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
                "required": ["path", "content"],
            }),
        ),
        spec(
            "edit_file",
            "Replace an exact string in a file with a new string.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_string": { "type": "string", "description": "Exact text to replace (must be unique)." },
                    "new_string": { "type": "string" },
                },
                "required": ["path", "old_string", "new_string"],
            }),
        ),
        spec(
            "glob",
            "Find files matching a glob pattern within the workspace.",
            json!({
                "type": "object",
                "properties": { "pattern": { "type": "string", "description": "e.g. src/**/*.ts" } },
                "required": ["pattern"],
            }),
        ),
        spec(
            "grep",
            "Search file contents with a regular expression.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string", "description": "Optional directory to scope the search." },
                },
                "required": ["pattern"],
            }),
        ),
        spec(
            "list_dir",
            "List the entries of a directory.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
            }),
        ),
        spec(
            "bash",
            "Run a shell command in the workspace. Subject to guardrails, risky commands require user approval.",
            json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "cwd": { "type": "string", "description": "Optional working directory." },
                },
                "required": ["command"],
            }),
        ),
    ]
}
