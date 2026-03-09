# exarchos_orchestrate

Task coordination, quality gates, review dispatch, scripts, runbooks, and agent specs. This is the largest tool with 25 actions grouped by category. CLI alias: `orch`.

## Task Lifecycle

### task_claim

Claim a task for execution.

```json
{
  "action": "task_claim",
  "taskId": "task-003",
  "agentId": "agent-1",
  "streamId": "my-feature"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `taskId` | yes | string | Task identifier |
| `agentId` | yes | string | Agent claiming the task |
| `streamId` | yes | string | Event stream (feature) this task belongs to |

Phases: delegate, overhaul-delegate, debug-implement. Role: `teammate`.

### task_complete

Mark a task as complete with optional result and evidence. Auto-emits `task.completed` event. When `evidence` is provided, the event includes `verified: true`; otherwise `verified: false`.

```json
{
  "action": "task_complete",
  "taskId": "task-003",
  "streamId": "my-feature",
  "result": { "filesChanged": ["src/handler.ts", "src/handler.test.ts"] },
  "evidence": {
    "type": "test",
    "output": "3 tests passed",
    "passed": true
  }
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `taskId` | yes | string | Task identifier |
| `streamId` | yes | string | Event stream identifier |
| `result` | no | object | Freeform result data (files changed, outputs, etc.) |
| `evidence` | no | object | Structured verification evidence |
| `evidence.type` | yes (if evidence) | `"test"` \| `"build"` \| `"typecheck"` \| `"manual"` | Evidence category |
| `evidence.output` | yes (if evidence) | string | Raw output text |
| `evidence.passed` | yes (if evidence) | boolean | Whether the verification passed |

Phases: delegate, overhaul-delegate, debug-implement. Role: `teammate`.

### task_fail

Mark a task as failed with error details. Auto-emits `task.failed` event.

```json
{
  "action": "task_fail",
  "taskId": "task-003",
  "streamId": "my-feature",
  "error": "Test timeout in handler.test.ts"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `taskId` | yes | string | Task identifier |
| `streamId` | yes | string | Event stream identifier |
| `error` | yes | string | Error description |
| `diagnostics` | no | object | Additional diagnostic data |

Phases: delegate, overhaul-delegate, debug-implement. Role: `teammate`.

---

## Review and Delegation

### review_triage

Score PRs by risk and dispatch to review. Uses velocity metrics to decide routing.

```json
{
  "action": "review_triage",
  "featureId": "my-feature",
  "prs": [
    {
      "number": 42,
      "paths": ["src/handler.ts"],
      "linesChanged": 150,
      "filesChanged": 3,
      "newFiles": 1
    }
  ]
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |
| `prs` | yes | object[] | Array of PR metadata for scoring |
| `prs[].number` | yes | integer | PR number |
| `prs[].paths` | yes | string[] | Changed file paths |
| `prs[].linesChanged` | yes | integer | Total lines changed |
| `prs[].filesChanged` | yes | integer | Total files changed |
| `prs[].newFiles` | yes | integer | Number of new files |
| `activeWorkflows` | no | object[] | Active workflows for load balancing |
| `pendingCodeRabbitReviews` | no | integer | Current CodeRabbit review queue depth |
| `basileusConnected` | no | boolean | Whether the Basileus review service is available |

Phases: review, overhaul-review, debug-review. Role: `lead`.

### prepare_delegation

Check delegation readiness and prepare quality hints for subagent dispatch.

```json
{
  "action": "prepare_delegation",
  "featureId": "my-feature",
  "nativeIsolation": true
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |
| `tasks` | no | object[] | Array of `{ id, title }` for task-specific hints |
| `nativeIsolation` | no | boolean (default: false) | When true, skip worktree-related blockers (Claude Code handles isolation natively) |

Phases: delegate, overhaul-delegate, debug-implement. Role: `lead`.

### prepare_synthesis

Run pre-synthesis checks: tests, typecheck, stack health. Emits events for readiness views.

```json
{ "action": "prepare_synthesis", "featureId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |

Phases: synthesize, review, overhaul-review, debug-review. Role: `lead`.

### assess_stack

Assess PR stack health during synthesize: CI status, reviews, comments. Emits events for the shepherd iteration loop.

```json
{
  "action": "assess_stack",
  "featureId": "my-feature",
  "prNumbers": [42, 43, 44]
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |
| `prNumbers` | yes | integer[] | PR numbers in the stack |

Phases: synthesize, review, overhaul-review, debug-review. Role: `lead`.

---

## Quality Gates

Gates check specific quality dimensions. Each gate emits a `gate.executed` event. Gates are classified as **blocking** (must pass to proceed) or **informational** (findings reported but do not block progress).

### Blocking Gates

| Action | Dimension | What It Checks | Extra Parameters |
|--------|-----------|----------------|------------------|
| `check_static_analysis` | D2 | Lint + typecheck violations | `repoRoot?`, `skipLint?`, `skipTypecheck?` |
| `check_provenance_chain` | D1 | Design requirement traceability (DR-N tags) | `designPath`, `planPath` |
| `check_plan_coverage` | D1 | Plan tasks cover all design sections | `designPath`, `planPath` |
| `check_tdd_compliance` | D1 | Test-before-code protocol followed | `taskId`, `branch`, `baseBranch?` |
| `check_review_verdict` | -- | Final verdict from finding counts | `high`, `medium`, `low`, `blockedReason?`, `dimensionResults?` |

All blocking gates require `featureId`. `check_static_analysis` runs in review phases; the provenance/coverage/TDD gates run in plan or delegate phases.

### Informational Gates

| Action | Dimension | What It Checks | Extra Parameters |
|--------|-----------|----------------|------------------|
| `check_security_scan` | D1 | Security patterns in diff | `repoRoot?`, `baseBranch?` |
| `check_context_economy` | D3 | Code complexity for LLM context | `repoRoot?`, `baseBranch?` |
| `check_operational_resilience` | D4 | Empty catches, console.log, swallowed errors | `repoRoot?`, `baseBranch?` |
| `check_workflow_determinism` | D5 | .only/.skip, non-deterministic code, debug artifacts | `repoRoot?`, `baseBranch?` |
| `check_design_completeness` | D1 | Design document structure at ideate-to-plan boundary | `stateFile?`, `designPath?` |
| `check_task_decomposition` | D5 | Task granularity at plan boundary | `planPath` |
| `check_convergence` | -- | Query all D1-D5 convergence status | `workflowId?` |
| `check_post_merge` | D4 | Post-merge regression check | `prUrl`, `mergeSha` |

All informational gates require `featureId`.

---

## Event Checks

### check_event_emissions

Check for expected-but-missing events in the current workflow phase. Returns structured hints for events that should have been emitted but were not.

```json
{ "action": "check_event_emissions", "featureId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |
| `workflowId` | no | string | Specific workflow ID if multiple exist |

Phases: all. Role: `any`.

---

## Scripts

### run_script

Run a plugin validation script by name. Scripts resolve from `EXARCHOS_PLUGIN_ROOT/scripts/` with fallback to `~/.claude/scripts/`.

```json
{ "action": "run_script", "script": "validate-tdd-compliance", "args": ["--strict"] }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `script` | yes | string | Script name (without path) |
| `args` | no | string[] | Arguments passed to the script |

Phases: all. Role: `any`.

---

## Runbooks

### runbook

List available runbooks or get a specific resolved runbook with parameter schemas and gate semantics.

```json
{ "action": "runbook", "id": "delegate" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `phase` | no | string | Filter runbooks by phase |
| `id` | no | string | Retrieve a specific runbook by identifier |

When called without parameters, lists all available runbooks. When `id` is provided, returns the resolved runbook with ordered tool calls, parameter schemas, and gate metadata.

Phases: all. Role: `any`.

---

## Agent Specs

### agent_spec

Retrieve an agent specification for subagent dispatch. Returns the agent's system prompt, capabilities, and constraints.

```json
{
  "action": "agent_spec",
  "agent": "implementer",
  "format": "full"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `agent` | yes | string (enum) | Agent identifier from the registered spec list |
| `context` | no | object | Key-value pairs for template variable interpolation in prompts |
| `format` | no | `"full"` \| `"prompt-only"` (default: `"full"`) | `full` returns the complete spec; `prompt-only` returns just the system prompt |

Phases: all. Role: `any`.

---

### describe

Get full schemas for specific actions.

```json
{ "action": "describe", "actions": ["task_claim", "check_static_analysis"] }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `actions` | yes | string[] (1-10) | Action names to describe |

Returns: Full Zod schemas, descriptions, gate metadata (blocking status, quality dimension), and phase/role constraints.

Phases: all. Role: `any`.
