# Delegation Skill

## Overview

Dispatch implementation tasks to Jules (async) or Claude Code subagents (sync) with proper context and TDD requirements.

## Triggers

Activate this skill when:
- User runs `/delegate` command
- Implementation plan is ready
- User wants to parallelize work
- Tasks are ready for execution

## Delegation Modes

### Mode 1: Jules (Async PRs)

**Use when:**
- Task is self-contained
- Can wait for async completion
- Want automatic PR creation
- Delegating to external agent

**Tool:** `jules_create_task` MCP tool

**TDD is auto-injected** by the Jules MCP plugin.

```typescript
// Example via MCP tool
jules_create_task({
  repo: "owner/repo",
  prompt: "Implement user authentication...",
  branch: "feature/auth"
})
```

### Mode 2: Task Tool (Sync Subagents)

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

**For Jules:**
```typescript
jules_create_task({
  repo: "owner/repo",
  prompt: "[Task details + TDD auto-injected]",
  branch: "feature/task-name"
})
```

**For Task Tool (parallel):**
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

For Jules:
```typescript
jules_check_status({ sessionId: "session-id" })
```

### Step 6: Collect Results

When tasks complete:
1. Verify all tests pass
2. Update TodoWrite status
3. Proceed to review phase

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

Instead of re-parsing plan, read task list from state:

```bash
~/.claude/scripts/workflow-state.sh get docs/workflow-state/<feature>.state.json '.tasks'
```

### On Task Dispatch

Update task status when dispatched:

```bash
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '(.tasks[] | select(.id == "001")).status = "in_progress" | (.tasks[] | select(.id == "001")).startedAt = "2026-01-05T10:00:00Z"'
```

If creating worktree:

```bash
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.worktrees[".worktrees/001-name"] = {"branch": "feature/001-name", "taskId": "001", "status": "active"}'
```

### On Task Complete

Update task status when subagent reports completion:

```bash
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '(.tasks[] | select(.id == "001")).status = "complete" | (.tasks[] | select(.id == "001")).completedAt = "2026-01-05T10:30:00Z"'
```

### On All Tasks Complete

Update phase and suggest checkpoint:

```bash
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json '.phase = "review"'
```

## Completion Criteria

- [ ] All tasks extracted from plan (or read from state)
- [ ] Worktrees created for parallel groups
- [ ] State file updated with worktree locations
- [ ] TodoWrite updated with all tasks
- [ ] Implementers dispatched with full context
- [ ] All tasks report completion
- [ ] All tests pass in worktrees
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
