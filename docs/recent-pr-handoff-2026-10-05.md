# Recent PR handoff — 2026-10-05

This is a dated technical handoff, not a live status dashboard. Recheck GitHub heads/checks and read AGENTS.md before resuming. Historical task checks below are not a claim that all merged UI received desktop evidence.

## Recently merged work

## PR #304


## Changes and context
The checkout-baseline notice moved from a permanent composer block to a popup beside WorktreeChip. It auto-opens once per chat per device, persists the claim in localStorage with an in-memory fallback, and remains available by hover/focus/click. Escape, outside click and the close control dismiss it. Command Center composers use 98% of their pane width; Agent view sizing is unchanged.

## Verification
Recorded task verification: four worktree-chip tests and 371 desktop tests passed. At that point seven bundle tests and typecheck were blocked by missing electron-vite/build outputs.

## Unfinished work / release blockers
Matching desktop screenshots and dismissal/hover recording were not completed in the accessible task record. Validate narrow panes, focus and storage-disabled fallback.

### Source limits
Reconstructed from merged code and available task records after merge. Missing evidence is not retroactively claimed as verified.

## PR #308


## Changes and context
Added the App verification guidance to both TypeScript and Rust default prompts. Prefer the cheapest sufficient headless check; identify app ownership/version before testing; protect user-owned sessions; isolate new sandboxes and external effects; require actual desktop evidence for desktop-specific claims. Updated prompt regression coverage and Rust golden output.

## Verification
Recorded handoff reports CI completed without failures. This retrospective edit did not rerun Rust or the full suite.

## Unfinished work / release blockers
No visual change. Continue honoring the policy; headless success is not desktop visual proof.

### Source limits
Reconstructed from merged code and available task records after merge. Missing evidence is not retroactively claimed as verified.

## PR #312


## Changes and context
Separated actual API spend from estimated subscription/local API costs avoided, with aggregate and per-session accounting. Local models use known hosted prices or a configurable cloud benchmark; unknown pricing is excluded and surfaced. Subscription fees, hardware and electricity are not tracked: this is not net savings. Also removed automatic approval focus stealing, fixed links nested in emphasis, added safe link context actions, made synthetic restart notices subtle info cards, retained completed delegates in the prompt rail, excluded delegates from automatic window insertion, ordered new windows in the chat area, and renamed Commands to Log.

## Verification
Recorded task checks include shared/core builds, focused usage/approval tests, 27 then 28 Markdown tests, seven recovery/interruption tests and 22 wall-layout tests. A later isolated desktop production build passed. Earlier desktop typecheck excluded a missing electron-vite test dependency. Do not treat these separate batches as a clean final full-suite result.

## Unfinished work / release blockers
Desktop verification of cost display, approval focus, link actions, recovery card, delegate click-to-open and window placement remains unconfirmed in the accessible record. Required screenshots/recordings are missing. A separate model-effort investigation was not fixed: inspect native effort handling for Opus 4.5/4.6 and Sonnet 4.6 in shared capabilities, TS Anthropic provider and Rust Claude adapter.

### Source limits
Reconstructed from merged code and available task records after merge. Missing evidence is not retroactively claimed as verified.

## PR #316


## Changes and context
Diagnosed dozens of gh pr view processes launched by the desktop backend, including repeated historical PR reads. Added a shared one-minute cache, single-flight reads, and a serial background gh read queue across sessions/branches. Primary quota errors pause reads for one hour; secondary limits for one minute. Cached branch state is preserved during cooldown.

## Verification
Core builds, host typecheck, four focused cache/queue/cooldown tests and diff checks passed. After rebuild, an approximately 100-second read-only process observation detected zero background gh children. That quiet period is consistent with cooldown, not proof of healthy resumed polling.

## Unfinished work / release blockers
No visual change. Verify normal serialized polling after cooldown/reset. Direct GraphQL reported exhausted quota while REST rate_limit reported capacity; discrepancy remains unexplained. Fixed cooldowns are conservative and not reset-header-derived. Arbitrary shell commands, other processes and all REST reads are outside this queue.

### Source limits
Reconstructed from merged code and available task records after merge. Missing evidence is not retroactively claimed as verified.

## PR #318


## Changes and context
Root npm run dev now runs the existing full npm run build before starting the desktop development server. Failed build prevents launch. Full build includes daemon staging plus shared/core/host/CLI/desktop preparation, trading startup time for avoiding stale backend/declaration output.

## Verification
Both scripts/build-commands.test.mjs tests and diff check passed. After merge the primary checkout was fast-forwarded and both script tests rerun successfully.

## Unfinished work / release blockers
No visual change. Full build/dev startup was not executed for this script-only check. Normal development now needs the full build prerequisites, including daemon toolchain/staging.

### Source limits
Reconstructed from merged code and available task records after merge. Missing evidence is not retroactively claimed as verified.

## PR #319


## Changes and context
Added today, 1wk, 1m, 6m, 1y and all-time toggles to Insights cost/token charts. insightDays uses inclusive UTC day keys, excludes future entries, and defines month/half-year/year as rolling 30/180/365-day windows. Added eight time-range tests.

## Verification
Accessible task record reports shared build, desktop typecheck, all eight range tests and diff checks passed after dependencies were restored.

## Unfinished work / release blockers
Matching desktop screenshots were not captured: sandbox browser attachment/window capture failed. Verify chart totals and labels across ranges, empty data, both themes and narrow layouts. See #321: its later merge has no additional file delta.

### Source limits
Reconstructed from merged code and available task records after merge. Missing evidence is not retroactively claimed as verified.

## PR #320


## Changes and context
A completed turn stopped streaming before its persisted transcript loaded; interruption detection could inspect a stale tool-call record and leave Reply interrupted visible. Gate persisted interruption inference while the held completed reply awaits reconciliation. Genuine interrupted transcripts still show recovery actions.

## Verification
Seven focused interruption tests, desktop typecheck, shared/core/host builds and diff checks passed in isolated dependencies. The optional RecoveryNotice test path was absent on that base and did not run.

## Unfinished work / release blockers
Actual desktop completion/animation verification and before/after evidence remain pending. Confirm genuine stop/failure/restart recovery still works. #306 contains additional active-run gating and stale-notice clearing; preserve both on integration.

### Source limits
Reconstructed from merged code and available task records after merge. Missing evidence is not retroactively claimed as verified.

## PR #321


## Changes and context
This PR used the same chart-range branch as #319. Merge commit df7d32a has no file delta relative to its first parent: the feature had already landed through #319. Do not count this as a second implementation. The existing feature offers today/1wk/1m/6m/1y/all-time rolling UTC ranges.

## Verification
Accessible follow-up task reports restored isolated dependencies, desktop typecheck, shared build, eight range tests and diff checks passing. These are historical task checks, not new verification from the empty merge.

## Unfinished work / release blockers
Desktop before/after evidence remains missing. Browser attachment and window capture could not verify the sandbox; it was stopped. Continue the visual/chart verification listed in #319.

### Source limits
Reconstructed from merged code and available task records after merge. Missing evidence is not retroactively claimed as verified.

## Additional merged context

- #309: million-token labels plus signed GitHub App review/approval webhook. Read docs/github-app-review.md before deployment. App credentials/public ingress and live integration validation are separate; auto-approval should start disabled. Context-gauge desktop evidence remains pending.
- #317: exact delegation model discovery, structured errors, user-selected defaults and Agents navigation. 75 routing tests and isolated typechecks/builds were recorded; settings/navigation visual evidence remains pending. Never add silent provider/model fallback.
- #322: compact pixel thinking head, solid palette slices and static autumn merged-PR decoration. 34 focused tests and desktop typecheck/build prerequisites recorded; desktop captures/recording remain pending. Overlaps #310 mascot work.

- #323: merged as 46f7243 during the audit. Effort slider uses a static filled-side glow scaling by rung and max-rung speed lines. PR contains static-harness screenshots/recordings, not desktop-window proof; recorded typecheck had an unrelated missing electron-vite limitation.

## Open work at audit time

- #306: head 3044dc6. New composer-connected PR deck and current-chat-only PR attribution were added by another task. Existing local resolution f61204b was based on older f3ca44b and must not overwrite newer commits. Reconcile current head against current main, test pinned panes/chat placement/recovery and PR attribution/deck behavior, then capture desktop screenshots and animation. Resource queue remains experimental: individual identity, protected secret storage, lease recovery, result verification and GitHub ingestion are not complete; do not deploy publicly.
- #307: head 58a1d22. Conflict resolution preserves scoped approvals without focus stealing, sidebar reachability and both prompt requirements. Desktop typecheck, 25 focused desktop tests and four prompt tests pass locally. Current CI build fails in context.golden.test.ts after prompt guidance changes; update golden output only after checking intended TS/Rust parity. Android failed; inspect job logs rather than assume code failure. Voice blockers remain: managed macOS runtime, Linux execution, installer/lifecycle coverage, microphone/permission testing, runtime dependency license audit, low-end benchmarks and model-server UI integration. Read the full PR blocker section.
- #310: head 57a4484. Markdown conflict resolved retaining Mermaid artifact rendering and context actions. Desktop typecheck and 41 Markdown/mascot tests pass locally. CI build still fails; another task identified window is not defined in artifact-preview tests. Inspect the failing log and establish a minimal test environment without hiding production assumptions. Mobile checks were still pending at audit time. Required desktop/marketing/mobile evidence and animation recordings remain missing; preserve #322 compact-head changes.

## Resume checklist

1. Fetch and inspect open PRs/remote heads; concurrent tasks have changed branches during this work. Use exact expected-head leases for original-branch pushes. Never overwrite user-owned worktrees.
2. Fix failing CI and run targeted checks with isolated dependencies/artifacts. Recheck main after each merge; later PRs can conflict again.
3. Obtain actual matching desktop visual evidence where required; document unsupported platforms and incomplete features explicitly. Do not convert missing evidence into verified claims.
4. Keep PR descriptions and this handoff current; record evidence URLs on shared pr-media release, not in git.
5. For GitHub quota follow-up, verify normal polling after cooldown—not only a quiet exhausted period. Direct GraphQL/REST reports previously disagreed; do not assume REST capacity means GraphQL recovered.

## Scope of this documentation update

Descriptions #304, #308, #312, #316, #318, #319, #320 and #321 were reconstructed from merged diffs and available task records. #317 and #322 received explicit remaining-work sections. Published bodies were read back and compared. No raw chat transcript, credentials or session identifiers are published. No product code changed.
