# GitHub App comment-triggered review (self-hosted server)

This optional integration is GitHub-only. It does not use the interactive agent loop,
PR management, worktrees, shell, MCP, or repository checkout. There is no visual change.
It is implemented, not a deployed or registered GitHub App.

## Setup

1. Create a GitHub App, enable webhooks, and generate/download its RSA private key.
   Grant repository **Pull requests: read and write**, **Contents: read**, and the
   mandatory **Metadata: read** permission. Subscribe to **Issue comment** events
   (PR conversation comments are issue comments). Inline diff/review comments are
   not supported. Install the App on only the repositories it should review.
2. Set the webhook URL to public HTTPS `https://your-host/hooks/github/review`.
   GitHub cannot reach localhost/private LAN addresses. Use a reverse proxy or
   tunnel that preserves the exact JSON bytes and forwards GitHub signature,
   delivery, and event headers. Do not expose other routes without the server's
   normal authentication. This dedicated route uses webhook HMAC auth, not the
   `/api/` bearer token. The route is absent when disabled.
3. Set these environment variables on the **server** (not desktop/relay/cloud):

   ```text
   NEKKO_GITHUB_APP_ENABLED=1
   NEKKO_GITHUB_APP_ID=123456
   NEKKO_GITHUB_APP_PRIVATE_KEY=<PEM string; literal \n escapes are accepted>
   NEKKO_GITHUB_APP_WEBHOOK_SECRET=<long random secret matching GitHub settings>
   NEKKO_GITHUB_APP_BOT_LOGIN=your-app[bot]
   NEKKO_GITHUB_APP_REPOSITORIES=owner/repository,owner/another
   NEKKO_GITHUB_APP_REQUESTERS=trusted-login,another-trusted-login
   NEKKO_GITHUB_APP_AUTO_APPROVE=0
   ```

   No wildcard allowlists. Repository and requester comparisons are case-insensitive.
   App identity and PEM configuration are validated at startup. Keep secrets out of
   commits/logs; inject them through your deployment's secret manager. Installation
   tokens are minted per review, scoped to one allowed repository, and never persisted.
4. Configure the host's default provider and model and usable credentials in the
   same server data directory. The adapter resolves existing subscription credentials
   if applicable. Ensure the chosen provider supports system policy, adequate context
   for the bounded input, and plain JSON verdicts. No fallback provider is selected.
   PR data goes to that configured provider: use a suitable local provider for private
   code that must not leave the machine. Existing server renderer/bind-auth prerequisites
   still apply.
5. Start with automatic approval disabled. Test on a small same-repository PR using
   an allowlisted human account. Verify a COMMENT review and delivery logs before
   enabling `NEKKO_GITHUB_APP_AUTO_APPROVE=1`.

## Commands

A new PR conversation comment must begin with one of these commands (no leading
quote, whitespace, or other text). Use the configured bot login exactly:

```text
@your-app[bot] review Focus on validation and backward compatibility.
@your-app[bot] approve Review correctness and security before approving.
```

The trailing text is the review focus; omitted focus defaults to correctness and
security. Editing an existing comment does not trigger work. Bot accounts, unauthorized
requesters, non-PR issue comments and repositories outside the allowlist are ignored.
Requester identity must match both event sender and comment author.

`review` always posts COMMENT, even if the model would approve. `approve` posts
APPROVE only when global opt-in is enabled **and** the model returns the explicit
structured verdict `APPROVE`, `complete: true`, and the exact reviewed head. A
complete `COMMENT` verdict posts COMMENT, never CHANGES_REQUESTED. Inconclusive,
malformed, oversized, failed or unfinished model responses post nothing.

## Safety boundaries

- HMAC SHA-256 is compared in constant time against the **raw bytes**, before JSON
  parsing. Route body cap is 256 KB. GitHub API requests have 20-second deadlines,
  no redirects, a fixed github.com API origin and a 1 MB response cap.
- Only open, non-draft, **same-repository** PRs are accepted. Fork PRs are rejected;
  this first version does not fetch fork code or approve fork contributions.
- Only one files API page, at most 100 files, is accepted. Any Link header,
  changed-file count mismatch, missing/binary patch, or patch addition/deletion
  count mismatch fails closed. No silently truncated or paginated diff is reviewed.
  Patches and filenames together are capped at 120 KB, title at 1,000 characters,
  description at 12,000, command at 4,000, and serialized model input at 180,000.
  This is patch review, not full-repository analysis; insufficient context must
  produce an inconclusive verdict. GitHub's patches remain the evidence source.
- Model invocation is one-shot with a 120-second abort deadline and 2,000 output
  tokens. There are no tool definitions, tool calls are rejected, and no PR code
  is executed. System policy labels PR title/body/patches as untrusted evidence,
  not instructions. The requester focus cannot override policy. Structured output
  is validated, not inferred from positive prose. Prompt-injection resistance is
  not a mathematical guarantee of model behavior; keep auto-approval opt-in and
  use GitHub branch protections and human oversight for high-risk repositories.
- Immediately before submission, the PR is re-fetched and open/draft/repository,
  exact head SHA and base SHA are checked. Submission includes `commit_id` of the
  reviewed head. A push after the check can still race the POST; the review is
  pinned to the old commit, never intentionally attributed to the new head.
  Configure GitHub to dismiss stale approvals; this integration does not merge.
- Posted bodies contain the reviewed commit and findings, with no attribution
  footer or signature. The model is instructed not to add attribution.

## Replay, operation and deployment limitations

`github-review-replay.json` in `NEKKO_DATA_DIR` durably claims delivery and comment
identities **before** API/model work. Different delivery IDs for the same comment
are deduplicated, including after restart. Claims never expire; the ledger fails
closed at 100,000 entries or on corrupt/unwritable state. Preserve/back up it: deleting
it permits old signed payloads to be replayed. There is no signature timestamp in
GitHub's protocol. Restrict filesystem access and protect the webhook secret.

Run exactly **one server process with a persistent data directory**. The file ledger
is not a cross-process lock/database. One review is handled at a time; busy requests
return 503 without claiming so they can be manually redelivered. Accepted reviews
run synchronously: GitHub may report a delivery timeout while processing continues.
There is no durable job queue, automatic retry or delivery scheduler in this version.
For an already claimed failure, use a **new comment**, not redelivery. A crash or
ambiguous review POST deliberately forfeits retry rather than risk duplicate approval.
Generic failure responses/log messages do not expose tokens, prompts or PR content.

Before production: provision the App/installations, secrets, configured model,
persistent single-worker hosting, public HTTPS ingress, rate limits at ingress,
server authentication for non-webhook routes and stale-approval branch protection.
Exercise live signed deliveries and permissions in a test repository. Tests use mocked
GitHub/model transports; they do not establish live installation or approval success.
For throughput or reliable asynchronous acceptance, a transactional replay/job store
and bounded durable worker queue are future work, not part of this implementation.
