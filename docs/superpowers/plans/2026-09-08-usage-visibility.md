# Subscription Limits + Pricing Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the two things a subscription user actually cares about — how much of their plan is left, and what the work would cost — without making API-key users hunt for it either. Three pieces: (a) live subscription-limit visibility (5-hour + weekly reset windows, per-model scoped windows) for Claude and ChatGPT sign-ins; (b) a per-model pricing estimate wherever a model is chosen; (c) a running total cost for the current chat session.

**Architecture:** Two data paths. **Limits** are read, not computed: Claude already returns `anthropic-ratelimit-unified-*` headers on every subscription-mode response (and exposes `GET /api/oauth/usage` for on-demand reads); ChatGPT exposes `GET chatgpt.com/backend-api/wham/usage` (Bearer + `ChatGPT-Account-Id`). A host-side `usage.ts`-adjacent service captures header state per `tokenKey` after each provider call and exposes a throttled on-demand poll; the renderer subscribes. **Pricing** is a static per-model price table (`$/MTok` in/out + cache) joined onto the existing `UsageRecord` pipeline (`chat.ts` → `usage.ts` → `bySession`), which already flows to `ChatPane`/`ChatMetrics`/`CommandCenter`.

**Tech Stack:** existing provider layer (`packages/core/src/providers/`), host services (`packages/host/`), shared usage types (`packages/shared/src/settings.ts` `UsageRecord`/`UsageSummary`), renderer metrics components (`ChatMetrics`, `ModelsView`, `CommandCenterView`). No new deps.

**Depends on:** PRs #167-#170 (subscription sign-in + `auth: 'subscription'` + `UsageRecord.auth` + the "Subscription" cost labeling). Builds on, doesn't replace.

**User decisions (locked):** subscription models show **"Included in plan" primary + equivalent API list price muted**; limits live in a **chat-header chip + popover** (5h + weekly + per-model windows + reset times) AND the **provider card** in Models.

---

## Verified data sources (researched 2026-09-08)

### Claude (Anthropic subscription OAuth)

Every `POST /v1/messages` response in subscription mode carries headers (present **only** because we already send `anthropic-beta: oauth-2025-04-20`):

```
anthropic-ratelimit-unified-status: allowed | allowed_warning | rejected
anthropic-ratelimit-unified-representative-claim: five_hour | seven_day   (which window is binding)
anthropic-ratelimit-unified-5h-utilization: 0.0-1.0
anthropic-ratelimit-unified-5h-reset: <unix seconds>
anthropic-ratelimit-unified-5h-status: allowed | warning | rate_limited
anthropic-ratelimit-unified-7d-utilization / -7d-reset / -7d-status
anthropic-ratelimit-unified-7d_sonnet-utilization / -reset / -status   (model-scoped)
anthropic-ratelimit-unified-7d_opus-utilization / -reset / -status     (model-scoped)
anthropic-ratelimit-unified-overage-status / -overage-disabled-reason
anthropic-ratelimit-unified-fallback-percentage: 0.5  (throttle rate when limited)
```

On-demand read: `GET https://api.anthropic.com/api/oauth/usage` (Bearer + the beta header) returns the same window set as JSON — use it for the initial paint before the first response and for a manual refresh.

### ChatGPT (Codex subscription)

`GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access_token>` + `ChatGPT-Account-Id: <accountId>`:

```json
{
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true, "limit_reached": false,
    "primary_window":   { "used_percent": 55, "limit_window_seconds": 18000,  "reset_at": 1778670307 },
    "secondary_window": { "used_percent": 51, "limit_window_seconds": 604800, "reset_at": 1779157165 }
  },
  "credits": { "has_credits": false, "unlimited": false, "balance": "0" }
}
```

`primary_window` = the rolling ~5h window; `secondary_window` = the ~7-day window. Legacy `x-codex-primary-used-percent`/`reset-at` headers are not emitted on the current `/responses` stream — the `/wham/usage` poll is the reliable path. Poll on a throttle (>=30s between calls, and once after each completed response).

## Design decisions

- **Limits are read, not invented.** Claude state comes free off response headers (update after every subscription response) + an on-demand `/api/oauth/usage` call for first paint / manual refresh. ChatGPT state comes from a throttled `/wham/usage` poll. Neither is extrapolated locally.
- **One normalized shape.** A shared `SubscriptionLimits` type maps both providers to `{ windows: [{ id, label, scope: 'session'|'weekly'|'model', modelId?, usedPercent, resetAt, status }], planType?, creditsBalance?, updatedAt, staleAfterMs }`. The renderer never sees provider-specific header names.
- **Pricing is a static table, labeled as an estimate.** `MODEL_PRICING` maps known model ids (or prefixes) to `$/MTok` {input, output, cacheRead?, cacheWrite?}. Estimates are "list-price" numbers, plainly labeled; they are not the user's actual bill. Unknown models show no estimate rather than a wrong one.
- **Subscription vs metered split.** `auth === 'subscription'` models show "Included in plan" primary + the muted equivalent list price; metered (`apikey`) models show the `$` estimate as primary. Session total sums metered spend and reports subscription usage separately ("included").
- **Session total is live.** `UsageRecord` already lands per message; the chat-header chip reads the running `bySession` total for the active session and the limit chip reads the latest normalized window state — no new aggregation store.

## File structure

- Create: `packages/shared/src/limits.ts` — `SubscriptionLimits`/`LimitWindow` normalized types + `MODEL_PRICING` table + `estimateCost(modelId, usage)` helper.
- Modify: `packages/shared/src/settings.ts` — nothing new needed (`UsageRecord`/`UsageSummary` already carry `auth`/`cost`); add `sessionCost`/`pricePerMtok` surfacing helpers if the shape needs them.
- Modify: `packages/shared/src/ipc.ts` — `limits:get(tokenKey)` + a `limitsUpdated` push event (five-touch).
- Create: `packages/host/src/limits.ts` — `LimitsService`: `recordFromHeaders(tokenKey, provider, headers)` (called after each subscription response), `poll(tokenKey)` (Claude `/api/oauth/usage`, ChatGPT `/wham/usage`, throttled), normalized store, `get(tokenKey)`.
- Modify: `packages/host/src/chat.ts` — after each subscription-mode response, capture `anthropic-ratelimit-unified-*` headers into `LimitsService` (Claude) or trigger a throttled ChatGPT poll; also compute `cost` from `MODEL_PRICING` for metered providers (may already exist — check `usage.ts`/`estimateCostUSD`).
- Modify: `packages/core/src/providers/anthropic.ts` + `chatgpt.ts` — expose response headers / a hook so the host can read them (the provider shouldn't own limits; surface `response.headers` or a `onLimits` callback).
- Create: `apps/desktop/src/renderer/components/UsageLimitsChip.tsx` — chat-header chip: for subscription providers the binding-window % + reset countdown; for metered the running session `$`; hover/click popover with every window (5h / weekly / model-scoped) + reset times + plan type + credits.
- Modify: `apps/desktop/src/renderer/components/ChatMetrics.tsx` — mount the chip beside the context gauge.
- Modify: `apps/desktop/src/renderer/components/ChatPane.tsx` — wire the chip to the active session's provider + session cost.
- Modify: `apps/desktop/src/renderer/views/ModelsView.tsx` — provider card: subscription cards show the full limits breakdown (windows + reset times + plan type + credits) + "Included in plan · ~$X/Y per MTok" muted; metered cards show the estimate.
- Modify: model-picker surfaces (wherever a model is selected — `ChatControls`/model select + the onboarding `DefaultOffer` selects) — append the per-model price label ("$3/$15 per MTok" or "Included in plan").
- Modify: `apps/desktop/src/renderer/views/CommandCenterView.tsx` — keep the "Subscription" labeling consistent with the new chip copy.
- Create: `docs/USAGE-LIMITS.md` — where the numbers come from, that they're live reads not estimates, the off-label caveat, and that limits are provider-side (Agent Nekko can't change them).
- Tests: `limits.test.ts` (header → normalized state, ChatGPT payload → normalized, throttle behavior, `estimateCost` for known/unknown models, subscription-vs-metered labeling).

## Tasks

### PR A — `feat/usage-limits` (data + capture, no UI)

- [ ] **T1: normalized limits model + host service** — `shared/limits.ts` types + `MODEL_PRICING` + `estimateCost`; `host/limits.ts` (`recordFromHeaders`, throttled `poll`, `get`); `limits:get` channel + `limitsUpdated` event (five-touch).
- [ ] **T2: capture in providers + chat** — expose response headers from `anthropic.ts`/`chatgpt.ts` (an `onLimits`/`headers` hook); `chat.ts` feeds them into `LimitsService` for `auth === 'subscription'`; metered `cost` from `MODEL_PRICING` if not already computed.
- [ ] **T3: tests** — header parse, ChatGPT `/wham/usage` parse, throttle, `estimateCost`, unknown-model behavior.

### PR B — `feat/usage-limits-ui` (surfaces)

- [ ] **T4: `UsageLimitsChip` + chat header** — chip (binding % or session `$`) + popover (all windows, reset times, plan type, credits); mounted in `ChatMetrics`/`ChatPane`; `limitsUpdated` subscription.
- [ ] **T5: provider card + model pickers** — ModelsView subscription cards show the full breakdown; model selects (chat controls, onboarding default-offer) append the per-model price label ("$in/$out per MTok" or "Included in plan · ~$eq").
- [ ] **T6: docs + consistency** — `docs/USAGE-LIMITS.md`; Command Center copy consistent with the chip.

## Self-review notes

- Spec coverage: limit windows incl. per-model scoped windows (T1-T4), per-model pricing (T5), session total (T4 + existing `bySession`), both placements per user decision (T4 + T5).
- Type consistency: `SubscriptionLimits` normalized shape used identically in shared/host/renderer.
- Non-goals: editing/increasing limits (provider-side), real-time per-token tickers (header reads update per response, not per token), usage-based billing alerts, API-key account balance reads (not exposed by providers).
- Honesty: prices are list-price *estimates*; limits are live reads; neither is a bill. `docs/USAGE-LIMITS.md` states this.
