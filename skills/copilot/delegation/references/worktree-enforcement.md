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

```typescript
exarchos_orchestrate({
  action: "setup_worktree",
  repoRoot: "<project-root>",
  taskId: "<task-id>",
  taskName: "<task-name>"
})
```

**Validates:**
- `.worktrees/` is gitignored (adds to `.gitignore` if missing)
- Feature branch created (`feature/<task-id>-<task-name>` from base branch)
- Git worktree added at `.worktrees/<task-id>-<task-name>`
- `npm install` ran in worktree
- Baseline tests pass in worktree

**On `passed: true`:** Worktree is ready. Proceed with implementer dispatch.

**On `passed: false`:** Setup failed. Review the checklist output for which step failed. Fix the issue before dispatching.

## Worktree State Tracking

Track worktrees in the workflow state file using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "set"`:
- Set `worktrees.<worktree-id>` to an object containing `branch`, `status`, and either `taskId` (single task) or `tasks` (array of task IDs for multi-task worktrees)

## Implementer Prompt Requirements

Include in ALL implementer prompts:

1. **Absolute worktree path** as Working Directory
2. **Worktree verification block** (from implementer-prompt.md template)
3. **Abort instructions** if not in worktree

## Native Worktree Isolation

When the `exarchos-implementer` agent definition includes `isolation: worktree` in its frontmatter, Claude Code handles worktree creation natively. The `prepare_delegation` action accepts `nativeIsolation: true` to skip manual worktree creation while preserving quality pre-checks. The worktree verification in the agent system prompt remains as defense-in-depth.

When using native isolation:
- Claude Code creates and manages the worktree lifecycle
- The `prepare_delegation` action skips `setup-worktree.sh` but still validates state, checks quality signals, and detects benchmarks
- The worktree verification block in the implementer prompt acts as a safety net — if native isolation fails silently, the agent self-aborts rather than modifying the main project root

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Make subagents read plan files | Provide full task text in prompt |
| Use default model for coding | Specify `model: "opus"` |
| Send sequential Task calls | Batch parallel tasks in one message |
| Skip worktree for parallel work | Create isolated worktrees |
| Forget to track in TodoWrite | Update status for every task |
| Skip TDD requirements | Include TDD instructions in prompt |
