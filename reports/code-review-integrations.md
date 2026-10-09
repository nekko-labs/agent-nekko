# Code review integrations

## CodeRabbit setup

CodeRabbit is a proprietary hosted review service, not an open-source tool. Its current pricing FAQ promises free reviews forever for public repositories; unlimited total PR reviews still have hourly allowances and fair-use limits. This is not authorization to enable paid usage-based reviews, security scans, or cloud coding agents.

Repository configuration is in `.coderabbit.yaml`: quiet, automatic draft and incremental reviews; repository workflow and privacy guidance; generated/build outputs and lockfiles excluded. Dependency security remains covered separately. Automatic approval and code-generating finishing touches are disabled. Review summaries do not rewrite the PR description. Findings are advisory, not proof of correctness, visual inspection, or permission to merge.

### Activation (organization owner)

1. Sign in at https://app.coderabbit.ai/login using GitHub.
2. Install https://github.com/apps/coderabbitai on `nekko-labs`.
3. Choose **Only select repositories** → `agent-nekko`. Inspect GitHub's current requested permissions before consenting. Do not grant unrelated private repository access.
4. Confirm the public repository receives the free open-source offering. Leave usage-based billing and paid agent/scan add-ons off; no credit card is required for basic onboarding.
5. After installation, verify a real review on the setup PR. If needed, comment `@coderabbitai review` and confirm actual findings/status rather than merely an installation badge. New draft PRs and pushes should be reviewed automatically.
6. Initially leave CodeRabbit advisory. Only consider a required review check after its exact check name, reliability, contributor/fork handling, and interaction with existing auto-merge have been verified.

Installation and a successful live review are not verified yet. The GitHub App requires interactive organization consent; a repository config alone does not install it.

### Data boundary

Hosted review sends repository code and relevant PR context to CodeRabbit according to its service/privacy terms. The requested repository is public, but PR metadata or comments can still contain sensitive information: never post secrets. Do not connect private repositories, MCP servers, account credentials, or additional integrations without separate approval. No repository secret or Actions token is added by this configuration.

## Complementary recommendations

Avoid stacking several general-purpose review bots; use one reviewer plus specialized checks.

| Tool | Why consider it | Relationship to this repo |
| --- | --- | --- |
| GitHub CodeQL + Dependabot | Security analysis and dependency alerts/updates; GitHub-native public-repo benefits | CodeQL is already running. Confirm Dependabot configuration/alerts before adding duplicate scanners. CodeQL's hosted benefits do not mean every component is open-source. |
| Renovate | Open-source dependency-update automation with grouping, schedules and monorepo controls | Strong alternative to Dependabot, not a second dependency bot to enable alongside it by default. |
| OpenSSF Scorecard | Open-source repository/supply-chain posture checks: permissions, pinned actions, branch protection, release practices | Useful periodic check; reports risks, not proof of exploitability. |
| Gitleaks | Open-source secret detection for commits/history | Useful dedicated gate; tune a baseline to prevent old findings from obscuring new leaks. |
| reviewdog | Open-source framework to post existing lint/static-analysis results as PR annotations | Adds precise feedback without an additional hosted model service; run fork-safe with read-only tokens where possible. |

No additional tool is installed by this change. Recommendation: CodeRabbit first, retain existing CodeQL, then evaluate Gitleaks and Scorecard based on gaps; select either Renovate or Dependabot for updates.

## Sources

Checked 2026-10-07:
- https://www.coderabbit.ai/pricing
- https://docs.coderabbit.ai/getting-started/quickstart
- https://docs.coderabbit.ai/reference/configuration
- https://coderabbit.ai/integrations/schema.v2.json
- https://github.com/renovatebot/renovate
- https://github.com/ossf/scorecard
- https://github.com/gitleaks/gitleaks
- https://github.com/reviewdog/reviewdog
