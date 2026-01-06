---
name: delegation
description: "Dispatch implementation tasks to implementer agents or Copilot coding agent. Activates when implementation plan is ready, user runs /delegate, or tasks are ready for execution."
---

# Delegation Skill

## Overview

Dispatch implementation tasks to implementer agents (sync) or Copilot coding agent (async PRs) with proper context and TDD requirements.

## Triggers

Activate this skill when:
- User runs `/delegate` command
- Implementation plan is ready
- User wants to parallelize work
- Tasks are ready for execution

## Delegation Modes

### Mode 1: Copilot Coding Agent (Async PRs)

**Use when:**
- Task is self-contained
- Can wait for async completion
- Want automatic PR creation
- Delegating to GitHub's infrastructure

**Command:** `/delegate`

```
/delegate Implement user authentication with email/password login.
Include unit tests following TDD. Create login endpoint at POST /api/auth/login.
```

The coding agent will:
- Create a draft PR
- Implement with full context
- Run in GitHub's infrastructure

### Mode 2: Custom Implementer Agent (Sync)

**Use when:**
- Need immediate results
- Task requires orchestrator coordination
- Want in-session execution
- Working in worktrees

**Command:** `/agent implementer`

```
/agent implementer

## Task: Implement User Model

### Description
Create the User model with email validation and password hashing.

### Files to Modify
- src/models/user.ts (create)
- src/models/user.test.ts (create)

### TDD Requirements
1. [RED] Write test: CreateUser_ValidInput_ReturnsUserId
2. [GREEN] Implement User class with create() method
3. [REFACTOR] Extract validation to separate function

### Working Directory
.worktrees/001-user-model

### Success Criteria
- All tests pass
- Coverage >80%
- No lint errors
```

## Orchestrator Responsibilities

As orchestrator, you MUST:

1. **Extract tasks upfront** - Read plan, extract all task details
2. **Provide full context** - Never make agents read files for task info
3. **Include TDD requirements** - Every task starts with failing test
4. **Track progress** - Use todo tool for all tasks
5. **Set up worktrees** - For parallel execution

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

### Step 3: Track Tasks

Use the todo tool to track all delegated tasks:
```
Add todo: "Task 001: User model" (in_progress)
Add todo: "Task 002: Auth endpoints" (pending)
```

### Step 4: Dispatch Implementers

**For async (Copilot coding agent):**
```
/delegate Implement Task 001: User model with email validation...
```

**For sync (custom agent):**
```
/agent implementer

[Full task context as shown in Mode 2 above]
```

### Step 5: Monitor Progress

For `/delegate` tasks:
- Check PR status on GitHub
- Review when draft is ready

For `/agent` tasks:
- Agent completes in session
- Results returned immediately

### Step 6: Collect Results

When tasks complete:
1. Verify all tests pass
2. Update todo status to complete
3. Proceed to integration phase

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

For sync agents, dispatch sequentially but work in separate worktrees:
```
/agent implementer
[Task 001 in .worktrees/001-types]
```

Then:
```
/agent implementer
[Task 002 in .worktrees/002-interfaces]
```

For async, use multiple `/delegate` commands - they run in parallel on GitHub.

## Worktree Enforcement (MANDATORY)

All implementation tasks MUST run in isolated worktrees.

### Why Worktrees Are Required

- **Isolation:** Prevents merge conflicts between parallel tasks
- **Safety:** Protects main project state
- **Parallelism:** Enables multiple agents to work simultaneously
- **Recovery:** Easy rollback via branch deletion

### Pre-Dispatch Checklist

Before dispatching ANY implementer:

1. **Ensure .worktrees is gitignored:**
   ```bash
   git check-ignore -q .worktrees || echo ".worktrees/" >> .gitignore
   ```

2. **Create feature branch:**
   ```bash
   git branch feature/<task-id>-<name> main
   ```

3. **Create worktree:**
   ```bash
   git worktree add .worktrees/<task-id>-<name> feature/<task-id>-<name>
   ```

4. **Run setup in worktree:**
   ```bash
   cd .worktrees/<task-id>-<name> && npm install
   ```

5. **Verify baseline tests pass:**
   ```bash
   npm run test:run
   ```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Make agents read plan files | Provide full task text in prompt |
| Skip worktree for parallel work | Create isolated worktrees |
| Forget to track tasks | Update todo for every task |
| Skip TDD requirements | Include TDD instructions in prompt |
| Mix async and sync without reason | Choose mode based on task needs |

## State Management

This skill tracks task progress in workflow state for context persistence.

### Read Tasks from State

Instead of re-parsing plan, read task list from state:

```bash
~/.copilot/scripts/workflow-state.sh get docs/workflow-state/<feature>.state.json '.tasks'
```

### On Task Dispatch

Update task status when dispatched:

```bash
~/.copilot/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '(.tasks[] | select(.id == "001")).status = "in_progress"'
```

### On Task Complete

Update task status when agent reports completion:

```bash
~/.copilot/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '(.tasks[] | select(.id == "001")).status = "complete"'
```

### On All Tasks Complete

Update phase:

```bash
~/.copilot/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json '.phase = "integrate"'
```

## Fix Mode (--fixes)

When review or integration fails, delegation handles fixes:

### Trigger

After review/integration failures, orchestrator invokes fix mode.

### Fix Mode Process

1. **Read failure details** from state file
2. **Extract fix tasks** from failure reports
3. **Dispatch fixers** using implementer agent with fix context
4. **Re-integrate** after all fixes complete

## Completion Criteria

- [ ] All tasks extracted from plan (or read from state)
- [ ] Worktrees created for parallel groups
- [ ] State file updated with task status
- [ ] Todos updated with all tasks
- [ ] Implementers dispatched with full context
- [ ] All tasks report completion
- [ ] All tests pass in worktrees

## Transition

After all tasks complete, **auto-continue immediately**:

1. Update state: `.phase = "integrate"`
2. Output: "All [N] tasks complete. Continuing to integration..."
3. The integration skill will auto-activate based on phase

This is NOT a human checkpoint - workflow continues autonomously.
