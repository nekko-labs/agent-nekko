# Composer clipboard verification

## Scope and outcome

Verified using `apps/desktop/scripts/composer-editing-integration.cjs` in this worktree. No commits, PRs, tab implementation edits, or SPEC.md edits were made. Existing unrelated modifications were left in place. The user-owned primary-checkout Electron app and daemon were not interacted with or stopped.

**Successful native OS clipboard round-trip remains blocked. No OS clipboard writes, clears, copy commands, or restoration attempts were performed.** No user clipboard contents were logged or saved.

## Isolation and native findings

- The harness uses its own `.shots/composer-editing/profile` and a unique nonpersistent Electron session partition, sandbox, context isolation, no Node integration or host bridge, blocked external requests, and deny-all permission check/request handlers.
- Electron partitions isolate browser session storage, not the system clipboard. A partition is not a private clipboard.
- The separate `selection` clipboard is Linux-only and is an OS selection, not an Electron partition clipboard. It is not a safe Windows alternative. It also would not prove the composer's ordinary `navigator.clipboard` path.
- Installed dependency is Electron 43.7.7. Its local `electron.d.ts` exposes legacy `availableFormats`, `readBuffer`, and individual write methods. Current online Electron docs describe a newer API; those newer signatures must not be assumed available in this installation.
- Native renderer probes found a secure context and both `navigator.clipboard.read` and `readText` functions. Both returned `NotAllowedError`. Native Paste displayed the error and preserved `hello world`.
- No permission-handler callbacks fired in the hidden window. Thus this run does **not** establish whether permission denial versus document focus prevented reads, and it does not prove successful native read access or that `readText` succeeds when native `read` fails. No native writes were attempted even under denial, since focus/user activation can change write permission behavior.

## Concrete preservation blocker and safe alternatives

Windows clipboard formats can include private application-owned handles, GDI objects, synthesized formats, and delayed/owner-dependent data. Electron's format/buffer APIs are not a guaranteed lossless backup/restore mechanism for all such data. Individual format writes also do not provide a guaranteed atomic multi-format restoration. Concurrent clipboard changes and clipboard history add further restoration risks. A text/HTML/image snapshot is insufficient for the user's all-format requirement.

The safe next step for a real native write/read integration test is a disposable Windows VM or Windows Sandbox with clipboard redirection/sharing disabled and a disposable desktop profile. Confirm isolation before writing fixture text, HTML, images, and custom formats. A separate browser partition or app profile on the current desktop does not satisfy that condition. No such separate OS environment was established in this run.

Safe local alternatives used here: denied native read probes and synthetic Clipboard API fixtures driving the actual React editor in Electron. Fixtures validate composer behavior, not Windows clipboard transport.

## Focused change and regression checks

Modified only these implementation/harness files during this request:

- `apps/desktop/scripts/composer-editing-integration.cjs`: explicit isolated partition, denied native read probes, native denied-paste check, missing/rejecting read fallback cases, and dual-read-failure check.
- `apps/desktop/src/renderer/components/agent-console/ComposerEditingTools.tsx`: if the initial rich `read()` request rejects, try `readText()`. Existing missing-`read` fallback remains. Item extraction failures still surface rather than silently dropping rich content. If both reads fail, the error remains visible and the editor is unchanged.

The rejecting-read/successful-readText fixture failed before this change (`Paste: rejecting read falls back to readText`) and passed after it. Both Paste and Paste as Markdown were tested with missing and rejecting `read`; newline normalization was verified. The complete harness passed 22 checks, including rich conversion, image attachment dispatch, selection, undo, disabled editing, and permission failure. Successful copy/paste checks use mocked Clipboard API objects.

Evidence: `.shots/composer-editing/status.json`, `harness-before-fallback.log`, and `harness-after-fallback.log`. Harness screenshots were captured but not visually inspected; this request does not claim visual verification or successful native clipboard transport. No visual layout change was made by the fallback patch.

## Full desktop checks and failures

1. Initial `npm test --workspace @nekko-agent/desktop`: 87 files passed; 572 tests passed; 3 suites failed to load missing `@nekko-agent/host` / `@nekko-agent/host/user-data` build exports.
2. Built shared/core/host using `npm run build:core` and `npm run build -w @nekko-agent/host`. Next full test run: 89 files passed, 600 tests passed; 4 bundle-external assertions failed because desktop `out/main/index.js`, `out/preload/index.js`, and `out/renderer/assets` had not yet been built.
3. `npm run build -w @nekko-agent/desktop` succeeded. Final `npm test --workspace @nekko-agent/desktop`: **90 files, 604 tests passed**, no remaining failures.
4. `npm run typecheck -w @nekko-agent/desktop`: passed.

Logs are in `.shots/composer-editing/desktop-tests.log`, `desktop-tests-built.log`, `desktop-build.log`, `desktop-tests-final.log`, and `desktop-typecheck.log`. The intermediate failures were missing build prerequisites, not fixed by changing test expectations. Full desktop tests here means the desktop package's `vitest run` suite, not every separate live-app integration script.

## Sources

- [Electron clipboard docs](https://www.electronjs.org/docs/latest/api/clipboard): system clipboard and Linux selection clipboard; current docs differ from installed legacy type signatures.
- [Electron session docs](https://www.electronjs.org/docs/latest/api/session): session partition storage and permission handlers.
- Installed `node_modules/electron/electron.d.ts`, `Clipboard` interface: actual 43.7.7 clipboard API.
- [Windows clipboard formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats): private/registered formats, handles, synthesized formats, clipboard history.

## Remaining work

Successful native copy/paste transport requires the isolated OS environment above. Native permission-granted/focused reads, all-format round-trip, and other platforms remain unverified. No spec changes were made, as explicitly requested; any later landing workflow must handle its own product-spec and release requirements.
