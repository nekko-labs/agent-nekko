# Agent Nekko CLI and MCP

The CLI makes the Agent Nekko host a subagent for Devin, Claude Code, Codex,
Cursor, and other harnesses. It uses the same host engine as the desktop and
web editions.

## Install and target

Published package:

```bash
npm install --global agent-nekko
npx agent-nekko status
```

From a checkout:

```bash
npm install
npm run build --workspace=apps/cli
node apps/cli/dist/index.js status
```

Use `agent-nekko` after a global install or linking the built package, or invoke
the bundled binary from `apps/cli/dist/index.js`. Without `--url`, the CLI runs
an in-process host
against `~/.nekko` (override with `NEKKO_DATA_DIR`). To drive a web edition,
use:

```bash
agent-nekko --url http://127.0.0.1:1440 --token "$NEKKO_TOKEN" status --json
```

`--url` can also be supplied as `NEKKO_URL`; `--token` can be supplied as
`NEKKO_TOKEN`.

## Safety and approval

Chat defaults to `--approve guardrails` (or `NEKKO_APPROVE=guardrails`).
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
skills install ID [--target agent-nekko|claude|codex] [--json]
tools [--json]
models [PROVIDER_ID] [--json]
train start NAME GOAL [--provider ID] [--model ID] [--workspace ID] [--json]
train status|hint ID TEXT|stop ID [--json]
watch [--session ID] [--json]
mcp
```

Prompts may be positional, piped through stdin (`agent-nekko chat -`), or loaded
from a file (`agent-nekko chat --file prompt.md`). `--quiet` suppresses human
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
claude mcp add agent-nekko -- node /abs/path/agent-nekko/apps/cli/dist/index.js mcp
```

Codex:

```bash
codex mcp add agent-nekko -- node /abs/path/agent-nekko/apps/cli/dist/index.js mcp
```

Cursor and generic `mcpServers` configuration:

```json
{
  "mcpServers": {
    "agent-nekko": {
      "command": "node",
      "args": ["/abs/path/agent-nekko/apps/cli/dist/index.js", "mcp"]
    }
  }
}
```

`agent-nekko_chat` accepts the same `approve` policy as the CLI and defaults to
`guardrails`. `agent-nekko_train_start` also accepts an explicit `approve` argument;
unattended training that intentionally permits ask-rules must pass
`"approve": "yolo"`. The server negotiates MCP protocol versions, echoing a
supported client version and otherwise selecting its newest supported version.
`agent-nekko_task_create` exposes `title`, `prompt`, `kind`, `runAt`, `intervalMs`,
`workspaceId`, `providerId`, `modelId`, `condition`, and `keepAlive` directly;
`title`, `prompt`, and `kind` are required. A `agent-nekko_chat` result presents
the assistant reply first, followed by a metadata block containing session,
tool-call, blocked-entry, duration, and usage details.

The MCP tool list mirrors the CLI coverage: `agent-nekko_chat`,
`agent-nekko_list_sessions`, `agent-nekko_new_session`, `agent-nekko_get_session`,
`agent-nekko_workspace_list`, `agent-nekko_workspace_add`, `agent-nekko_workspace_remove`,
`agent-nekko_workspace_index`, `agent-nekko_workspace_search`,
`agent-nekko_prompts_list`, `agent-nekko_tasks_list`, `agent-nekko_task_create`,
`agent-nekko_task_run`, `agent-nekko_task_delete`, `agent-nekko_skills_list`,
`agent-nekko_skill_install`, `agent-nekko_tools_list`, `agent-nekko_models_list`,
`agent-nekko_train_start`, `agent-nekko_train_status`, `agent-nekko_train_hint`,
`agent-nekko_train_stop`, and `agent-nekko_status`.

## Recipes

### Drive a repeated workflow

```bash
agent-nekko tasks add --title "daily review" --kind recurring \
  --interval-ms 86400000 --prompt "Review the current workspace diff and summarize risks" \
  --workspace "$WORKSPACE_ID" --provider "$PROVIDER" --model "$MODEL" --json
agent-nekko tasks list --json
agent-nekko tasks run TASK_ID --json
```

### Fan out several sessions

```bash
agent-nekko chat "Review security" --new --workspace "$W" --json > security.json &
agent-nekko chat "Review tests" --new --workspace "$W" --json > tests.json &
agent-nekko chat "Review API design" --new --workspace "$W" --json > api.json &
wait
```

### Hand off training and poll it

```bash
agent-nekko train start "ranking-v1" "Improve ranking accuracy" \
  --workspace "$W" --provider "$PROVIDER" --model "$MODEL" --json
agent-nekko train status --json
agent-nekko train hint RUN_ID "Try a larger validation split" --json
agent-nekko train stop RUN_ID --json
```
