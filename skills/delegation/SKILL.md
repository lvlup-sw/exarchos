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

After all tasks complete, run the schema sync detection script:

```bash
bash scripts/needs-schema-sync.sh \
  --repo-root <project-root> \
  [--base-branch main] \
  [--diff-file <path-to-diff>]
```

**Validates:** Git diff for API file patterns that trigger schema regeneration:
- `*Endpoints.cs`
- `Models/*.cs`
- `Requests/*.cs`
- `Responses/*.cs`
- `Dtos/*.cs`

**On exit 0:** No sync needed. No API files were modified. Proceed to review phase.

**On exit 1:** Sync needed. The output lists modified API files. Run schema sync:

```bash
# Run schema sync from monorepo root
npm run sync:schemas

# Verify types
npm run typecheck

# Stage and commit via Graphite
git add shared/types/src/generated/ shared/validation/src/generated/ apps/ares-elite-web/src/api/generated/
gt create chore/schema-sync -m "chore: regenerate TypeScript types from OpenAPI"
gt submit --no-interactive --publish
```

**NEVER use `git commit` or `git push`** — always use `gt create` and `gt submit`.

**Skill Reference:** `@skills/sync-schemas/SKILL.md`

## Parallel Execution Strategy

### Identifying Parallel Groups

From implementation plan:
```markdown
## Parallel Groups

Group A (can run simultaneously):
- Task 001: Types
- Task 002: Interfaces

Group B (depends on Group A):
- Task 003: Implementation
- Task 004: API handlers
```

### Dispatching Parallel Tasks

**Critical:** Use single message with multiple Task calls:

```typescript
// CORRECT: Single message, parallel execution
Task({ model: "opus", description: "Task 001", prompt: "..." })
Task({ model: "opus", description: "Task 002", prompt: "..." })

// WRONG: Separate messages = sequential
```

### Waiting for Parallel Completion

```typescript
// Wait for all background tasks
TaskOutput({ task_id: "task-001-id" })
TaskOutput({ task_id: "task-002-id" })
```

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

## Model Selection Guide

| Task Type | Model | Reason |
|-----------|-------|--------|
| Code implementation | `opus` | Best quality for coding |
| Code review | `opus` | Thorough analysis |
| File search/exploration | (default) | Speed over quality |
| Simple queries | `haiku` | Fast, low cost |

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

When invoked with `--fixes`, delegation handles review failures instead of initial implementation.

### Trigger

```bash
/delegate --fixes docs/plans/YYYY-MM-DD-feature.md
```

Or auto-invoked after review failures.

### Fix Mode Process

1. **Read failure details** from state using `mcp__exarchos__exarchos_workflow` with `action: "get"`:
   - Query `reviews` for review failures

2. **Extract fix tasks** using the extraction script:

   ```bash
   bash scripts/extract-fix-tasks.sh \
     --state-file <path-to-state.json> \
     [--review-report <path-to-report.json>] \
     [--repo-root <project-root>]
   ```

   **Validates:**
   - Findings parsed from state file reviews (or external report file)
   - Each finding mapped to file path and line number
   - File-to-worktree ownership determined from task worktree assignments

   **On exit 0:** Outputs JSON array of fix tasks with fields: `id`, `file`, `line`, `worktree`, `description`, `severity`. Use this output to create fix task dispatches.

   **On exit 1:** Parse error. Check that the state file or review report contains valid JSON with the expected structure.

3. **Create fix tasks** for each extracted issue:
   - Use `fixer-prompt.md` template
   - Include full issue context from the extracted JSON
   - Specify target worktree from the extraction output

4. **Dispatch fixers** (same as implementers, different prompt):
   ```typescript
   Task({
     subagent_type: "general-purpose",
     model: "opus",
     description: "Fix: [issue summary]",
     prompt: "[fixer-prompt template with issue details]"
   })
   ```

5. **Re-review after fixes**:
   After all fix tasks complete, auto-invoke review phase:
   ```typescript
   Skill({ skill: "review", args: "<state-file>" })
   ```

### Fix Task Structure

Each fix task extracted should include:

| Field | Description |
|-------|-------------|
| issue | Problem description from review |
| file | File path needing fix |
| line | Line number (if known) |
| worktree | Which worktree to fix in |
| branch | Which branch owns this fix |
| priority | HIGH / MEDIUM / LOW |

### Transition After Fixes

Fix mode goes back to the integration phase after fixes are applied,
then re-enters review to re-integrate and re-verify:

```text
/delegate --fixes -> [fixes applied] -> re-integrate -> /review
```

This ensures fixed code is re-verified.

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

When Exarchos MCP tools are available, emit events during delegation:

1. **At delegation start:** Call `mcp__exarchos__exarchos_event` with `action: "append"` with event type `workflow.started` (if not already emitted for this workflow)
2. **After team composition:** Call `mcp__exarchos__exarchos_event` with `action: "append"` with event type `team.formed` including teammates array
3. **For each task dispatch:** Use `mcp__exarchos__exarchos_orchestrate` with `action: "team_spawn"` to register the agent with the team coordinator, then use the Task tool to launch the subagent. `team_spawn` handles role assignment, event emission, and health tracking; the Task tool handles actual subprocess execution. Both are always used together — `team_spawn` does not replace the Task tool
4. **For each task assignment:** Call `mcp__exarchos__exarchos_event` with `action: "append"` with event type `task.assigned` including taskId, title, branch, worktree
5. **Monitor progress:** Use `mcp__exarchos__exarchos_view` with `action: "workflow_status"` to check task completion status. For lightweight checks, use `mcp__exarchos__exarchos_workflow` with `action: "get"` with `fields: ["tasks"]`
6. **On task completion — Graphite stacking:**
   Subagents handle stacking directly using `gt create` (per implementer prompt template).
   When a multi-task agent completes, it will have created a Graphite stack with one branch per logical review unit.
   The orchestrator should:
   - Call `mcp__exarchos__exarchos_view` with `action: "stack_place"` with position, taskId, and branch to record each stack position
   - Verify the stack was submitted by checking for PRs: `mcp__graphite__run_gt_cmd({ args: ["--no-interactive", "ls"], cwd: "<worktree-path>" })`
7. **On all tasks complete:** Call `mcp__exarchos__exarchos_event` with `action: "append"` with event type `phase.transitioned` from delegate to next phase

### Claim Guard

Use `mcp__exarchos__exarchos_orchestrate` with `action: "task_claim"` to claim tasks. This action prevents double-claims via optimistic concurrency. If an agent receives an `ALREADY_CLAIMED` error, another agent already claimed that task. The orchestrator should:
- Skip the task (it's being handled)
- Check task status via `mcp__exarchos__exarchos_view` with `action: "tasks"` with `filter: { "taskId": "<id>" }` before re-dispatching

## Performance Notes

- Complete each step fully before advancing — quality over speed
- Do not skip validation checks even when the change appears trivial
- Verify each task dispatch before proceeding to next. Do not batch dispatches without confirming worktree readiness.
