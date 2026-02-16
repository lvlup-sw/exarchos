---
name: delegation
description: "Dispatch implementation tasks to agent teammates in git worktrees. Use when the user says 'delegate', 'dispatch tasks', 'assign work', 'delegate tasks', or runs /delegate. Spawns teammates, creates worktrees, monitors progress, and collects results. Supports --fixes flag for review finding remediation. Do NOT use for single-file changes or polish-track refactors."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: delegate
---

# Delegation Skill

## Overview

Dispatch implementation tasks to Claude Code subagents with proper context and TDD requirements.

## Triggers

Activate this skill when:
- User runs `/delegate` command
- Implementation plan is ready
- User wants to parallelize work
- Tasks are ready for execution

## Delegation Mode

### Task Tool (Subagents)

**Use when:**
- Need immediate results
- Task requires orchestrator coordination
- Want in-session execution
- Working in worktrees

**Tool:** Claude Code `Task` tool with `model: "opus"`

**CRITICAL:** Always specify `model: "opus"` for coding tasks to use Opus 4.5.

```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED for coding
  description: "Implement user model",
  prompt: `[Full implementer prompt from template]`
})
```

## Controller Responsibilities

The orchestrator (you) MUST:

1. **Extract tasks upfront** - Read plan, extract all task details
2. **Provide full context** - Never make subagents read files for task info
3. **Include TDD requirements** - Use implementer prompt template
4. **Track progress** - Use TodoWrite for all tasks
5. **Set up worktrees** - For parallel execution

## Implementer Prompt Template

Use `@skills/delegation/references/implementer-prompt.md` as template for Task tool prompts.

**Key sections:**
- Task description (full text, not file references)
- File paths to modify
- Test requirements (TDD phases)
- Success criteria
- Working directory (worktree path)

## Delegation Workflow

### Step 1: Prepare Environment

For parallel tasks, create worktrees:
```bash
git worktree add .worktrees/task-001 feature/task-001
cd .worktrees/task-001 && npm install
```

### Step 2: Extract Task Details

From implementation plan, extract for each task:
- Full task description
- Files to create/modify
- Test file paths
- Expected test names
- Dependencies

### Step 3: Create TodoWrite Entries

Track all delegated tasks:
```typescript
TodoWrite({
  todos: [
    { content: "Task 001: User model", status: "in_progress", activeForm: "Implementing user model" },
    { content: "Task 002: Auth endpoints", status: "pending", activeForm: "Implementing auth endpoints" }
  ]
})
```

### Step 4: Dispatch Implementers

**Parallel dispatch:**
```typescript
// Launch multiple in single message for parallel execution
Task({
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  description: "Implement task 001",
  prompt: "[Full implementer prompt]"
})

Task({
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  description: "Implement task 002",
  prompt: "[Full implementer prompt]"
})
```

### Step 5: Monitor Progress

For background tasks:
```typescript
TaskOutput({ task_id: "task-001-id", block: true })
```

### Step 6: Collect Results

When tasks complete, run the post-delegation check:

```bash
bash scripts/post-delegation-check.sh \
  --state-file <path-to-state.json> \
  --repo-root <project-root> \
  [--skip-tests]
```

**Validates:**
- State file exists and is valid JSON
- Tasks array has entries
- All tasks report "complete" status
- Per-worktree test runs pass (unless `--skip-tests`)
- State file consistency (all tasks have id and status fields)

**On exit 0:** All delegation results collected and verified. Update TodoWrite status, then check if schema sync is needed (Step 7) and proceed to review phase.

**On exit 1:** Failures detected. Review the per-task status report. Address incomplete tasks or failing tests before proceeding.

### Step 7: Schema Sync (Auto-Detection)

After all tasks complete, check for modified API files (`*Endpoints.cs`, `Models/*.cs`, `Requests/*.cs`, `Responses/*.cs`, `Dtos/*.cs`). If found, run `npm run sync:schemas` and commit via Graphite. See `@skills/sync-schemas/SKILL.md`.

## Parallel Execution Strategy

Dispatch parallel tasks in a single message with multiple Task calls. See `@skills/delegation/references/parallel-strategy.md` for group identification, dispatching patterns, and model selection.

## Worktree Enforcement (MANDATORY)

All implementation tasks MUST run in isolated worktrees, not the main project root.

### Why Worktrees Are Required

- **Isolation:** Prevents merge conflicts between parallel tasks
- **Safety:** Protects main project state
- **Parallelism:** Enables multiple subagents to work simultaneously
- **Recovery:** Easy rollback via branch deletion

### Pre-Dispatch Checklist

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

### Worktree State Tracking

Track worktrees in the workflow state file using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Set `worktrees.<worktree-id>` to an object containing `branch`, `status`, and either `taskId` (single task) or `tasks` (array of task IDs for multi-task worktrees)

### Implementer Prompt Requirements

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

## State Management

This skill tracks task progress in workflow state for context persistence.

### Read Tasks from State

Instead of re-parsing plan, read task list using `mcp__exarchos__exarchos_workflow` with `action: "get"` with `query: "tasks"`. For status checks during monitoring, use `fields: ["tasks"]` to reduce response size.

### On Task Dispatch

Update task status when dispatched using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Update the task's status to "in_progress"
- Set the task's startedAt timestamp

If creating worktree, also set the worktree entry with branch, status, and either taskId (single task) or tasks (multi-task).

### On Task Complete

Update task status when subagent reports completion using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Update the task's status to "complete"
- Set the task's completedAt timestamp

### On All Tasks Complete

Update phase using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Set `phase` to "review"

## Fix Mode (--fixes)

When invoked with `--fixes`, delegation handles review failures instead of initial implementation. Uses fixer-prompt template, dispatches fix tasks per issue, then re-invokes review.

For detailed fix mode process, task structure, and transition flow, see `@skills/delegation/references/fix-mode.md`.

## Completion Criteria

- [ ] All tasks extracted from plan (or read from state)
- [ ] Worktrees created for parallel groups
- [ ] State file updated with worktree locations
- [ ] TodoWrite updated with all tasks
- [ ] Implementers dispatched with full context
- [ ] All tasks report completion
- [ ] All tests pass in worktrees
- [ ] Schema sync run if API files modified
- [ ] State file reflects all task completions

## Transition

After all tasks complete, **auto-continue immediately** (no user confirmation):

1. Update state: `.phase = "review"`, mark all tasks complete
2. Output: "All [N] tasks complete. Auto-continuing to review..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "review", args: "<plan-path>" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.
State is saved, enabling recovery after context compaction.

## Troubleshooting

See `@skills/delegation/references/troubleshooting.md` for detailed troubleshooting covering MCP tool failures, state desync, worktree creation, teammate spawn timeouts, and task claim conflicts.

## Exarchos Integration

Emit events at each delegation milestone using Exarchos MCP tools:

1. **Delegation start:** `exarchos_event` append `workflow.started` (if not already emitted)
2. **Task dispatch:** Launch subagents via Claude Code `Task` tool. Inter-agent messaging uses Claude Code's native Agent Teams (not Exarchos)
3. **Task assignment:** `exarchos_event` append `task.assigned` with taskId, title, branch, worktree
4. **Monitor:** `exarchos_view` `workflow_status` or `exarchos_workflow` `get` with `fields: ["tasks"]`
5. **Task completion:** Record stack positions via `exarchos_view` `stack_place`. Subagents handle Graphite stacking via `gt create`
6. **All complete:** Auto-emitted by `exarchos_workflow` `set` when phase transitions — emits `workflow.transition` from delegate to next phase

### Claim Guard

Use `exarchos_orchestrate` `task_claim` for optimistic concurrency. On `ALREADY_CLAIMED`, skip the task and check status via `exarchos_view` `tasks` before re-dispatching.
