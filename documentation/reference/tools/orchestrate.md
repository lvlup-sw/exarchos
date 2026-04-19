# exarchos_orchestrate

Task coordination, quality gates, review dispatch, scripts, runbooks, and agent specs. This is the largest tool with 25 actions grouped by category. CLI alias: `orch`.

## Task lifecycle

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

## Review and delegation

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

## Oneshot choice state

Actions specific to the oneshot workflow type. Both introduced in v2.6.0.

### request_synthesize

Opt-in event for the oneshot choice state. Appends a `synthesize.requested` event to the workflow's event stream so that when `finalize_oneshot` is later called, the `synthesisOptedIn` guard routes to the `synthesize` phase instead of directly `completed`.

```json
{
  "action": "request_synthesize",
  "featureId": "fix-readme-typo",
  "reason": "user requested review after parser changes"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier (must be a oneshot workflow) |
| `reason` | no | string | Human-readable rationale (captured in event payload for audit) |

**Idempotency.** Each call appends a separate `synthesize.requested` event (the stream is not deduplicated), but the guard treats any count ≥ 1 as "opted in". Duplicate calls therefore produce the same routing decision with additional audit breadcrumbs.

**Phase acceptance.** The handler accepts `request_synthesize` from `plan` or `implementing`. Terminal phases (`synthesize`, `completed`, `cancelled`) are rejected with `INVALID_PHASE` — the event has no effect on an already-terminated workflow.

Auto-emits: `synthesize.requested`. Phases: plan, implementing. Role: `lead`.

### finalize_oneshot

Resolve the oneshot `implementing → ?` choice state. Evaluates `synthesisOptedIn` / `synthesisOptedOut` against the hydrated event stream and calls `handleSet` with the resolved target phase.

```json
{
  "action": "finalize_oneshot",
  "featureId": "fix-readme-typo"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier (must be a oneshot workflow in `implementing`) |

The handler:
1. Reads current state and verifies `workflowType === 'oneshot'` and `phase === 'implementing'`
2. Hydrates `_events` from the event store
3. Evaluates the choice-state guards (pure functions of `state.oneshot.synthesisPolicy` and the `synthesize.requested` count)
4. Calls `handleSet` with the resolved target (`synthesize` or `completed`)
5. The HSM re-evaluates the guard at the transition boundary as a safety net

**Policy precedence.** `synthesisPolicy = "always"` short-circuits to `synthesize` regardless of events. `synthesisPolicy = "never"` short-circuits to `completed` — any emitted `synthesize.requested` events are ignored. Only `"on-request"` (default) consults the event stream.

Phases: implementing. Role: `lead`.

---

## Maintenance

### prune_stale_workflows

Bulk-maintenance action that finds non-terminal workflows beyond a staleness threshold, applies safeguards, and batch-cancels the approved candidates. Each pruned workflow emits a `workflow.pruned` event. Introduced in v2.6.0.

```json
{
  "action": "prune_stale_workflows",
  "thresholdMinutes": 10080,
  "dryRun": true
}
```

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `thresholdMinutes` | no | integer (positive) | `10080` (7 days) | Staleness cutoff — workflows with `_checkpoint.lastActivityTimestamp` older than this are candidates. Rejected if negative/zero/NaN/Infinity/non-integer |
| `dryRun` | no | boolean | `true` | Preview mode: compute candidates + safeguard filtering without mutating state |
| `force` | no | boolean | `false` | Bypass safeguards but record bypass in the audit event via `skippedSafeguards` |
| `includeOneShot` | no | boolean | `true` | Whether to include `workflowType: "oneshot"` workflows in the candidate set |

**Safeguards (default behavior, bypassed only by `force: true`):**

- `hasOpenPR(featureId, branchName)` — skips candidates whose inferred branch has an open PR on GitHub
- `hasRecentCommits(branchName, windowHours)` — skips candidates with commits pushed to the branch within the last 24 hours
- Workflows without a `branchName` in state (e.g., abandoned pre-delegation) automatically skip both safeguards (nothing to check) and are eligible for pruning

**Fail-closed validation.** Entries from `handleList` with missing or invalid fields (missing `featureId`, unparsable timestamp, etc.) are routed to a `malformed` bucket and never reach `candidates` or `pruned`. A warning is emitted via the orchestrate logger.

**Return shape (dry-run):**
```json
{
  "candidates": [{ "featureId": "...", "workflowType": "...", "phase": "...", "stalenessMinutes": 14430 }],
  "skipped":    [{ "featureId": "...", "reason": "open-pr" | "active-branch" | "terminal" | "fresh" | "oneshot-excluded" }],
  "malformed":  [{ "featureId": "...", "reason": "..." }]
}
```

**Return shape (apply mode):** same as dry-run plus a `pruned` array with `{ featureId, previousPhase }` per successfully cancelled workflow. The `pruned` field is omitted entirely in dry-run.

**Apply-mode preconditions.** The handler requires `ctx.eventStore` to be present when `dryRun: false`. Invoking apply mode without an event store returns a structured `MISSING_CONTEXT` error rather than silently swallowing the audit event.

Auto-emits: `workflow.pruned` (per cancelled workflow). Phases: all. Role: `lead`.

---

## Quality gates

Gates check specific quality dimensions. Each gate emits a `gate.executed` event. Gates are classified as **blocking** (must pass to proceed) or **informational** (findings reported but do not block progress).

### Blocking gates

| Action | Dimension | What It Checks | Extra Parameters |
|--------|-----------|----------------|------------------|
| `check_static_analysis` | D2 | Lint + typecheck violations | `repoRoot?`, `skipLint?`, `skipTypecheck?` |
| `check_provenance_chain` | D1 | Design requirement traceability (DR-N tags) | `designPath`, `planPath` |
| `check_plan_coverage` | D1 | Plan tasks cover all design sections | `designPath`, `planPath` |
| `check_tdd_compliance` | D1 | Test-before-code protocol followed | `taskId`, `branch`, `baseBranch?` |
| `check_review_verdict` | -- | Final verdict from finding counts | `high`, `medium`, `low`, `blockedReason?`, `dimensionResults?` |

All blocking gates require `featureId`. `check_static_analysis` runs in review phases; the provenance/coverage/TDD gates run in plan or delegate phases.

### Informational gates

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

## Event checks

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

> **Removed:** The `run_script` action was removed in the TypeScript port (#998). All 21 workflow scripts are now native TypeScript orchestrate actions (e.g., `check_coverage_thresholds`, `validate_pr_body`, `pre_synthesis_check`). See the full action list in `registry.ts`.

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

## Agent specs

### agent_spec

Retrieve an agent specification for subagent dispatch. Returns the agent's system prompt, capabilities, and constraints.

```json
{
  "action": "agent_spec",
  "agent": "implementer",
  "outputFormat": "full"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `agent` | yes | string (enum) | Agent identifier from the registered spec list |
| `context` | no | object | Key-value pairs for template variable interpolation in prompts |
| `outputFormat` | no | `"full"` \| `"prompt-only"` (default: `"full"`) | `full` returns the complete spec; `prompt-only` returns just the system prompt. Renamed from `format` in #1127 to avoid a registration collision with the `format: "table" \| "json"` parameter on `doctor` and `init`. |

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
