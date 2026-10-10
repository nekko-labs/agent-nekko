# Workflow Automations: Triggers, Integrations, Git Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the shipped-on-branch workflow engine into full automations: triggers that listen to the user's integrations (Slack, Linear, Jira, Teams, Discord, git hosts, generic webhooks), action steps that push results back out through those integrations, and a "use this machine as a CI runner" mode for GitHub/GitLab-style events that reports results back as commit statuses, saving hosted-runner credits.

**Architecture:** The workflow engine already shipped on main — `WorkflowTriggerKind` (`manual`/`schedule`/`cli`/`slack`/`git`), routed steps (`prompt`/`skill`/`workflow`/`shell`), and `dispatchWorkflowEvent` as the single door every external event enters through (reachable on the server edition as the generic `POST /api/:channel` `workflow:event` call). What's missing is everything that *produces* those events and *acts back*: no pollers exist for the slack/git triggers, there is no dedicated webhook endpoint with a per-trigger secret, no `action` step kind, and no commit-status reporting. This plan adds the *sources* (a poller per connector/git trigger + a first-class inbound webhook route) and the *sinks* (an `action` step kind whose `run` names a `<connector>.<op>` from a registry). The git-runner story is a template + two actions (`setCommitStatus`, `commentPR`) rather than a new subsystem.

**Tech Stack:** existing workflow engine (`packages/shared/src/workflows.ts`, `packages/host/src/workflows.ts`), connector framework (`packages/core/src/connectors/`), Fastify server route for webhooks. No new deps.

**Base state (verified 2026-09-08):** engine + `WorkflowsView` + the full-screen builder are all merged; the stale `feat/workflows` and `workflow-ux` branches are superseded by main and can be deleted. What remains is purely additive.

---

## Design decisions

- **Polling is the honest default trigger source.** A desktop app behind NAT can't receive real webhooks, so connector/git triggers poll the provider API on an interval with a per-trigger cursor (`lastSeen`), stored in `workflows.json`. The **server/Docker/Cloud editions additionally expose a real webhook endpoint** (`POST /api/hooks/:slug?key=<per-trigger secret>`) for providers that can reach it, and the desktop can opt into a loopback listener (127.0.0.1, off by default — per the existing bind-localhost constraint).
- **`action` step kind, not shell-out.** Integrations run through a typed registry so the step editor can offer real pickers (channel, issue, repo) instead of raw JSON. `run` = `slack.postMessage`, `linear.createIssue`, `linear.commentIssue`, `jira.commentIssue`, `jira.createIssue`, `github.commentPR`, `github.setCommitStatus`, `gitlab.setCommitStatus`, `discord.postMessage`, `teams.postMessage` (webhook), `webhook.post` (generic URL POST).
- **Templating.** Step fields interpolate `{{trigger.*}}`, `{{steps.<stepId>.output}}`, `{{run.status}}` via a tiny `renderTemplate` helper (no dep).
- **Git runner = trigger + template + status reporting, not the Actions runner protocol.** A "Local CI runner" template: git trigger on `push`/`pr_opened` → `shell` checkout/merge step → `shell` build/test step → `action` `github.setCommitStatus` (success/failure, context `agent-nekko/<wf>`) → on failure `github.commentPR` with the output tail. Being an actual GitHub Actions self-hosted runner (their proprietary agent protocol) is out of scope and should be documented as such.
- **Automations vs. the older scheduler.** `packages/host/src/tasks.ts` (scheduled/recurring/background tasks) stays as-is; the Command Center already merges both into the Automations section. New trigger kinds surface there with a source label.

## File structure

- Modify: `packages/shared/src/workflows.ts` — `WorkflowTriggerKind` += `'webhook' | 'connector'`; `WorkflowTrigger` += `webhookSecret?`, `connector?: ConnectorKind`, `event?: string`, `pollIntervalMs?`; `WorkflowStepKind` += `'action'`; `WorkflowStep` += `params?: Record<string, string>`; `WORKFLOW_ACTIONS` catalog types.
- Create: `packages/core/src/connectors/actions.ts` — `WORKFLOW_ACTIONS` registry: `{ op, connector, label, run(config, params, ctx) }` plus `renderTemplate`.
- Modify: `packages/core/src/connectors/index.ts` — `Connector` interface += optional `poll(token, settings, cursor): Promise<{events, nextCursor}>`; implement for slack/linear/jira/github/gitlab-ish (github/gitlab via REST search/events endpoints).
- Create: `packages/host/src/listeners.ts` — per-armed-trigger pollers on an interval; per-trigger cursor persisted beside `workflows.json`; each new event → `dispatchWorkflowEvent` with a normalized payload.
- Modify: `packages/host/src/workflows.ts` — execute `action` steps; webhook event shapes; template interpolation into step `run`/`with`/`params`.
- Modify: `apps/server/src/index.ts` — `POST /api/hooks/:slug` (per-trigger secret, 10 MB cap, rate-limit) → `dispatchWorkflowEvent('webhook', ...)`.
- Modify: `apps/desktop/src/renderer/components/WorkflowEditor.tsx` (on the workflows branches) — action-step editor (op picker + param fields), trigger editor gains webhook/connector kinds with poll-interval + "requires the server edition or a reachable URL" hints.
- Modify: `apps/desktop/src/renderer/views/WorkflowsView.tsx` — "Local CI runner" template card; trigger source shown on run rows.
- Create: `docs/git-runner.md` — setup recipes (poll mode anywhere; webhook mode on server/Docker; note on not being an Actions-runner protocol implementation).
- Tests: `actions.test.ts` (registry ops with mocked fetch + template rendering), `listeners.test.ts` (cursor advance, dedupe, dispatch-once), webhook route test (auth, size cap, dispatch).

## Tasks

### PR 9 — `feat/workflow-actions`

- [x] **T1: action step kind** — `WorkflowStepKind` += `'action'`; `params`; registry `WORKFLOW_ACTIONS` in `core/connectors/actions.ts` with the ops listed above; `renderTemplate` (`{{trigger.x}}`, `{{steps.y.output}}`, `{{run.*}}`); executor branch in `host/workflows.ts` (resolve connector config + token → `run` → `ToolResult`-shaped step output); `actions.test.ts`.
- [x] **T2: editor UI** — action step card in `WorkflowEditor`: op picker grouped by connector (disabled when that connector isn't connected, with a "connect it" link), param fields per op, template-hint text.

### PR 10 — `feat/workflow-triggers`

- [ ] **T3: connector triggers + pollers** — `TriggerKind` += `'connector'` (`{connector, event, filter, pollIntervalMs}`); `poll` on the Connector interface + impls for slack (`conversations.history` since cursor), linear (issues updated since), jira (JQL `updated >= cursor`), github/gitlab (events/issues endpoints); `host/listeners.ts` scheduler + cursor store + `dispatchWorkflowEvent` calls; dedupe by event id.
- [ ] **T4: webhook trigger** — `TriggerKind` += `'webhook'` with `webhookSecret`; server route `POST /api/hooks/:slug`; desktop opt-in loopback listener (off by default, `settings` flag); editor card explains reachability; route test.
- [ ] **T5: editor + Command Center surfacing** — trigger kinds in the editor with per-kind fields; run rows show the firing source ("Slack #eng 'deploy'", "GitHub PR #12 opened").

### PR 11 — `feat/git-runner`

- [x] **T6: status/comment actions** — `github.setCommitStatus`, `gitlab.setCommitStatus`, `github.commentPR`, `gitlab.commentMR` in the action registry.
- [x] **T7: Local CI runner template + docs** — template workflow (git trigger → checkout/merge → test → status → comment-on-fail) offered on the Workflows empty state and in the template gallery; `docs/git-runner.md` (poll vs webhook, security: per-trigger secrets, localhost default, "not an Actions-runner-protocol implementation" note); Command Center shows the runner badge on these runs.

## Self-review notes

- Spec coverage: automations-as-triggered-workflows (T3–T5), integrations inside workflows (T1–T2), git-host runner to save credits (T6–T7).
- Type consistency: `WorkflowTrigger.connector/event/pollIntervalMs` and `WorkflowStep.params` used identically across shared/host/UI tasks; `dispatchWorkflowEvent` remains the single entry point.
- Non-goals: real GitHub Actions runner protocol, Slack Socket Mode (v2), inbound webhooks on the desktop beyond opt-in loopback.
