# PR399 warm/cold switch investigation

## Scope and outcome

Investigation only, at local HEAD `79f1bfd55878ab70db1ac4c862951dc8bf4e2283`. Read root AGENTS.md. No runtime code, thresholds, gates, limits, shortcut fixtures, or SPEC changed. No commits, pushes, desktop launches, or interactions with existing processes. No visual change. No causally supported, safe focused fix was established.

## Evidence

Source: `.shots/perf-full-79f1bfd.txt`. CI measured merge `0d7f3a1a633827eea0829ccf4b71bdc4e11aa58c`, combining head with base `b2ae7a9ac5b10c777199aa9126f738fa09116120` (lines 102, 129). Local head is not that merge revision.

| Measurement | Head normal gate p95 | Gate | Head profiled quick p95 | Base profiled quick p95 |
| --- | ---: | ---: | ---: | ---: |
| Stream frame work | 9.9 ms | 10 ms | skipped | skipped |
| Warm switch | 26.7 ms | 20.8 ms | 29.3 ms | 41.7 ms |
| Cold frame | 26.4 ms | 25 ms | 33.2 ms | 32.4 ms |
| Cold newest history | 26.4 ms | 250 ms | 33.2 ms | 32.4 ms |

Normal gate uses best attempt per row from three runs, not pooled samples (lines 354-366). Warm attempt p95 values are 31.0 / 26.7 / 27.5 ms; cold frame 26.4 / 27.5 / 28.2 ms. These failures recur; they are not resolved by the passing stream gate.

Diagnostic head/base use `--quick --only latency --profile --timeline --no-gpu` (lines 373-379). Warm n=10 and cold n=11, versus normal warm n=40/cold n=33. `scripts/perf/lib/stats.mjs` uses nearest rank: diagnostic p95 is therefore the maximum. Profiling overhead, different sample counts, sequential runs, and no unprofiled base comparison prevent a robust regression conclusion. Base failure does not excuse the head gate failure.

Profile aggregate self times:

| Phase | Head GC | Base GC | Head focus | Base focus |
| --- | ---: | ---: | ---: | ---: |
| Warm | 28.0 ms | 25.6 ms | 18.5 ms | 16.7 ms |
| Cold | 64.5 ms | 50.0 ms | 22.9 ms | 24.5 ms |

Head aggregate Paint is 939.2 ms warm and 1138.6 ms cold (lines 415-465). These totals cover whole phases and nested timeline event durations overlap. They cannot be added together or interpreted as the cost of a p95 switch. The initial investigation had only printed summaries. The downloaded raw profiles and traces are now analyzed below; aggregate totals remain unsuitable for individual-switch attribution.

## Code findings

- `scripts/perf/run.mjs:225-263`: each switch arms a click-timestamp probe, moves the pointer, waits 350 ms, locates/scrolls the card, waits two rAFs, dispatches input, polls the result, then settles 350 ms. `measureLatency` profiles the entire loop, including pre-click setup and post-result settling. GC/focus samples can be outside judged latency windows.
- `scripts/perf/lib/probes.mjs`: warm reports newest-visible-history latency. Cold frame requires a visible titled panel with visible transcript scroller; history additionally requires newest marker and viewport intersection. A rAF observes DOM readiness and a MessageChannel callback records completion after rendering. Identical cold frame/history results indicate both conditions were observed in the same sampled frame, not that fetching has zero cost.
- `apps/desktop/src/renderer/components/ChatPane.tsx:489-514`: ComposerFocus already defers focus and restored-draft selection via `afterPaint`; it guards typing elsewhere. Removing focus or delaying it further would alter behavior and is not justified by aggregate self time.
- `apps/desktop/src/renderer/afterPaint.ts`: rAF followed by zero-delay timer. Probe completion instead uses MessageChannel. Both run after rendering, but ordering across task sources is not a guaranteed causal boundary. Deferred focus/cleanup could delay the probe callback without delaying the first rendered frame. This is a hypothesis, not an established measurement bug; do not change probe semantics to make the gate pass.
- `apps/desktop/src/renderer/views/WorkspacesView.tsx:558-579`: outgoing workspace eviction is deferred after paint. `CommandWall.tsx` also retains stable keyed wall windows. Warm/cold are harness labels based on navigation history; actual mounts and transcript-cache hits must be observed, not inferred solely from the ring size.
- `apps/desktop/src/renderer/sessionCache.ts`: bounded eight-chat/24 MiB LRU, same-object put avoids recounting. Cold ring has eleven targets (`run.mjs:CFG`), exceeding that transcript cache. This does not establish which panes were remounted or loaded in the wall path.
- Head/base diff has no changes to ChatPane, afterPaint, cache, or switch probe. Existing pricing-index fix is already at local head. No new evidence attributes remaining switches to that pricing lookup. Limits and shortcut fixtures were not modified. The initial investigation did not test them; follow-up unit verification and independent review are recorded below.

## Verification

Ran without launching any app:

```text
npx vitest run scripts/perf/probes.test.ts apps/desktop/src/renderer/sessionCache.test.ts apps/desktop/src/renderer/components/ChatPane.cost.test.ts
```

Passed: 5 files, 20 tests. This includes 11 tests from the three requested current-source files and 9 matching cache/cost tests automatically discovered in `.shots/wall-polish/base-source`. Those snapshot files were only read/executed, not changed. Probe tests cover transcript-only visibility and setup ordering, not real Chromium paint timing or focus task ordering. Unit results do not prove either latency gate passes.

Initial shell search failed because `rg` is not installed; continued with PowerShell Select-String. No dependency installation was needed.

## Concrete next steps / release blockers

1. Done in this follow-up: inspect the downloaded raw artifact and individual switches, preserving the failed original gate. See the correlation method and results below.
2. Run paired unprofiled full head/base latency measurements on the same disposable CI environment with identical browser, viewport, flags and sample counts; alternate run order. Keep all existing gates unchanged. The current profiled quick base run is diagnostic only.
3. In diagnostic-only instrumentation, correlate click timestamp, DOM-ready rAF, probe MessageChannel completion, ComposerFocus timer start/end, workspace cleanup, cache hits/misses and pane mount/unmount. Use a shared monotonic clock and retain original judged samples. Current timeline filtering in `lib/profile.mjs` drops user-timing events, so markers need explicit retention or a separate sidecar if instrumentation is added.
4. For GC, inspect sampled call ancestry and use allocation evidence to identify the allocator; do not infer it from the `(garbage collector)` row. For paint, isolate tasks intersecting slow-switch intervals from flat-out background rendering.
5. Only after attribution, consider a narrowly scoped allocation or redundant-layout fix, preserving automatic composer focus, caret/draft restoration and visibility behavior. Test that exact path, then rerun the unchanged CI gates.

Remaining blockers: warm and cold frame CI gates still fail. Raw-artifact analysis and individual-switch correlation are complete below, but exact input timestamps, a focused causal fix, new paired CI measurement and visual verification remain unverified. No browser/visual tooling was used. SPEC needs no update for this investigation-only report. No PR publication or PR-description update was attempted under the no-push/investigation-only scope.

## Raw-artifact follow-up (PR399 only, skip369)

All work stayed inside this verification worktree. No production, fixture, threshold, gate or SPEC edits; no commit/push, CI rerun, app launch, process termination or data deletion. Existing raw data preserved. Added diagnostic Node scripts and outputs only under untracked .shots.

### Reproduction and timing boundaries

Sources: .shots/perf-ci-79f1bfd/profile-{head,base}/{warm,cold}-switch.trace.json, matching cpuprofiles and perf-report.json. Run from this worktree:

```text
node .shots/pr399-inspect.cjs
node .shots/pr399-exact.cjs
node .shots/pr399-correlate.cjs
node .shots/pr399-detail.cjs
```

The traces have exactly 10 warm and 11 cold click EventDispatch spans on CrRendererMain for each revision, matching the ordered sample arrays. Crucially, FunctionCall retains injected script 6's ch.port1.onmessage at line 111 (the switch completion callback), and the readiness rAF at line 103. There is one matching completion per click. Thus the final correlation anchors completion to that callback entry and reconstructs start as completion minus the recorded judged latency. This is closer to the actual judged window than dispatch-start plus latency: judged timing begins at e.timeStamp, before EventDispatch. The implied input-to-dispatch differences range from 0.797 to 4.728 ms. Report samples are rounded to 0.1 ms and callback entry slightly precedes its performance.now() read, so boundaries remain approximate, not exact input timestamps. CPU startTime/timeDeltas and trace ts share the Chromium monotonic microsecond scale; sample intervals are clipped to each reconstructed window. Focus includes ancestry, not merely focus self time; GC is sampled GC self time, not a complete GC trace. Zero sampled GC is not proof of zero collection.

All rows below use individual judged windows, excluding pre-click setup and post-completion settle. Timeline kind durations are clipped intersections; nested events overlap and MUST NOT be added. Paint includes document and child paint events; it is not exclusive renderer cost. Output with other render kinds is .shots/pr399-switch-correlations.json.

| Revision / phase | Switch | Judged ms | Click dispatch ms | GC sampled ms | Focus ancestry ms | Layout ms | Paint nested ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| head warm | 1 | 26.5 | 7.683 | 0.000 | 0.734 | 3.598 | 5.299 |
| head warm | 2 | 25.1 | 6.570 | 0.177 | 0.000 | 2.363 | 4.344 |
| head warm | 3 | 24.5 | 6.545 | 0.000 | 0.000 | 3.531 | 4.167 |
| head warm | 4 | 24.5 | 6.031 | 0.000 | 0.000 | 2.218 | 4.445 |
| head warm | 5 | 20.4 | 5.626 | 0.000 | 0.000 | 2.282 | 3.772 |
| head warm | 6 | 24 | 6.277 | 0.000 | 0.000 | 1.936 | 4.141 |
| head warm | 7 | 19.4 | 5.457 | 0.000 | 0.000 | 2.197 | 4.161 |
| head warm | 8 | 22.9 | 5.464 | 0.000 | 0.000 | 2.013 | 4.155 |
| head warm | 9 | 24.8 | 7.388 | 0.000 | 0.663 | 3.337 | 4.958 |
| head warm | 10 | 29.3 | 6.888 | 0.000 | 0.000 | 3.157 | 5.186 |
| head cold | 1 | 25.1 | 5.984 | 0.000 | 0.844 | 1.670 | 4.101 |
| head cold | 2 | 20.6 | 5.329 | 0.000 | 0.000 | 2.029 | 4.575 |
| head cold | 3 | 21.9 | 6.416 | 0.000 | 0.000 | 2.116 | 4.612 |
| head cold | 4 | 33.2 | 13.716 | 0.000 | 1.521 | 2.079 | 4.871 |
| head cold | 5 | 24.4 | 6.345 | 0.000 | 0.000 | 1.979 | 4.576 |
| head cold | 6 | 22.7 | 5.569 | 0.000 | 0.000 | 2.135 | 4.244 |
| head cold | 7 | 22.4 | 5.519 | 0.000 | 0.000 | 1.842 | 4.323 |
| head cold | 8 | 29.1 | 6.992 | 0.000 | 0.000 | 3.434 | 4.243 |
| head cold | 9 | 27.8 | 7.313 | 0.000 | 0.000 | 3.086 | 4.501 |
| head cold | 10 | 25 | 5.390 | 0.000 | 0.000 | 2.129 | 5.004 |
| head cold | 11 | 28.2 | 7.213 | 0.000 | 0.837 | 2.612 | 4.124 |
| base warm | 1 | 28.6 | 8.809 | 0.000 | 0.000 | 3.592 | 5.006 |
| base warm | 2 | 33.4 | 7.998 | 0.000 | 0.000 | 3.646 | 5.840 |
| base warm | 3 | 27.4 | 7.673 | 0.000 | 0.828 | 3.858 | 5.254 |
| base warm | 4 | 23.7 | 5.547 | 0.167 | 0.000 | 2.102 | 4.572 |
| base warm | 5 | 20.6 | 6.334 | 0.000 | 0.000 | 2.189 | 3.805 |
| base warm | 6 | 31.1 | 6.945 | 0.000 | 0.000 | 3.333 | 5.755 |
| base warm | 7 | 24.9 | 6.720 | 0.000 | 0.000 | 3.374 | 5.038 |
| base warm | 8 | 23.5 | 5.656 | 0.000 | 0.000 | 1.941 | 4.412 |
| base warm | 9 | 19.9 | 5.690 | 0.000 | 0.000 | 2.206 | 3.660 |
| base warm | 10 | 41.7 | 7.818 | 0.164 | 0.000 | 3.810 | 9.247 |
| base cold | 1 | 32.4 | 7.693 | 0.000 | 0.000 | 2.321 | 4.287 |
| base cold | 2 | 25.4 | 7.828 | 0.000 | 1.010 | 2.794 | 4.149 |
| base cold | 3 | 20.4 | 5.823 | 0.000 | 0.000 | 2.042 | 4.302 |
| base cold | 4 | 24.1 | 5.510 | 0.000 | 1.333 | 2.112 | 4.658 |
| base cold | 5 | 28.6 | 7.984 | 0.000 | 1.182 | 2.462 | 5.938 |
| base cold | 6 | 23.7 | 7.945 | 0.000 | 1.651 | 1.957 | 4.071 |
| base cold | 7 | 30 | 6.598 | 0.000 | 0.000 | 3.224 | 5.822 |
| base cold | 8 | 25.7 | 6.559 | 0.000 | 0.000 | 2.148 | 4.416 |
| base cold | 9 | 24.6 | 5.791 | 0.000 | 0.000 | 2.255 | 4.408 |
| base cold | 10 | 22.4 | 4.774 | 0.000 | 0.000 | 1.783 | 4.161 |
| base cold | 11 | 26.1 | 4.994 | 0.000 | 0.000 | 1.870 | 4.509 |

### What the slow switches actually show

- **Head warm #10, 29.3 ms:** click dispatch 6.888 ms. Readiness rAF starts 20.648 ms after dispatch; document Paint runs at +21.245 to +23.744 ms; probe completion at +27.894 ms. No focus ancestry or sampled GC in the reconstructed judged interval, and no TimerFire. The 13.760 ms dispatch-end-to-readiness-rAF gap is not explained by a long click handler. Filtered trace cannot fully distinguish scheduler/render waiting from missing event categories. Do not relabel it as GC or composer focus.
- **Head cold #4 (target chat index 5), 33.2 ms:** input-to-dispatch approximately 4.728 ms; click dispatch 13.716 ms; readiness rAF +22.786 ms; document Paint +23.366 to +25.588 ms; completion +28.472 ms. React synchronous work FunctionCall at +1.179 lasts 12.487 ms. Click CPU sample self stacks include ChatPaneImpl 2.071 ms plus an anonymous child at bundle line 41078 2.136 ms, DOM createElement 1.024 ms, and wordList/analyzePrompt/PromptAnalyzer 0.794 ms. These identify render work, but do not establish a redundant calculation or a safe memoization boundary. Focus ancestry 1.521 ms is inside input dispatch, not the deferred ComposerFocus timer; no TimerFire or sampled GC in this judged window.
- **Base warm #10, 41.7 ms:** click dispatch 7.818 ms; readiness rAF +28.790 ms; document Paint +29.721 to +34.426 ms; completion +40.903 ms. Only 0.164 ms sampled GC and no focus ancestry or TimerFire. Its delayed rendering and larger paint span show that a slow tail also exists without PR399 pricing changes, not that the failed head gate is acceptable.
- **Base cold #1, 32.4 ms:** dispatch 7.693 ms, document Paint +20.501 to +22.543 ms, completion +30.692 ms. No sampled GC/focus or TimerFire in judged interval.
- Across all judged windows, sampled GC totals are head warm 0.177 ms, head cold 0 ms, base warm 0.331 ms, base cold 0 ms. These are sums of clipped individual-window evidence, not loop totals. Most phase GC falls outside the judged switches. Moving GC/focus based on phase summaries is unsupported.
- The earlier dispatch-anchored approximation mistakenly included deferred focus TimerFire after probe completion. The completion-anchored final output corrects this. A completion MessageChannel callback can be found directly in the existing trace; no probe/gate change is needed to obtain this evidence.

### Independent correctness review: pricing and fixtures

Reviewed PR399 diff from b2ae7a9 through 79f1bfd, including limits.ts, snapshot, update-model-pricing.mjs, shortcut fixture/integration/sandbox and budget-pricing sandbox. Ran npx vitest run packages/shared/src/limits.test.ts apps/desktop/src/renderer/shortcuts.test.ts --exclude "**/.shots/**": **2 files, 31 tests passed**. Node catalog check found no uppercase ids or unqualified-ID collisions in the current snapshot. The one-time map preserves current first-route lookup semantics, and no focused production correctness defect was established in that indexed lookup. Tests do not validate remote catalog truth or native shortcut delivery.

Actionable review issues (not changed here):

1. **Fixture readiness/races:** shortcut-sandbox.cjs relies on fixed 800/40/100 ms sleeps rather than waiting for App handler readiness or completion of store actions. The unmatched-chord loop resets onboarding state and dispatches immediately without the 40 ms settle used elsewhere, allowing App's onboarding-dependent handler closure to lag state. Replace sleeps with bounded explicit readiness/state polling, including a React committed reset signal; retain strict call-count assertions. This improves evidence reliability, not production shortcut behavior.
2. **Host stub hides unsupported calls:** shortcut-fixture.tsx's Proxy returns null or empty lists for every unknown method, suppressing unexpected host-boundary behavior; updateSettings also returns a merged object without persisting it for later getSettings. Record unexpected calls, whitelist intentional no-ops and fail on other calls; maintain synthetic settings when updating. The fixture otherwise uses real App/store actions and blocks network at both CSP and session boundaries.
3. **DOM-only shortcut scope:** window.dispatchEvent(KeyboardEvent) verifies App mapping and store actions, not real Electron keyboard/menu interception, focused textarea/editor/terminal propagation, IME composition or macOS platform integration (fixture advertises win32 for both ctrl/meta tests). Add targeted focused-element DOM cases, and disposable-desktop native delivery tests if claiming OS-wide correctness. Current pass is valid only for synthetic window-dispatched events.
4. **Refresh validation gap:** update-model-pricing.mjs validates finite nonnegative input/output but not cacheRead/cacheWrite or override rates/minPromptTokens, despite estimateCost consuming cache rates. Number conversion can yield NaN/Infinity, which JSON serializes to null. Validate all optional rates and override thresholds before writing; test malformed synthetic API catalogs without fetching or overwriting the snapshot. This is a future refresh-path issue, not evidence the current snapshot is invalid.
5. **Budget evidence can pass a missing surface:** budget-pricing-sandbox.cjs pushes budget:false into report.checks without failing. Assert the selector and expected option/rate text for each viewport/theme; a screenshot plus a successful process exit alone does not prove the pricing selector worked. No captures were inspected or fixture rerun in this task.

### Recommendation to parent / unfinished work

**Honest limitation, not a safe production fix:** retain the indexed pricing lookup already at head, automatic composer focus/caret restoration, all thresholds and gates. Do not delay focus, change the probe endpoint, or rerun CI blindly. Current raw evidence rejects phase-total GC/focus attribution and isolates two different head tail contributors: synchronous cold render/input work and warm pre-render scheduling delay. It does not attribute either to changed pricing lookup or shortcuts.

Next diagnostic step is narrowly scoped: retain exact event timestamp and completion timestamp in a sidecar, map the slow cold anonymous ChatPane bundle location to source, observe mount/cache identity and count PromptAnalyzer/ChatPane recomputations for the specific target. Retain original judged samples and task semantics. For the warm tail, capture scheduler/render categories around dispatch-end through readiness-rAF (not just whole-loop aggregates). Only if redundant work is demonstrated should parent patch that exact path with a focused regression test and unchanged paired full measurements. Any comparison should use equal unprofiled sample counts and alternating order, not repeated quick profiled reruns.

No new visual evidence or native shortcut verification performed. Report and .shots diagnostics only; SPEC update not required. PR399 gate failures remain release blockers. PR369 was not investigated.
