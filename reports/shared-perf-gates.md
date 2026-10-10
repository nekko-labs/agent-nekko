# Shared performance gate investigation

Date: 2026-10-09. Candidate base: origin/main fb6cd50. No budget, sample-count, retry, browser flag or workflow changes.

## Evidence

The latest CI runs examined were #394 (37814267450), #396 (37817659151), #399 (37840969917), #400 (37835043585) and #401 (37834525875). Every head fails warm/cold switching and every unchanged-base diagnostic also fails switching. #394, #399 and #400 additionally fail streaming frame work. This is not proof the heads have no regressions.

| PR | Head warm p95 / 20.8 ms | Head cold frame p95 / 25 ms |
| --- | --- | --- |
| #394 | 28.9 | 28.1 |
| #396 | 27.0 | 27.1 |
| #399 | 28.2 | 26.7 |
| #400 | 28.6 | 27.8 |
| #401 | 26.8 | 25.7 |

Source: [CI #399](https://github.com/nekko-labs/agent-nekko/actions/runs/37840969917) and the corresponding CI runs above, including their diagnostic base/head artifacts. Paint dominates phase totals, but switch-critical samples also contain React dispatch, style recalculation and layout. Phase totals include settling time and are not causal attribution to the measured interval.

## Candidate

Preserve the workspace and workspace-list references when focusing its already-selected pane, and memoize workspace canvases. Visibility/focus changes still render the affected canvases, and layout changes still replace the workspace. No appearance, warm-set, cache limit or product contract changes; SPEC.md needs no artificial behavior update. PF5 in TASKS.md records the optimization and unverified acceptance.

## Verification and limits

- Web build, desktop build, all-workspace typecheck, desktop suite (120 files, 788 tests), two focus-identity regressions and two perf-probe tests pass.
- M1 Max, headless Chrome 149, no GPU, quick timeline run: before warm/cold p95 11.5/15.6 ms; after 14.9/14.0 ms. After composer/terminal/stream p95 11.8/20.0/7.3 ms. All existing CI gates pass locally, but the warm result is worse and no performance win or Linux gate resolution is established.
- Chrome 156 local run stalled after launch with no phase output and was interrupted; no timings were obtained. Chrome 149 is not the CI Chrome 154 environment.
- Functional check fails at its stale `nav button[aria-label="Command Center"]` selector before exercising switching. This is not a passing interaction check.
- Full npm test stops in host chat-worktrees.test.ts: four failures with macOS canonical-path mismatches. Changing TMPDIR to /tmp reproduces them. Host implementation/tests were not changed by this candidate.
- No visual change. No screenshots or desktop OS verification claimed.
- Primary dirty main and existing worktrees preserved. PR #369 untouched. No merges authorized for this task.

## Next acceptance steps

Measure the candidate in the unchanged Linux CI gate. If no improvement is established, do not represent this optimization as resolving the shared blocker. Investigate event-to-frame scheduling and switch-critical style/layout work next. Repair the functional harness's navigation in a focused follow-up; reproduce host path failures on the unchanged base before fixing them separately. Each dependent PR still needs its own checks, review and evidence requirements satisfied after any approved base fix lands.
