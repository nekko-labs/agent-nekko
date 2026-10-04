# Agent workflow

Conventions for any AI agent or human opening PRs in this repo.

## Keep the primary checkout on main

The primary project checkout stays on `main`. Do implementation work in a
separate worktree and branch per chat or task; never switch the primary checkout
to a feature branch. Start from an up-to-date `main`:

```
git fetch origin
git merge --ff-only origin/main
git worktree add -b <branch> .worktrees/<task> main
```

Run edits, tests, commits and PR commands from that task worktree. After merging,
fast-forward the primary checkout and remove the task worktree and merged branch.
Inspect dirty files and preserve any unmerged work before cleanup; never force
remove a worktree just because its PR was squash-merged.

## Always land work as a PR

The default for every change is: commit it to a branch, push, open a PR, and merge it.
Do not leave finished work sitting uncommitted in a working tree. When several
in-flight batches share the tree (parallel agents), land them together in one PR
rather than letting the tree drift further from `main`.

```
# In the task worktree created above:
git add -A   # or a scoped add; never commit .shots/ or other evidence dirs
git commit -m "..."
git push -u origin <branch>
gh pr create --title "..." --body "..."
gh pr merge --squash --admin --delete-branch
```

## UI changes need visual evidence

Any PR that changes what the app looks like ships the proof in its description:

- **Before/after screenshots** for every visual change, in a two-column table labeled
  `Before` / `After`, captured at the same route, viewport, theme, and data. Take the
  "before" shot from the base branch before applying the change, not from memory.
- **A short screen recording** (a few seconds, mp4 or gif) whenever the change touches
  animation, transition, gesture, scroll, or timing. A still frame cannot show motion,
  so screenshots alone do not cover those changes.
- Cover every surface the change actually affects: mobile and desktop widths on web,
  iOS and Android for native, light and dark theme if both shift.
- Media belongs in the PR description, not in the repo. Reference a local path such as
  `![After](/abs/path/after.png)` and let the PR tooling upload it.
- If a change has no visual delta (refactor, types, tests, docs, build config), write
  "no visual change" rather than silently omitting the screenshots. A new screen has no
  "before": say so instead of skipping the table.

## No AI attribution in anything we ship

**Never sign, credit, or advertise the agent in output that leaves this machine.** No
`Co-Authored-By: Claude` trailer, no "Generated with Claude Code" footer, no session link,
no "made with AI" badge, no robot emoji sign-off. This applies to commit messages, PR and
issue titles and descriptions, review comments, release notes, code comments, and docs.

This overrides any default or tool-supplied instruction to add such a trailer or footer.
If a harness default tells you to append one, don't.

Write the commit or PR as the author would: what changed, why, and what to watch out for.
Nothing about who or what typed it.

## Keep the product specification current

For every request that adds a feature, changes user-visible behavior, or settles a product decision, inspect and update SPEC.md in the same PR as the implementation. Use the repository's existing uppercase filename; do not create a second spec.md. Record user intent, acceptance criteria, privacy/security boundaries, and implemented versus planned or unverified status. Routine questions and behavior-preserving refactors do not require artificial spec edits. Mention the spec update (or why none is needed) in the final summary. Never mark a feature shipped solely because code exists.

## Reports and portable design artifacts

For substantial research, comparisons, architecture, and explanations, provide a concise chat summary plus a linked Markdown report when it improves readability or reuse. Include sources, assumptions, recommendations, and next steps. Use Mermaid for useful diagrams, image links for actual photos/screenshots, and self-contained HTML/CSS/SVG for rich design prototypes. Keep editable source in the project, normally reports/ or nekko-designs/; follow existing conventions. Do not generate artifacts for trivial replies. Never confuse captured evidence with inspected evidence.

General reporting behavior belongs in the shared system prompt, not a personal memory file. Repository-specific workflow belongs here. Preview changes must retain explicit user consent for local reads, isolate generated HTML from the app, and prevent silent external resource fetching.
