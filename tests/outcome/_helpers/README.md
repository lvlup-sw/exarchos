# tests/outcome/_helpers

Helpers for the outcome-test tier. Each helper sets up real OS state (tmpdir, real git) for tests that verify operator-visible behavior, not algorithm equivalence.

- `tmp-home.ts` — `withTmpHome` isolates `HOME` to a tmpdir for the callback's duration.
- `tmp-git.ts` — `withTmpGit` + `addSiblingWorktree` spin up real git repos with optional sibling-worktree topology.

This README is expanded by Phase D (T-019) into a full operator guide. Do not edit; that task replaces this file.
