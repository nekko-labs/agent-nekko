---
name: verify-agent-work
description: Check an AI agent's finished work against its own report. Finds the agent's branch or worktree, compares every claim in the report with the actual commits and diff, re-runs the project's checks, and lists what is confirmed, wrong or unverifiable. Use when an agent says a task is done, before merging its branch or opening a pull request from it.
---

# Verify an agent's work

An agent's report says what it believes it did. Your job is to find out what it actually did. Trust the repository, not the report.

You are read-only. Do not edit files, commit, push, merge, open pull requests, or delete worktrees or branches, even to fix something you find. Building and running tests is allowed. Report problems; do not repair them.

Do not move anyone's checkout either: no `git checkout`, `git switch` or `git reset` in the primary checkout or in a worktree you did not create, and no new branches. To look at another revision, use `git show`, `git diff` or `git log`. If you must build or test a revision that has no worktree, create a temporary detached worktree of your own (`git worktree add --detach <path> <commit>`), and remove it when you are done.

## Inputs

Ask for anything missing before starting, in a single question:

1. **The report** the agent wrote (pasted text or a file).
2. **Where the work is**: a branch name, a worktree path, or enough to find it (for example "the most recent agent branch").
3. **Optional: the brief** the agent was given. With it, also check the work against each requirement.

## 1. Locate the work

```
git worktree list
git branch --list
```

Identify the agent's branch and, if it has one, its worktree folder. Then find the base it started from:

```
git merge-base <base-branch> <agent-branch>
```

Use `main` as the base branch unless the report or brief names another. If the agent branched from another feature branch, use that one; otherwise the diff will include someone else's work. State which base you used.

## 2. Collect the facts

Run these against the agent's branch (use `git -C <worktree>` for the worktree-specific ones):

```
git log --oneline <base>..<agent-branch>
git diff --stat <base>..<agent-branch>
git -C <worktree> status --short
git --no-pager diff <base>..<agent-branch>
```

Note: commits made, files changed, uncommitted changes left behind, untracked files. Check whether the branch was pushed (`git branch -r --contains <agent-branch>` or `git status -sb` in the worktree) and, if the `gh` CLI is available, whether a pull request exists (`gh pr list --head <agent-branch>`).

## 3. List the claims

Go through the report and write down every concrete, checkable claim, one per line. Typical claims:

- files changed and what changed in each;
- bugs fixed and how;
- tests added, removed, or updated, by name;
- check results ("typecheck passes", "all tests pass except X");
- statements about state ("nothing pushed", "no PR opened", "committed in N commits");
- visual or manual checks ("screenshots captured", "verified in the app").

Skip opinions and plans; keep only what can be true or false.

## 4. Check each claim against the evidence

For each claim, find the evidence in the diff, the repository, or a command you run:

- **Files and changes**: does the diff touch those files, and does the code do what the report says? Read the code, not only the file list.
- **Tests**: does each named test exist? Does it assert the behaviour it claims to cover? Watch for tests that cannot fail (asserting a handler was *not* called, checking only that text renders), comments that contradict what the framework does, and imports that are never used.
- **Logic**: look for code that cannot work as described, for example a measurement taken during render when the element does not exist yet, state that never updates, or a fallback that hides the real behaviour.
- **Requirements** (if you have the brief): is each one met, partly met, or ignored? Did the agent do things the brief forbade?
- **Side effects**: unrelated files touched, dependency or lockfile changes, attribution trailers in commit messages, files the brief said not to commit.
- **Process**: where the agent worked (its own branch, or directly in the primary checkout or on `main`), whether it committed as the brief asked, whether it pushed or opened anything it was told not to. Report every breach, even when someone has since repaired it.

## 5. Re-run the checks

Find the project's verification commands in `AGENTS.md`, `CONTRIBUTING.md` or `package.json` (or the equivalent for the project's language) and run them in the agent's worktree, or in a checkout of its branch.

Before trusting a failure, make sure the environment is complete. A fresh worktree often lacks installed dependencies or built internal packages, which produces errors that have nothing to do with the change. Install and build first, as the project's docs describe. If test files still fail to load because an internal package is not built (errors like "Cannot find package" or "Failed to resolve entry" for a package of the same repository), build that package and run the tests again, so the report covers every test rather than only the ones that loaded.

If something fails, check whether it also fails on the base branch before blaming the change. Record the exact commands you ran and their results.

## 6. Report

Two rules before you write it:

- **Judge against the brief, never against the report.** A problem does not become intentional because the report or the commit describes it. If the brief asked for one thing and the change does another, that is a problem, whatever the agent said about it.
- **Answer every specific point the user asked you to check**, each one explicitly, even when the answer is "no problem". Do not leave any out.

Use this structure:

**Verdict**: one of *Matches the report*, *Mostly matches, with problems*, or *Does not match the report*, followed by one sentence explaining why.

**Claims**

| Claim | Evidence | Status |
| --- | --- | --- |
| … | file, line, command or test name | Confirmed / Partly true / Wrong / Unverifiable |

Use *Unverifiable* for anything you cannot check from the repository, such as screenshots nobody inspected or manual tests in an app. Never mark those confirmed.

**Problems the report did not mention**: bugs, weak or useless tests, accessibility or security regressions, forbidden changes. Give file and line, and why it matters.

**Checks**: each command you ran and its result, and which failures also happen on the base branch.

**Recommendation**: one of *ready to merge as is*, *merge after these fixes* (list them), or *redo* (say why). Do not apply the fixes yourself. Every fix you suggest must respect the brief's constraints and fit what the project already uses: check the existing setup (test environment, dependencies, conventions) before proposing a new tool or library, and if a proper fix would need one the brief forbids, say so instead of recommending it.
