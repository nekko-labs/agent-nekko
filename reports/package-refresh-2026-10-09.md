# Package refresh, 2026-10-09

## Scope and isolation

Branch `chore/package-refresh` starts from main `9667719`. Only primary `package.json` and `package-lock.json` were copied into `.worktrees/package-refresh`. The original primary manifest change was Vitest `^4.1.10` to `^5.0.3`; its complete original combined dependency diff is preserved in `package-refresh-original-primary.patch`. Staged/generated `apps/mobile/www` files, primary node_modules, and quota-history worktree were not modified. Primary status and combined dependency diff matched the initial snapshots after verification.

This is behavior-preserving maintenance with no visual change. No artificial SPEC.md feature entry is needed.

## Adopted versions

- Electron 43.7.7 to 44.7.0 (exact pin retained for workspace packaging).
- Vitest 4.1.10 to 5.0.3, including the primary's pending upgrade.
- React/React DOM and their types to 19.3.0; overrides keep one renderer React.
- Fastify to 5.12.5; rate-limit 10.3.0 to 11.2.1; static 10.1.5 and websocket 11.3.3. Published plugin compatibility tables support Fastify 5.
- electron-builder 26.17.0 and electron-updater 6.8.10 from stable maintenance `v26` tags (newer than stale `latest` tags). Downloader test verifies app-builder-lib uses @electron/get 5 APIs.
- Stagehand 4.2.0, retaining exact pin; node-pty beta.15 (the package's latest tag is a beta already used by this project).
- esbuild 0.28.2 in CLI/server; Capacitor desktop bundle dependencies core 8.5.3/local-notifications 8.3.1/push-notifications 8.1.3; PostCSS 8.5.29; Zustand 5.0.15.
- Vite 7.3.7 and Node types 22.20.5.

## Retained constraints

- Vite latest 8.3.4 and React plugin latest 6.1.2 are not compatible with stable electron-vite 5's published Vite 5/6/7 peer range. Retain plugin 5.2.0 and update Vite within 7. A coordinated electron-vite 6 stable migration is the next step, not a beta driver or forced peer install.
- Node types latest 26.6.4 would describe APIs unavailable in supported Node 22/CI. Keep latest 22.x types.
- @electron/get override 5.1.0 is already latest, and downloader API tests pass with builder 26.17.0.
- TypeScript 7.0.2, Tailwind 4.3.3, Mermaid 12.1.0, xterm packages, ghostty-web, QR packages and Jimp are already latest stable.
- Mobile is standalone Expo SDK 57 with separately coordinated React Native/React versions and lockfile. No blind root override or install was applied there. Native mobile upgrades require Expo compatibility checks and platform builds separately.
- Stagehand 4.2.0 requires Node >=22.18.0, as did the existing 4.0.3. The root >=22.12.0 claim predates this refresh; Node 22.12 compatibility is not established. CI uses current Node 22.

## Verification and limitations

Local Node 26.8.1, npm worktree-local installation:

- `npm install` and `npm ls --depth=0`: success, no invalid dependency peers.
- `npm run build:web`, relay build, CLI app bundle and `npm run typecheck`: passed.
- `cargo build -p nekkod --locked`: passed, providing the daemon required by host tests.
- `TMPDIR=/private/tmp npm test`: all eight workspaces pass, 2,630 assertions reported (includes emitted CLI test duplicates), plus root Node script tests. Initial host failures were a missing daemon and macOS `/var` versus `/private/var` alias mismatch; canonical temp directory fixes test setup without modifying code.
- `npm run test:cli-package`: packed/installed CLI native dependency, help/version/status, workspace commands, MCP initialize/list/call all pass.
- Electron 44 hidden capture smoke: passed with isolated temporary profile, hidden non-focusable owned window, zero focus/show activations, dialog suppression, exact screenshot bytes transported to a mock provider. Not a live inference or native OS capture verification.
- Electron/React grid model selection and mode-menu interaction regressions: passed across desktop/narrow widths and light/dark themes in a hidden offscreen sandbox. Captures were not visually inspected and are not claimed as visual evidence.
- Primary dependency patch and git status compared byte-for-byte with original snapshots: unchanged.

`npm audit` reports two low-severity findings: Mermaid and transitive KaTeX (`GHSA-238p-pmpm-9mq7`, trust bypass requires existing prototype pollution). Mermaid latest still selects KaTeX 0.16.47; fixed KaTeX is >=0.18.2. npm suggests an old Mermaid downgrade, not a safe forward fix. Retain latest Mermaid rather than force an untested KaTeX major. Follow upstream dependency update or verify a dedicated override with diagram rendering coverage.

Pending release evidence: CI Node 22/Linux/Windows/macOS checks; signed installer packaging and native mobile builds are not locally exercised by this routine refresh. No visual surface was edited.

## Sources

Version/engine/peer metadata queried with `npm view` for every external direct dependency in root workspaces. Registry metadata is point-in-time; future tags may differ.

- https://www.npmjs.com/package/electron-vite
- https://www.npmjs.com/package/@vitejs/plugin-react
- https://www.npmjs.com/package/@fastify/rate-limit
- https://www.npmjs.com/package/@fastify/static
- https://github.com/advisories/GHSA-238p-pmpm-9mq7
