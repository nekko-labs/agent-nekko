# Kotrain CLI and MCP

The CLI makes the Kotrain host a subagent for Devin, Claude Code, Codex,
Cursor, and other harnesses. It uses the same host engine as the desktop and
web editions.

## Install and target

Published package:

```bash
npm install --global kotrain
npx agent-nekko status
```

From a checkout:

```bash
npm install
npm run build --workspace=apps/cli
node apps/cli/dist/index.js status
```

Use `kotrain` after a global install or linking the built package, or invoke
the bundled binary from `apps/cli/dist/index.js`. Without `--url`, the CLI runs
an in-process host
against `~/.kotrain` (override with `KOTRAIN_DATA_DIR`). To drive a web edition,
use:

```bash
kotrain --url http://127.0.0.1:1440 --token "$KOTRAIN_TOKEN" status --json
```

`--url` can also be supplied as `KOTRAIN_URL`; `--token` can be supplied as
`KOTRAIN_TOKEN`.

## Safety and approval

Chat defaults to `--approve guardrails` (or `KOTRAIN_APPROVE=guardrails`).
Guardrails mode sets the session to `guardrails`: ordinary tools run, ask-rule
approvals are refused and reported as structured `blocked` entries, and the
turn continues. The result tells the harness to use `--approve yolo` when an
override is intentional.

`--approve yolo` explicitly opts into the previous unattended behavior. Deny
rules remain a hard floor in every mode. `--approve ask` prompts on the TTY;
it is an error when stdin is not a TTY.

These policies govern the agent tool loop, not every process the host can
launch. In particular, `bash` is not confined by `workspace-jail`; use the
host's deployment and workspace controls when granting an external harness
access.

## Commands

```text
status [--json]
sessions [--json]
chat "<prompt>" [--session ID] [--new] [--workspace ID] [--provider ID] [--model ID]
  [--approve guardrails|yolo|ask] [--json|--stream ndjson] [--timeout SECONDS] [--quiet]
workspace list|add PATH|remove ID|index ID|search ID QUERY [--json]
prompts [--json]
tasks list|add|run ID|delete ID [--json]
skills [--json]
skills install ID [--target kotrain|claude|codex] [--json]
tools [--json]
models [PROVIDER_ID] [--json]
train start NAME GOAL [--provider ID] [--model ID] [--workspace ID] [--json]
train status|hint ID TEXT|stop ID [--json]
watch [--session ID] [--json]
mcp
```

Prompts may be positional, piped through stdin (`kotrain chat -`), or loaded
from a file (`kotrain chat --file prompt.md`). `--quiet` suppresses human
progress on stderr.

## Machine output

`--json` emits exactly one JSON object on stdout. Chat objects have this shape:

```json
{
  "sessionId": "…",
  "provider": "…",
  "model": "…",
  "text": "…",
  "toolCalls": [{ "name": "read_file", "input": { "path": "README.md" } }],
  "blocked": [{ "ruleLabels": ["…"], "command": "…", "severity": "high", "reason": "…" }],
  "durationMs": 1234,
  "usage": { "inputTokens": 100, "outputTokens": 40 }
}
```

`--stream ndjson` emits one typed event per line:

```json
{"type":"text","delta":"Hello"}
{"type":"tool_call","call":{"name":"read_file","input":{"path":"README.md"}}}
{"type":"tool_result","toolCallId":"…","ok":true,"output":"…"}
{"type":"blocked","ruleLabels":["ask"],"command":"…","severity":"high","reason":"…"}
{"type":"done"}
```

Progress and diagnostics go to stderr. Other commands accept `--json`;
`watch --json` emits the same typed event objects as NDJSON and exits cleanly
when it receives Ctrl-C. Watch events are `text`, `tool_call`, `tool_result`,
`blocked`, `done`, and `error`; reasoning and usage-only events are omitted.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 2 | Usage or invalid flags |
| 3 | Nothing configured (provider/model missing) |
| 4 | Guardrail-blocked tool call |
| 5 | Provider/model failure |
| 6 | Chat timeout |
| 7 | Cannot reach or unauthorized against `--url` |

## MCP

Start the JSON-RPC stdio server:

```bash
node apps/cli/dist/index.js mcp
```

Claude Code:

```bash
claude mcp add kotrain -- node /abs/path/kotrain/apps/cli/dist/index.js mcp
```

Codex:

```bash
codex mcp add kotrain -- node /abs/path/kotrain/apps/cli/dist/index.js mcp
```

Cursor and generic `mcpServers` configuration:

```json
{
  "mcpServers": {
    "kotrain": {
      "command": "node",
      "args": ["/abs/path/kotrain/apps/cli/dist/index.js", "mcp"]
    }
  }
}
```

`kotrain_chat` accepts the same `approve` policy as the CLI and defaults to
`guardrails`. `kotrain_train_start` also accepts an explicit `approve` argument;
unattended training that intentionally permits ask-rules must pass
`"approve": "yolo"`. The server negotiates MCP protocol versions, echoing a
supported client version and otherwise selecting its newest supported version.
`kotrain_task_create` exposes `title`, `prompt`, `kind`, `runAt`, `intervalMs`,
`workspaceId`, `providerId`, `modelId`, `condition`, and `keepAlive` directly;
`title`, `prompt`, and `kind` are required. A `kotrain_chat` result presents
the assistant reply first, followed by a metadata block containing session,
tool-call, blocked-entry, duration, and usage details.

The MCP tool list mirrors the CLI coverage: `kotrain_chat`,
`kotrain_list_sessions`, `kotrain_new_session`, `kotrain_get_session`,
`kotrain_workspace_list`, `kotrain_workspace_add`, `kotrain_workspace_remove`,
`kotrain_workspace_index`, `kotrain_workspace_search`,
`kotrain_prompts_list`, `kotrain_tasks_list`, `kotrain_task_create`,
`kotrain_task_run`, `kotrain_task_delete`, `kotrain_skills_list`,
`kotrain_skill_install`, `kotrain_tools_list`, `kotrain_models_list`,
`kotrain_train_start`, `kotrain_train_status`, `kotrain_train_hint`,
`kotrain_train_stop`, and `kotrain_status`.

## Recipes

### Drive a repeated workflow

```bash
kotrain tasks add --title "daily review" --kind recurring \
  --interval-ms 86400000 --prompt "Review the current workspace diff and summarize risks" \
  --workspace "$WORKSPACE_ID" --provider "$PROVIDER" --model "$MODEL" --json
kotrain tasks list --json
kotrain tasks run TASK_ID --json
```

### Fan out several sessions

```bash
kotrain chat "Review security" --new --workspace "$W" --json > security.json &
kotrain chat "Review tests" --new --workspace "$W" --json > tests.json &
kotrain chat "Review API design" --new --workspace "$W" --json > api.json &
wait
```

### Hand off training and poll it

```bash
kotrain train start "ranking-v1" "Improve ranking accuracy" \
  --workspace "$W" --provider "$PROVIDER" --model "$MODEL" --json
kotrain train status --json
kotrain train hint RUN_ID "Try a larger validation split" --json
kotrain train stop RUN_ID --json
```
