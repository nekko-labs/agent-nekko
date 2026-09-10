# Contributing to Agent Nekko

Thanks for your interest! Agent Nekko is an open-source, local-first AI coding & cowork desktop app. Contributions of all sizes are welcome.

## Development setup

Requires Node 20+. The project uses **npm workspaces** (not pnpm/yarn).

```bash
git clone https://github.com/nekko-labs/agent-nekko
cd agent-nekko
npm install
npm run build:core   # build the shared + core packages first
npm run dev          # launch the desktop app (electron-vite)
```

## Project layout

| Path | What |
| --- | --- |
| `packages/shared` | Types + IPC contracts (pure, no runtime deps) |
| `packages/core` | Engine: providers, agent loop, guardrails, context, indexer, memory, connectors. **No Electron imports**, unit-tested with Vitest. |
| `apps/desktop` | Electron app: `src/main` (Node), `src/preload` (bridge), `src/renderer` (React) |
| `apps/website` | Static marketing site |
| `scripts/itest-local.mjs` | Manual end-to-end test against a real model server |

**Rule of thumb:** business logic goes in `packages/core` (so it's testable without Electron); the desktop app wires it to the filesystem, shell, and UI.

## Publishing the `npx agent-nekko` package

`npm run bundle:web` produces a self-contained package in `apps/server/cli-dist/`
(server + engine bundled by esbuild, plus the built `web/` UI). To release it:

```bash
npm run bundle:web
cd apps/server/cli-dist && npm publish
```

After that, anyone can run the web edition with `npx agent-nekko`.

## Before you open a PR

Keep the build green and the suite passing:

```bash
npm run build       # shared → core → desktop must all build
npm test            # vitest in packages/core
npm run typecheck   # all three workspaces
```

- Add tests in `packages/core` for new engine behavior (providers, guardrails, agent loop, context).
- Match the surrounding code style; keep changes focused.
- For provider changes, you can verify against a real local server:
  `node scripts/itest-local.mjs http://your-host:port your-model-id`

## Commit messages

Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

## Reporting bugs / requesting features

Use the issue templates. For local-model issues, please include your provider
kind (Ollama / LM Studio / vLLM / cloud), the base URL shape, and the model id.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
