# exarchos_view

CQRS materialized views -- read-only projections computed from events and workflow state. All actions are read-only and produce no side effects. CLI alias: `vw`.

## Pipeline and Status

### pipeline

Aggregated view of active workflows with phase, task counts, and stack positions.

```json
{ "action": "pipeline" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `limit` | no | integer (> 0) | Maximum workflows to return |
| `offset` | no | integer (>= 0) | Number of workflows to skip (pagination) |
| `includeCompleted` | no | boolean | When true, include completed and cancelled workflows. Default: false |

Phases: all. Role: `any`.

### workflow_status

Single workflow status with phase, task summary (pending/active/completed/failed counts), and metadata.

```json
{ "action": "workflow_status", "workflowId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `workflowId` | no | string | Workflow identifier. When omitted, uses the current active workflow |

Phases: all. Role: `any`.

### tasks

Task detail view with filtering and field projection.

```json
{
  "action": "tasks",
  "workflowId": "my-feature",
  "filter": { "status": "active" },
  "fields": ["id", "title", "status"]
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `workflowId` | no | string | Workflow identifier |
| `filter` | no | object | Key-value filter applied to task fields |
| `limit` | no | integer (> 0) | Maximum tasks to return |
| `offset` | no | integer (>= 0) | Number of tasks to skip (pagination) |
| `fields` | no | string[] | Field projection -- return only these fields per task |

Phases: all. Role: `any`.

---

## Stack and Positioning

### stack_status

Current PR stack positions derived from events.

```json
{ "action": "stack_status", "streamId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `streamId` | no | string | Event stream identifier |
| `limit` | no | integer (> 0) | Maximum entries to return |
| `offset` | no | integer (>= 0) | Pagination offset |

Phases: delegate, overhaul-delegate, synthesize, debug-implement. Role: `any`.

### stack_place

Record a stack position for a task.

```json
{
  "action": "stack_place",
  "streamId": "my-feature",
  "position": 2,
  "taskId": "task-003",
  "branch": "feat/task-003",
  "prUrl": "https://github.com/org/repo/pull/42"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `streamId` | yes | string | Event stream identifier |
| `position` | yes | integer (>= 0) | Stack position (0-indexed) |
| `taskId` | yes | string | Task this position belongs to |
| `branch` | no | string | Git branch name |
| `prUrl` | no | string | Associated PR URL |

Phases: delegate, overhaul-delegate, synthesize, debug-implement. Role: `any`.

---

## Telemetry and Performance

### telemetry

Tool invocation metrics with per-tool performance data and optimization hints.

```json
{ "action": "telemetry", "sort": "tokens", "limit": 10 }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `compact` | no | boolean | Return a compact summary instead of full metrics |
| `tool` | no | string | Filter to a specific tool name |
| `sort` | no | `"tokens"` \| `"invocations"` \| `"duration"` | Sort order for results |
| `limit` | no | integer (> 0) | Maximum entries to return |

Phases: all. Role: `any`.

### team_performance

Team metrics derived from delegation events: completion rates, timing, and per-agent statistics.

```json
{ "action": "team_performance", "workflowId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `workflowId` | no | string | Scope metrics to a specific workflow |

Phases: all. Role: `any`.

### delegation_timeline

Delegation timeline with bottleneck detection. Shows task assignment, start, and completion times with gaps highlighted.

```json
{ "action": "delegation_timeline", "workflowId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `workflowId` | no | string | Scope to a specific workflow |

Phases: all. Role: `any`.

---

## Quality and Readiness

### code_quality

Quality metrics with gate pass rates, skill attribution, and regression detection.

```json
{ "action": "code_quality", "workflowId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `workflowId` | no | string | Scope to a specific workflow |
| `skill` | no | string | Filter by skill name |
| `gate` | no | string | Filter by gate name |
| `limit` | no | integer (> 0) | Maximum entries to return |

Phases: all. Role: `any`.

### delegation_readiness

Check delegation readiness: plan approval status, quality gates passed, and worktree availability.

```json
{ "action": "delegation_readiness", "workflowId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `workflowId` | no | string | Workflow identifier |

Phases: all. Role: `any`.

### synthesis_readiness

Check synthesis readiness: task completion, reviews done, tests passing, and typecheck status.

```json
{ "action": "synthesis_readiness", "workflowId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `workflowId` | no | string | Workflow identifier |

Phases: all. Role: `any`.

### shepherd_status

PR shepherd status: CI check results, comments, unresolved review findings, and iteration count.

```json
{ "action": "shepherd_status", "workflowId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `workflowId` | no | string | Workflow identifier |

Phases: all. Role: `any`.

### convergence

Per-dimension gate convergence status (D1-D5) computed from `gate.executed` events. Returns overall pass/fail and per-dimension breakdown.

```json
{ "action": "convergence", "workflowId": "my-feature" }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `workflowId` | no | string | Workflow identifier |

Phases: all. Role: `any`.

---

### describe

Get full schemas for specific actions.

```json
{ "action": "describe", "actions": ["pipeline", "convergence"] }
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `actions` | yes | string[] (1-10) | Action names to describe |

Returns: Full Zod schemas, descriptions, and phase/role constraints for each requested action.

Phases: all. Role: `any`.
