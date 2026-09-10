# Agent Nekko CLI + MCP server (`agent-nekko`)

Drive your local Agent Nekko agent from the terminal, or expose it to other tools
(Claude Code, Codex, any MCP client) so they can trigger agents, make chat
requests, spin up sessions, and read status. Runs the same engine (`createHost`)
in-process against your data dir.

Current published installation:

```bash
npm install -g kotrain
kotrain status
```

This rebrand source adds `agent-nekko` as the canonical executable, retaining
`kotrain` and `nekkos` as aliases with the same commands and options. The
packed source has been verified, but npm still serves 0.6.0 as of 2026-09-07;
that older published version does not include the new executable. After a
release containing this change, `agent-nekko status` will work from the same
package. Existing `npx agent-nekko` usage continues to work. A separately named
`agent-nekko` npm package is not yet published.

From a checkout:

```bash
npm run build --workspace=apps/cli
node apps/cli/dist/index.js status        # or: npm link, then `kotrain status`
```

### Where it connects

- **Local (default)**: runs the engine in-process against a data dir: `~/.kotrain`
  (shared with the web/Docker edition). Set `KOTRAIN_DATA_DIR` to the desktop app's
  dir to share that instead (`%APPDATA%/Kotrain/kotrain` on Windows,
  `~/Library/Application Support/Kotrain/kotrain` on macOS).
- **Remote**: pass `--url http://host:1440` (or `KOTRAIN_URL`) to talk to a
  **running** Agent Nekko (formerly Kotrain) server over HTTP+WS, your live instance, a Docker
  container, or another machine. Add `--token` (or `KOTRAIN_TOKEN`) if it's secured.

Add `--json` to `status`/`sessions` for machine-readable output.

## CLI

```bash
agent-nekko status                          # providers, model, workspaces, sessions, relay
agent-nekko sessions                        # list chats
agent-nekko chat "summarize README.md" \    # run an agent turn (streams the reply)
  --workspace <id> --new
agent-nekko chat "and now add tests" --session <id>
```

`chat` defaults to guardrails approval. Use `--approve yolo` only when you
explicitly want unattended tool approval.

## MCP server

```bash
agent-nekko mcp        # JSON-RPC 2.0 over stdio
```

Register it in **Claude Code**:

```bash
claude mcp add agent-nekko -- agent-nekko mcp
# (or once published/linked: claude mcp add kotrain -- kotrain mcp)
```

Or in any MCP client config:

```json
{ "mcpServers": { "agent-nekko": { "command": "agent-nekko", "args": ["mcp"] } } }
```

### Tools exposed

Discovery lists canonical `agent-nekko_*` names only. Existing MCP configurations
using the `kotrain` executable and calls to the corresponding `kotrain_*` tool
names remain supported, with the same arguments and results. Environment
variables, data directories, `kotrain/run` imports, and the `kotrain` skill
installation target are unchanged.

| Tool | What |
| --- | --- |
| `agent-nekko_chat` | Run an agent turn (reads/edits/runs in your workspace); returns the reply. Omit `sessionId` to start fresh. |
| `agent-nekko_list_sessions` | List sessions. |
| `agent-nekko_new_session` | Create a session, returns its id. |
| `agent-nekko_get_session` | Get a transcript. |
| `agent-nekko_status` | Providers, default model, workspaces, session count, relay status. |
| `agent-nekko_train_start` | Start a **training run**: a local data-scientist agent benchmarks candidates, fine-tunes, evaluates, and reports experiments with scores. |
| `agent-nekko_train_status` | Experiment tree + leader for one run (or a summary of all runs). |
| `agent-nekko_train_hint` | Queue guidance the agent folds into its next experiments. |
| `agent-nekko_train_stop` | Stop a run. |

So an MCP client can say "train me a model for X": start a run whose goal is
to benchmark existing models for X (reported as scored experiments, i.e. the
recommendation step) and then fine-tune to beat the best of them.

**Swarms**: call `agent-nekko_new_session` a few times and fan out `agent-nekko_chat`
across the session ids, each is an independent agent driving your local model.
