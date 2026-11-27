# Worktree Enforcement (MANDATORY)

All implementation tasks MUST run in isolated worktrees, not the main project root. Each task of a prepared workflow runs in a linked worktree of its own. `settle` and `task_complete` refuse the checkout that `prepare` read and the primary worktree of the repository (`the-checkout`).

## Why Worktrees Are Required

- **Isolation:** Prevents merge conflicts between parallel tasks
- **Safety:** Protects main project state
- **Parallelism:** Enables multiple subagents to work simultaneously
- **Recovery:** Easy rollback via branch deletion

## Pre-Dispatch Checklist

Before dispatching ANY implementer, give the task a linked worktree from the
harness. Under native isolation the host makes it. Otherwise the coordinator
makes it with git, from the `baseCommit` of the task in the capsule, at the
canonical path. No Exarchos call makes the worktree:

```bash
git worktree add --detach .worktrees/<task-id>-<task-name> <baseCommit>
```

**The base of the task:** `<baseCommit>` is the `baseCommit` of the task in the
capsule, not a branch name, so the worktree never starts from a stale `main`.
The worktree is detached. The base step of the agent switches it to a branch of
its own at that commit, and settlement refuses a HEAD that does not hold it
(`base-not-held`). The native `worktree.baseRef:"head"` pin is not the base
guarantee: the base step of the agent gives the base on each runtime, and the
`base-not-held` rule of settlement enforces it. The base step is
`git switch -c <own branch> <baseCommit>` for an implementer or a scaffolder,
and the earlier branch of the task for a fixer. A compiler-8 dependent replaces
it with `git switch -c <own branch> <forkCommit>`, and it never resets to the
root base.

**Check before the dispatch:**
- `.worktrees/` is gitignored (add it to `.gitignore` if it is missing)
- `git worktree list` shows the worktree at `.worktrees/<task-id>-<task-name>`, detached at `<baseCommit>`
- The dependencies of the project are installed in the worktree, and a linked `node_modules` has the ignore rule `node_modules`
- The worktree is not the checkout that `prepare` read or the primary worktree of the repository

**When every check passes:** the worktree is ready. Proceed with implementer dispatch.

**When a check fails:** do not dispatch. Fix the failed step, or remove the
worktree with `git worktree remove` and add it again.

## Worktree State Tracking

Track worktrees in the workflow state file using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
- Set `worktrees.<worktree-id>` to an object containing `branch`, `status`, and either `taskId` (single task) or `tasks` (array of task IDs for multi-task worktrees)

## Implementer Prompt Requirements

Include in ALL implementer prompts:

1. **Absolute worktree path** as Working Directory
2. **Worktree verification block** (from implementer-prompt.md template)
3. **Abort instructions** if not in worktree
4. **The base commit of the task** (`<baseCommit>`) for the base step, in the place of the integration tip

## A Clean Worktree

Settlement refuses a claimed worktree whose `git status --porcelain` is not empty (`uncommitted-changes`). The ignore rules of git apply, and so does the exclude file of the common dir.

A `node_modules` that is a symbolic link needs an ignore rule without a trailing slash. The pattern `node_modules/` matches only a directory, so git lists the link as untracked. Add `node_modules` to `.gitignore`, or to the exclude file of the common dir (`.git/info/exclude`).

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
| Use default model for coding | Resolve the model tier from the capsule's risk tier (`agents.tier-models`) |
| Send sequential Task calls | Batch parallel tasks in one message |
| Skip worktree for parallel work | Create isolated worktrees |
| Forget to track in TodoWrite | Update status for every task |
| Skip TDD requirements | Include TDD instructions in prompt |
