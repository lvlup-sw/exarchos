# Copilot Instructions

This file contains repository-wide instructions for GitHub Copilot.
Place this file at `.github/copilot-instructions.md` in your repository.

## Workflow Overview

This repository uses a structured development workflow:

```
/ideate → /plan → /delegate → /integrate → /review → /synthesize
```

**Human checkpoints** (only 2):
1. After design confirmation (ideate phase)
2. After PR creation (synthesize phase)

All other phases auto-continue.

## Orchestrator Constraints

The main Copilot session acts as an **orchestrator** that coordinates work but does NOT implement directly.

### The Orchestrator MUST NOT:

1. **Write implementation code** - Invoke `/agent implementer` instead
2. **Fix review findings directly** - Dispatch fixer via delegate phase
3. **Run integration tests inline** - Invoke `/agent integrator` instead
4. **Work in main project root** - All implementation in worktrees

### The Orchestrator SHOULD:

1. **Parse and extract** - Read plans, extract task details
2. **Dispatch and monitor** - Launch agents, track progress
3. **Manage state** - Update workflow state files
4. **Chain phases** - Continue to next phase on completion
5. **Handle failures** - Route failures back to appropriate phase

### Enforcement

When tempted to write code directly, ask:
1. Can this be delegated to an agent?
2. Is this a coordination task or implementation task?
3. Will this consume significant context?

**If in doubt, delegate.**

## TDD Requirements

### The Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

Every implementation task MUST:
1. Start with writing a failing test
2. Verify the failure is for the RIGHT reason
3. Write minimum code to pass
4. Refactor only if needed (tests stay green)

### Test Naming Convention

Use: `MethodName_Scenario_ExpectedOutcome`

Examples:
- `CreateUser_ValidInput_ReturnsUserId`
- `CreateUser_EmptyEmail_ThrowsValidationError`
- `GetUser_NonExistentId_ReturnsNull`

### Rationalization Debunking

| Excuse | Reality |
|--------|---------|
| "This is too simple for tests" | Simple code breaks too. Test it. |
| "I'll add tests after" | You won't. Or they'll be weak. |
| "Tests slow me down" | Debugging without tests is slower. |

## Coding Standards

### Control Flow

**Prefer guard clauses:**
```typescript
// GOOD
function process(input: string | null): string {
  if (!input) return '';
  if (input.length > 100) throw new Error('Too long');
  return input.trim();
}

// BAD
function process(input: string | null): string {
  if (input) {
    if (input.length <= 100) {
      return input.trim();
    }
  }
  return '';
}
```

### Structural Standards

| Standard | Guidance |
|----------|----------|
| Single responsibility | One reason to change per class/function |
| Composition over inheritance | Inheritance depth > 2 is a smell |
| Functions < 30 lines | Extract if longer |
| No premature abstraction | Three uses before extracting |

### Language-Specific

See coding standards in the `shared/coding-standards/` directory for:
- TypeScript conventions
- C# conventions
- Other languages as needed

## PR Description Guidelines

### Title Format

`<type>: <what>` (max 72 chars)

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

### Body Structure

```markdown
## Summary
[2-3 sentences: what changed, why it matters]

## Changes
- **Component 1** - Brief description
- **Component 2** - Brief description

## Test Plan
[Testing approach and coverage summary]

---
**Results:** Tests X ✓ · Build 0 errors
**Design:** [link to design doc]
```

## State Management

Use the workflow-state.sh script for state persistence:

```bash
# Initialize workflow
~/.copilot/scripts/workflow-state.sh init <feature-id>

# Update state
~/.copilot/scripts/workflow-state.sh set <state-file> '<jq-expression>'

# Read state
~/.copilot/scripts/workflow-state.sh get <state-file> '<jq-path>'

# Check for active workflows
~/.copilot/scripts/workflow-state.sh list
```

State files live in `docs/workflow-state/`.

## Git Worktrees

All implementation work happens in worktrees, not the main project root.

### Setup

```bash
# Create worktree for task
git branch feature/<task-id>-<name> main
git worktree add .worktrees/<task-id>-<name> feature/<task-id>-<name>
cd .worktrees/<task-id>-<name> && npm install
```

### Why Worktrees

- **Isolation** - Prevents conflicts between parallel tasks
- **Safety** - Protects main project state
- **Parallelism** - Multiple agents can work simultaneously
- **Recovery** - Easy rollback via branch deletion

### Cleanup

After PR merge:
```bash
git worktree remove .worktrees/<task-id>-<name>
git branch -d feature/<task-id>-<name>
```

## Available Agents

| Agent | Purpose | Invoke |
|-------|---------|--------|
| `orchestrator` | Workflow coordination | `/agent orchestrator` |
| `implementer` | TDD code implementation | `/agent implementer` |
| `reviewer` | Two-stage code review | `/agent reviewer` |
| `integrator` | Branch merging | `/agent integrator` |

## rm Safety

When using `rm` commands:

### NEVER Execute
- `rm -rf /` or `rm -rf /*`
- `rm -rf ~` or `rm -rf ~/*`
- `rm` with unset variables

### Always Prefer
1. Use specific paths
2. List before deleting (`ls` first)
3. Avoid `-f` flag unless needed
4. Double-check recursive operations

## Session Resume

At session start, check for active workflows:

```bash
~/.copilot/scripts/workflow-state.sh list
```

If active workflow exists, restore and continue:
```bash
~/.copilot/scripts/workflow-state.sh summary <state-file>
~/.copilot/scripts/workflow-state.sh next-action <state-file>
```
