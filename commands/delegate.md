---
description: Dispatch tasks to Claude Code subagents
---

# Delegate

Delegate tasks for: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
                                 ▲▲▲▲▲▲▲▲                                │
                                    │                                    │
                      ON FAIL ──────┤                                    │
                      --pr-fixes ───┴────────────────────────────────────┘
```

Auto-invokes `/review` after tasks complete (or `/synthesize` for `--pr-fixes` mode).

## Invocation Modes

| Flag | Source | Use Case |
|------|--------|----------|
| (none) | Implementation plan | Initial task delegation |
| `--fixes` | Review issues | Address spec/quality failures |
| `--pr-fixes` | PR comments | Address human review feedback |

## Skill References

Follow the delegation skill for full process details: `@skills/delegation/SKILL.md`

Supporting references:
- Git worktrees: `@skills/git-worktrees/SKILL.md`
- Implementer template: `@skills/delegation/references/implementer-prompt.md`
- Fixer template: `@skills/delegation/references/fixer-prompt.md`
- Fix mode: `@skills/delegation/references/fix-mode.md`
- PR fixes mode: `@skills/delegation/references/pr-fixes-mode.md`
- Parallel strategy: `@skills/delegation/references/parallel-strategy.md`

## Idempotency

Before delegating, check task status:
1. Read tasks from state file
2. Skip tasks where `status == "complete"`
3. Only dispatch pending/failed tasks
4. If all tasks already complete, skip to auto-chain

## Auto-Chain

After all delegated tasks complete, **auto-continue immediately** (no user confirmation needed).

- **Normal / --fixes mode:** Set phase to "review", invoke `Skill({ skill: "review", args: "$STATE_FILE" })`
- **--pr-fixes mode:** Set phase to "synthesize", invoke `Skill({ skill: "synthesize", args: "$PR_URL" })`

This is NOT a human checkpoint. State is saved automatically for recovery after context compaction.
