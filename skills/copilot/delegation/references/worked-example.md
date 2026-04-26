# Delegation Worked Example

Complete trace of a two-task delegation: happy path for task-001, failure recovery for task-002.

## Context

Feature: `add-email-validation` with two plan tasks:
- **task-001:** Email format validator (`src/validators/email.ts`)
- **task-002:** Domain MX check (`src/validators/domain.ts`)

## 1. Prepare

Call the composite action:

```typescript
exarchos_orchestrate({
  action: "prepare_delegation",
  featureId: "add-email-validation",
  tasks: [
    { id: "task-001", title: "Email format validator", modules: ["src/validators"] },
    { id: "task-002", title: "Domain MX check", modules: ["src/validators"] }
  ]
})
```

Response:
```json
{
  "ready": true,
  "worktrees": [
    { "taskId": "task-001", "path": "/project/.worktrees/task-001" },
    { "taskId": "task-002", "path": "/project/.worktrees/task-002" }
  ],
  "qualityHints": []
}
```

## 2. Dispatch

Build two self-contained prompts from `implementer-prompt.md` and dispatch in a single message:

```typescript
Task({
  subagent_type: "general-purpose", run_in_background: true,
  description: "Implement task-001: Email format validator",
  prompt: `# Task: Email Format Validator\n\n## Working Directory\n/project/.worktrees/task-001\n\n[Full implementer prompt with TDD, file paths, acceptance criteria...]`
})

Task({
  subagent_type: "general-purpose", run_in_background: true,
  description: "Implement task-002: Domain MX check",
  prompt: `# Task: Domain MX Check\n\n## Working Directory\n/project/.worktrees/task-002\n\n[Full implementer prompt with TDD, file paths, acceptance criteria...]`
})
```

## 3. Monitor — Happy Path (task-001)

```text
task --agent reply (inline)
// task_id: task-001-id
// Result: tests pass, implementation complete
```

Update workflow state:
```typescript
exarchos_workflow({ action: "set", featureId: "add-email-validation",
  updates: { "tasks[0].status": "complete" } })
```

Emit gate event:
```typescript
exarchos_event({ action: "append", stream: "add-email-validation",
  event: { type: "gate.executed", data: { gateName: "post-delegation-check", layer: "CI", passed: true } } })
```

## 4. Monitor — Failure Recovery (task-002)

```text
task --agent reply (inline)
// task_id: task-002-id
// Result: test fails — DNS mock not wired, MX lookup hits network
```

**Do NOT trust the implementer's summary.** Read the test output independently:
- Root cause: Missing `vi.mock('dns')` — real DNS called during test.

Re-dispatch with fixer prompt in the same worktree:

```typescript
Task({
  subagent_type: "general-purpose",
  description: "Fix task-002: DNS mock missing",
  prompt: `# Fix Task: DNS Mock Missing\n\n## Adversarial Verification Posture\nIndependently verify the failure...\n\n## Working Directory\n/project/.worktrees/task-002\n\n## Issue to Fix\n**File:** src/validators/domain.test.ts\n**Problem:** Missing vi.mock('dns') — test makes real network calls\n**Fix:** Add vi.mock('dns') with MX record stub\n\n## Verification\nRun: npm run test:run\nAll tests must pass without network access.`
})
```

After fix succeeds, update state and emit gate event as in the happy path.

## 5. Transition

Both tasks complete. Auto-continue:
```typescript
exarchos_workflow({ action: "set", featureId: "add-email-validation",
  updates: { phase: "review" } })
Skill({ skill: "exarchos:review", args: "docs/plans/add-email-validation.md" })
```
