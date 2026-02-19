---
name: git-worktrees
description: "Git worktree management for parallel development in agent team workflows. Use when creating worktrees, validating worktree paths, or setting up isolated development environments. Trigger: \"create worktree\", \"worktree setup\", or during /delegate task dispatch. Do NOT use for branch creation without delegation context."
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
- User runs `/exarchos:delegate` with parallelizable tasks
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

**Auto-detect project type and run setup:**

| Indicator | Setup Command |
|-----------|---------------|
| `package.json` | `npm install` or `pnpm install` |
| `Cargo.toml` | `cargo build` |
| `requirements.txt` | `pip install -r requirements.txt` |
| `*.csproj` | `dotnet restore` |
| `go.mod` | `go mod download` |

**Setup Script:**
```bash
cd .worktrees/task-name

# Node.js
if [ -f "package.json" ]; then
  npm install
fi

# .NET
if ls *.csproj 1> /dev/null 2>&1; then
  dotnet restore
fi

# Rust
if [ -f "Cargo.toml" ]; then
  cargo build
fi
```

### 3. Baseline Verification

Run baseline tests to ensure the worktree is ready:

```bash
scripts/verify-worktree-baseline.sh --worktree-path .worktrees/task-name
```

The script auto-detects project type (Node.js, .NET, Rust) and runs the appropriate test command.

**On exit 0:** Baseline tests pass — worktree is ready for implementation.
**On exit 1:** Baseline tests failed — investigate before proceeding.
**On exit 2:** Unknown project type — manual verification required.

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

### Creating Multiple Worktrees

For parallel task groups from implementation plan:

```bash
# Group 1 tasks
git worktree add .worktrees/001-types feature/001-types
git worktree add .worktrees/002-tests feature/002-tests

# Group 2 tasks (parallel to Group 1)
git worktree add .worktrees/003-api feature/003-api
git worktree add .worktrees/004-handlers feature/004-handlers
```

### Tracking Active Worktrees

Maintain awareness of active worktrees:
```bash
git worktree list
```

Report format:
```markdown
## Active Worktrees

| Task | Branch | Status |
|------|--------|--------|
| 001-types | feature/001-types | In Progress |
| 002-tests | feature/002-tests | Complete |
| 003-api | feature/003-api | In Progress |
```

## Worktree Commands Reference

| Action | Command |
|--------|---------|
| List worktrees | `git worktree list` |
| Add worktree | `git worktree add <path> <branch>` |
| Remove worktree | `git worktree remove <path>` |
| Prune stale refs | `git worktree prune` |
| Lock (prevent removal) | `git worktree lock <path>` |
| Unlock | `git worktree unlock <path>` |

## Worktree Validation

### Why Validate?

Subagents MUST verify they're in a worktree before making changes. Working in the main project root causes:
- Merge conflicts between parallel tasks
- Accidental changes to shared state
- Build/test interference

### Worktree Verification

Run the worktree verification script before any file modifications:

```bash
scripts/verify-worktree.sh
```

To check a specific path instead of the current directory:

```bash
scripts/verify-worktree.sh --cwd /path/to/.worktrees/task-name
```

**On exit 0:** In a valid worktree — proceed with implementation.
**On exit 1:** NOT in a worktree — STOP immediately, do not modify files.

### Subagent Instructions

Include in all implementer prompts:

```markdown
## CRITICAL: Worktree Verification (MANDATORY)

Before making ANY file changes, run:

    scripts/verify-worktree.sh

If exit code is non-zero: STOP and report error.
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
