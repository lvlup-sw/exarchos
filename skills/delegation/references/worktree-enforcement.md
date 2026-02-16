---
name: worktree-enforcement
---

# Worktree Enforcement (MANDATORY)

All implementation tasks MUST run in isolated worktrees, not the main project root.

## Why Worktrees Are Required

- **Isolation:** Prevents merge conflicts between parallel tasks
- **Safety:** Protects main project state
- **Parallelism:** Enables multiple subagents to work simultaneously
- **Recovery:** Easy rollback via branch deletion

## Pre-Dispatch Checklist

Before dispatching ANY implementer, run the worktree setup script:

```bash
bash scripts/setup-worktree.sh \
  --repo-root <project-root> \
  --task-id <task-id> \
  --task-name <task-name> \
  [--base-branch main] \
  [--skip-tests]
```

**Validates:**
- `.worktrees/` is gitignored (adds to `.gitignore` if missing)
- Feature branch created (`feature/<task-id>-<task-name>` from base branch)
- Git worktree added at `.worktrees/<task-id>-<task-name>`
- `npm install` ran in worktree
- Baseline tests pass in worktree

**On exit 0:** Worktree is ready. Proceed with implementer dispatch.

**On exit 1:** Setup failed. Review the markdown checklist output for which step failed. Fix the issue before dispatching.

**On exit 2:** Usage error. Check required arguments: `--repo-root`, `--task-id`, `--task-name`.

## Worktree State Tracking

Track worktrees in the workflow state file using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Set `worktrees.<worktree-id>` to an object containing `branch`, `status`, and either `taskId` (single task) or `tasks` (array of task IDs for multi-task worktrees)

## Implementer Prompt Requirements

Include in ALL implementer prompts:

1. **Absolute worktree path** as Working Directory
2. **Worktree verification block** (from implementer-prompt.md template)
3. **Abort instructions** if not in worktree

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Make subagents read plan files | Provide full task text in prompt |
| Use default model for coding | Specify `model: "opus"` |
| Send sequential Task calls | Batch parallel tasks in one message |
| Skip worktree for parallel work | Create isolated worktrees |
| Forget to track in TodoWrite | Update status for every task |
| Skip TDD requirements | Include TDD instructions in prompt |
