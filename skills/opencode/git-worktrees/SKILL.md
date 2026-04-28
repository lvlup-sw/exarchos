---
name: git-worktrees
description: "Git worktree management for parallel agent team development. Triggers: 'create worktree', 'worktree setup', or during /delegate dispatch. Do NOT use for branch creation without delegation context."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: utility
  phase-affinity: delegate
---

# Git Worktrees Skill

## Overview

Create and manage isolated git worktrees for parallel development tasks.

## Triggers

Activate this skill when:
- Multiple tasks can run in parallel
- User runs `/delegate` with parallelizable tasks
- Need isolated environment for subagent work
- User explicitly requests worktree setup

## Worktree Directory Location

**Priority Order:**
1. `.worktrees/` - If exists and gitignored
2. `worktrees/` - If exists and gitignored
3. Check `CLAUDE.md` for project conventions
4. Ask user if unclear

**Safety Check (REQUIRED):**
```bash
# Verify directory is gitignored before creating
git check-ignore -q .worktrees && echo "Safe" || echo "NOT GITIGNORED"
```

If not gitignored, add to `.gitignore`:
```
.worktrees/
```

## Worktree Lifecycle

### 1. Create Worktree

```bash
# Create feature branch
git branch feature/task-name main

# Create worktree
git worktree add .worktrees/task-name feature/task-name

# Verify creation
git worktree list
```

**Naming Convention:** `.worktrees/<task-id>-<brief-name>`
- Example: `.worktrees/001-user-auth`
- Example: `.worktrees/002-api-endpoints`

### 2. Setup Environment

See `references/commands-reference.md` for the full environment setup table and scripts per project type.

### 3. Baseline Verification

Run baseline tests to ensure the worktree is ready:

```typescript
exarchos_orchestrate({
  action: "verify_worktree_baseline",
  worktreePath: ".worktrees/task-name"
})
```

The script auto-detects project type (Node.js, .NET, Rust) and runs the appropriate test command.

**On `passed: true`:** Baseline tests pass — worktree is ready for implementation.
**On `passed: false`:** Baseline tests failed or unknown project type — investigate before proceeding.

If baseline fails:
1. Check if main branch has failing tests
2. Report issue to user
3. Do not proceed with implementation

### 4. Work in Worktree

Subagents work in worktree directory:
- Full isolation from other tasks
- Commits go to feature branch
- Can run tests independently

### 5. Cleanup After Merge

```bash
# After PR merged, remove worktree
git worktree remove .worktrees/task-name

# Optionally delete branch
git branch -d feature/task-name

# Prune stale worktree refs
git worktree prune
```

## Parallel Worktree Management

See `references/commands-reference.md` for parallel worktree creation examples, tracking format, and the full commands reference table.

## Worktree Validation

### Why Validate?

Subagents MUST verify they're in a worktree before making changes. Working in the main project root causes:
- Merge conflicts between parallel tasks
- Accidental changes to shared state
- Build/test interference

### Worktree Verification

Run the worktree verification script before any file modifications:

```typescript
exarchos_orchestrate({
  action: "verify_worktree"
})
```

To check a specific path instead of the current directory:

```typescript
exarchos_orchestrate({
  action: "verify_worktree",
  cwd: "/path/to/.worktrees/task-name"
})
```

**On `passed: true`:** In a valid worktree — proceed with implementation.
**On `passed: false`:** NOT in a worktree — STOP immediately, do not modify files.

### Subagent Instructions

Include in all implementer prompts:

```markdown
## CRITICAL: Worktree Verification (MANDATORY)

Before making ANY file changes, run:

    exarchos_orchestrate({ action: "verify_worktree" })

If `passed: false`: STOP and report error.
DO NOT proceed with any modifications outside a worktree.
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Create worktrees in tracked directory | Use gitignored `.worktrees/` |
| Skip baseline test verification | Always verify tests pass first |
| Leave stale worktrees | Clean up after merge |
| Forget dependency installation | Run project setup in each worktree |
| Mix work across worktrees | One task per worktree |

## Integration with Delegation

When delegation skill spawns parallel tasks:
1. Create worktree for each parallel group
2. Set up environment
3. Verify baseline tests
4. Dispatch subagent with worktree path
5. Track progress
6. Merge branches in dependency order
7. Clean up worktrees

## Merge-Pending Handoff

When a subagent completes a task in its worktree, the workflow's HSM transitions from `delegate` to `feature/merge-pending`. The `merge_orchestrate` action lands the worktree's branch onto the integration branch via a local `git merge` with a recorded rollback SHA — see `@skills/merge-orchestrator/SKILL.md` for the full handoff protocol.

Worktree cleanup (step 7 above) runs after the merge orchestrator reports `phase: 'completed'`.

This is **not** the same as the synthesize-phase remote PR merge (`merge_pr`). `merge_orchestrate` operates on local refs in the main worktree; `merge_pr` calls the VCS provider once the integration branch is ready for the human-review PR.

## Completion Criteria

For worktree setup:
- [ ] Directory is gitignored
- [ ] Worktree created successfully
- [ ] Environment dependencies installed
- [ ] Baseline tests pass
- [ ] Ready for subagent work

For worktree cleanup:
- [ ] Feature branch merged to main
- [ ] Worktree removed
- [ ] Branch deleted (if merged)
- [ ] Stale refs pruned
