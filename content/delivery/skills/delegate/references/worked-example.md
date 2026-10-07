# Delegation Worked Example

Complete trace of a two-task delegation on the capsule path: happy path for task-001, and an unresolved task-002 with its correction.

## Context

Feature: `add-email-validation` with two plan tasks:
- **task-001:** Email format validator (`src/validators/email.ts`)
- **task-002:** Domain MX check (`src/validators/domain.ts`)

## 1. Prepare

Compile the batch — the commit announces both tasks (`task.assigned`) ahead of its record, so nothing precedes this call:

```typescript
exarchos_orchestrate({ action: "prepare", featureId: "add-email-validation" })
```

Response (abridged):
```json
{
  "capsuleVersion": 1,
  "capsuleDigest": "3f9c…",
  "capsule": {
    "graph": { "tasks": [{ "taskId": "task-001", "title": "Email format validator", "stepId": "delegate" },
                          { "taskId": "task-002", "title": "Domain MX check", "stepId": "delegate" }],
               "dependencies": [], "joins": [{ "joinId": "batch-complete", "waitsFor": ["task-001", "task-002"], "mode": "all" }] },
    "settlementContract": { "requiredResults": ["task-001", "task-002"],
                            "taskVerification": { "task-001": { "riskTier": "low", "boundaryTouching": false, "baseRef": "feat/add-email-validation" },
                                                  "task-002": { "riskTier": "medium", "boundaryTouching": true, "baseRef": "feat/add-email-validation" } } },
    "knowledge": { "patterns": [
      { "statement": "A task at riskTier=low, boundaryTouching=false is verified at settlement by: check_static_analysis." },
      { "statement": "A task at riskTier=medium, boundaryTouching=true is verified at settlement by: check_static_analysis, check_test_adequacy, check_contract_drift, check_mock_boundary." } ] },
    "executionProfile": { "capabilities": ["fs:read", "fs:write", "mcp:exarchos", "shell:exec"] }
  }
}
```

## 2. Dispatch

Build two self-contained prompts from `implementer-prompt.md` — the task body from the plan, the terms from the capsule — and dispatch in a single message:

```typescript
Task({
  subagent_type: "general-purpose", run_in_background: true,
  description: "Implement task-001: Email format validator",
  prompt: `# Task: Email Format Validator\n\n## Working Directory\n/project/.worktrees/task-001-email-format\n\n## Verification terms\nriskTier=low, boundaryTouching=false. A task at riskTier=low, boundaryTouching=false is verified at settlement by: check_static_analysis.\n\n[Full implementer prompt: file paths, acceptance criteria, invariants, the result contract, the deviation envelope...]`
})

Task({
  subagent_type: "general-purpose", run_in_background: true,
  description: "Implement task-002: Domain MX check",
  prompt: `# Task: Domain MX Check\n\n## Working Directory\n/project/.worktrees/task-002-domain-mx\n\n## Verification terms\nriskTier=medium, boundaryTouching=true. A task at riskTier=medium, boundaryTouching=true is verified at settlement by: check_static_analysis, check_test_adequacy, check_contract_drift, check_mock_boundary.\n\n[...]`
})
```

## 3. Collect and settle

```text
{{SUBAGENT_RESULT_API}}
// task-001: tests pass; reports worktreePath, branch, files, implements, tests
// task-002: reports the same — and claims its tests pass
```

Build one claim per report and submit the batch:

```typescript
exarchos_orchestrate({
  action: "settle", featureId: "add-email-validation", capsuleVersion: 1, batchId: "add-email-validation:wave-1",
  claims: [
    { taskId: "task-001", fields: { worktreePath: "/project/.worktrees/task-001-email-format", branch: "feat/task-001",
        files: ["src/validators/email.ts", "src/validators/email.test.ts"], implements: ["DR-1"],
        tests: [{ name: "validateEmail_InvalidFormat_ReturnsError", file: "src/validators/email.test.ts" }] }, evidence: [] },
    { taskId: "task-002", fields: { worktreePath: "/project/.worktrees/task-002-domain-mx", branch: "feat/task-002",
        files: ["src/validators/domain.ts", "src/validators/domain.test.ts"], implements: ["DR-2"],
        tests: [{ name: "checkMx_NoRecord_ReturnsError", file: "src/validators/domain.test.ts" }] }, evidence: [] },
  ],
})
```

Response (abridged):
```json
{
  "outcome": "corrective-capsule",
  "acceptedTasks": ["task-001"],
  "unresolved": [
    { "taskId": "task-002", "cause": "verification-failed", "failedLeaf": "check_static_analysis", "operationId": "settle-task:c04d…" }
  ],
  "findings": [
    { "kind": "verification-failed", "subject": "task-002", "at": "claims[1]",
      "message": "verification of task \"task-002\" halted on 'check_static_analysis': leaf 'check_static_analysis' is a blocking gate and its verdict blocked (passed: false)" }
  ],
  "verification": [
    { "taskId": "task-001", "outcome": "verified", "operationId": "settle-task:7a1e…" },
    { "taskId": "task-002", "outcome": "failed", "operationId": "settle-task:c04d…", "failedLeaf": "check_static_analysis" }
  ]
}
```

The outcome is `corrective-capsule`. task-001 passed its gates and is complete on the stream. task-002 is unresolved: its static analysis recorded a failing verdict. Read the `gate.executed` row, or read the receipt of the segment through `execute_intent` with that `operationId`. The verdict shows a typecheck error in `domain.ts`.

## 4. Fix and settle the correction (task-002)

**Do NOT trust the implementer's summary.** The gate's own output is the diagnosis: `domain.ts` calls `dns.resolveMx` with the wrong signature.

Re-dispatch with the fixer prompt in the same worktree:

```typescript
Task({
  subagent_type: "general-purpose",
  description: "Fix task-002: typecheck failure in domain.ts",
  prompt: `# Fix Task: Typecheck Failure\n\n## Adversarial Verification Posture\nIndependently verify the failure...\n\n## Working Directory\n/project/.worktrees/task-002-domain-mx\n\n## Issue to Fix\n**File:** src/validators/domain.ts\n**Problem:** dns.resolveMx called with a callback where a promise is expected\n**Verification terms:** riskTier=medium, boundaryTouching=true — settlement runs check_static_analysis, check_test_adequacy, check_contract_drift, check_mock_boundary against this worktree.`
})
```

After the fix, settle a **new** batch id on the **same** capsule, and claim only task-002. task-001 is complete, so it needs no claim:

```typescript
exarchos_orchestrate({
  action: "settle", featureId: "add-email-validation", capsuleVersion: 1, batchId: "add-email-validation:wave-1:correction-1",
  claims: [ /* task-002 as before */ ],
})
// → { "outcome": "settled", "acceptedTasks": ["task-002"],
//     "verification": [{ "taskId": "task-001", "outcome": "already-complete" }, { "taskId": "task-002", "outcome": "verified", ... }] }
```

## 5. Land and transition

Both tasks complete. Land each worktree through `serialize_merge` (the merge-pending detour), run `check_integration_suite` once at the wave boundary, then auto-continue:
```typescript
exarchos_workflow({ action: "transition", featureId: "add-email-validation", target: "review" })
Skill({ skill: "exarchos:review", args: "docs/plans/add-email-validation.md" })
```

## Variations

**A worker reports that its task is blocked.** If the worker of task-002 cannot proceed, send a claim with a status and a reason, and no fields:

```typescript
{ taskId: "task-002", status: "blocked", reason: "The DNS fixture that the task reads is not merged." }
```

The outcome is `corrective-capsule`. task-001 is complete, and `unresolved` holds `{ "taskId": "task-002", "cause": "task-blocked" }`. No gate ran for task-002, so the entry has no `failedLeaf` and no `operationId`. After the block is removed, settle a new batch id on the same capsule, and claim task-002 as completed.

**A worker records a delegated choice.** The capsule lists `implementation-approach` in `authority.delegatedDecisions`. If the worker of task-001 records a choice under that id, add the choice to the claim:

```typescript
{ taskId: "task-001", fields: { /* as before */ }, evidence: [],
  rationale: [{ delegatedDecision: "implementation-approach", statement: "One regex validates the format, because the format has no nesting." }] }
```

Settlement runs the same gates. If each task passes, the outcome is `accepted-with-rationale` in place of `settled`, and the next step is the same.
