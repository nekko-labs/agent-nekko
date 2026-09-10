# First-Run Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-run setup wizard with three skippable steps — pick a theme (system / dark / light / elegant presets with gradient palette swatches), connect model providers (subscription-first online + one-click local), and connect integrations (Agent Nekko as a subagent inside Claude Code / Codex / Cursor, plus app connectors like Slack, Teams, Linear, Jira).

**Architecture:** One full-screen `OnboardingView` rendered over the app when `settings.onboarding?.completedAt` is unset (versioned so future steps can re-prompt). The wizard reuses existing surfaces rather than duplicating them: the theme step writes the same `theme`/`accent`/`accent2` settings the renderer already applies; the providers step reuses `SubscriptionSignIn` (from the subscription plan) + `discoverLocalProviders` + the existing add-provider forms; the integrations step reuses `agent-nekko mcp` (the app is already an MCP server other agents can call) plus the connector framework, extended with two new connector kinds (`jira`, `teams`).

**Tech Stack:** React + Tailwind v3 + Zustand renderer (shared across all editions), host file-ops for the subagent installs, CSS custom-property theme presets.

**Depends on:** the subscription-sign-in plan (the providers step embeds it). Can be sequenced after it in the PR stack, or built with a stubbed sign-in card that lights up when those PRs land.

---

## Design decisions

- **Wizard, not modal.** Full-screen, calm, centered column; step dots + Back / Next / **Skip step** / **Skip setup**. Skipping writes `completedAt` the same as finishing — the point of the flag is "don't auto-show again," not "did everything." Every step is also reachable later from its real home (Settings → Appearance, Models, Connectors, Settings → Replay setup).
- **Theme presets.** Today theming = `data-theme` (light/dark) + free `--accent`. Presets extend that: `settings.themePreset?: string` + `settings.accent2?: string`, applied in `store.applyTheme()` (sets `--accent-2` too) and, for presets that need deeper changes, `[data-preset="<id>"]` token blocks in `styles.css` overriding the same variable set. Swatch = a circle filled with a conic/linear gradient of the preset's 3-4 key colors — no images needed.
- **"Agent Nekko (this app)" as a local provider.** Managed in-app inference is the AN9 track (hardware-aware one-click local model). For v1 the card is honest: it either opens the managed-setup flow if that lands first, or deep-links to the Models page local section with a "recommended: install Ollama / point at your server" guide. Do NOT fake a built-in model.
- **Subagent installs write real config, with backup.** `packages/host/src/integrations.ts` detects which agent CLIs exist (`~/.claude`, `~/.codex`, `~/.cursor`, `~/.windsurf`) and offers per-tool Connect buttons that merge an `agent-nekko` entry (older installs registered as `kotrain`) into that tool's MCP config, backing up the file first. Manual "copy config" fallback always shown.
- **New connectors.** `ConnectorKind` += `'jira' | 'teams'`. Jira: site URL + email + API token (Basic auth) → Jira REST (`/rest/api/3/search`, issues). Teams v1: **incoming webhook URL** for posting + optional Graph token paste for reads — full Graph OAuth is deferred (needs an app registration; note it in SPEC open questions).

## File structure

- Create: `packages/shared/src/themes.ts` — `ThemePreset`, `THEME_PRESETS`.
- Modify: `packages/shared/src/settings.ts` — `AppSettings.accent2?`, `themePreset?`, `onboarding?: { version: number; completedAt?: number; steps?: Record<string, 'done' | 'skipped'> }`.
- Modify: `packages/shared/src/models.ts` — nothing needed for local group; `PROVIDER_DEFAULTS` already covers ollama/lmstudio/vllm/openai-compat.
- Modify: `packages/shared/src/connectors.ts` — kinds + catalog entries for jira/teams.
- Create: `apps/desktop/src/renderer/views/OnboardingView.tsx` + `components/onboarding/` (ThemeStep, ProvidersStep, IntegrationsStep, WizardShell).
- Modify: `apps/desktop/src/renderer/App.tsx` (render wizard when flag unset; add "Replay setup" entry point), `store.ts` (`applyTheme` sets `--accent-2`; `view`/`onboardingOpen` handling).
- Modify: `apps/desktop/src/renderer/styles.css` — `[data-preset]` token blocks.
- Modify: `apps/desktop/src/renderer/views/SettingsView.tsx` — theme preset picker (same swatches), Replay setup button.
- Create: `packages/host/src/integrations.ts` — agent-CLI detection + MCP config install (backup first).
- Modify: `packages/core/src/connectors/index.ts` — `jiraConnector`, `teamsConnector`.
- Modify: `packages/shared/src/ipc.ts`, `packages/host/src/host.ts`, `dispatch.ts`, `apps/desktop/src/preload/index.ts`, `web-client.ts` — `integrations:*` channels (five-touch rule).
- Modify: `apps/desktop/src/renderer/connectorIcons.tsx`, `views/ConnectorsView.tsx` — new connector cards.
- Tests: `integrations.test.ts` (config merge into a temp HOME — never the real one), `themes` preset completeness test, jira/teams connector fetch with mocked fetch.

## Theme presets (v1 set — names/palettes adjustable at impl)

| id | mode | accent | accent-2 | feel |
|---|---|---|---|---|
| `system` | system | #6d5efc | #06b6d4 | Follow the OS (uses current defaults) |
| `light` | light | #6d5efc | #06b6d4 | Clean light, brand accent |
| `dark` | dark | #8b7dff | #22d3ee | Clean dark, brand accent |
| `nebula` | dark | #8b7dff | #22d3ee | Current default, deep-space violet→cyan |
| `terminal` | dark | #22c55e | #84cc16 | Green-on-black phosphor |
| `nord` | dark | #88c0d0 | #81a1c1 | Arctic blue-grey |
| `solar` | light | #b45309 | #d97706 | Warm paper, amber |
| `ember` | dark | #f97316 | #ef4444 | Warm dark, ember orange |

Each preset may also carry `surface`/`ink` overrides via `[data-preset]` blocks where accent alone isn't enough (terminal, nord, ember get slightly tinted papers).

## Tasks

### PR 5 — `feat/theme-presets`

- [ ] **T1: preset model + application** — `shared/themes.ts`, `AppSettings.accent2`/`themePreset`, `applyTheme` sets `--accent-2` + `data-preset`, `styles.css` preset blocks, Settings → Appearance preset picker with gradient swatch circles. Unit test: every preset declares mode + at least 3 swatch colors + valid hex.

### PR 6 — `feat/onboarding-shell`

- [ ] **T2: wizard shell** — `OnboardingView` + `WizardShell` (step dots, Back/Next/Skip step/Skip setup, keyboard ←/→/Esc), `settings.onboarding` flag + `onboarding:*` channel or just `updateSettings`, App.tsx render gate, Settings "Replay setup". Welcome step (Nekko mascot, one-line promise) + done step ("You're set — here are the three things to try").
- [ ] **T3: theme step** — swatch-circle grid wired to the T1 picker logic; live-preview on click (applies immediately, stays applied on skip-forward).

### PR 7 — `feat/onboarding-providers` (needs PR 1–4)

- [ ] **T4: providers step** — two groups. **Online**: Claude (subscription primary, API key secondary), ChatGPT (subscription primary, API key secondary), OpenRouter, "Other OpenAI-compatible". Reuses `SubscriptionSignIn` + existing add forms. **Local**: auto-discovery on mount (`discoverLocalProviders` probes ollama/lmstudio/vllm), detected servers get one-click add + connect-test; the **Agent Nekko** card offers managed setup or deep-links to Models. If ≥1 provider connected, offer "use as default" before continuing.

### PR 8 — `feat/onboarding-integrations` (+ new connectors)

- [x] **T5: jira + teams connectors** — kinds, catalog entries, `jiraConnector` (Basic-auth REST), `teamsConnector` (webhook post + token read), icons, ConnectorsView cards.
- [x] **T6: subagent install** — `host/integrations.ts`: `detectAgentTools()` (which config dirs exist), `installSubagent(tool)` merging `{ command: 'npx', args: ['-y','agent-nekko','mcp'] }` (or the desktop binary path) into `~/.claude.json` `mcpServers`, `~/.codex/config.toml` `[mcp_servers]`, `~/.cursor/mcp.json` — TOML write is a small hand-rolled merge or section-append; JSON gets parse-merge-write. Always `file.bak` first. Manual copy-snippet fallback. `integrations:*` channels + five-touch.
- [x] **T7: integrations step UI** — two groups: "Use Nekko inside other tools" (per-tool Connect cards with detected/not-installed states) and "Connect your apps" (compact connector grid reusing ConnectorsView cards: GitHub, Linear, Slack, Discord, Jira, Teams, Gmail, Drive).
- [ ] **T8: verify** — build + typecheck + tests green; screenshots of each step desktop/mobile, light/dark (per the repo's visual-evidence rule).

## Self-review notes

- Spec coverage: theme step (T1/T3), provider step (T4), integrations step (T5–T7), all skippable (T2).
- Type consistency: `onboarding` settings shape identical in T2 and the App gate; `themePreset`/`accent2` consistent between shared + renderer.
- Non-goals: managed local-model download (AN9), full Graph OAuth for Teams, marketing-tour content.
