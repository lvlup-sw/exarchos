# Events

The event store is an append-only JSONL log per feature. Every state change in a workflow is captured as an event, forming an audit trail that can be queried, replayed, and used for state reconciliation.

## Event structure

Each event conforms to the base schema:

```typescript
{
  streamId: string,       // Feature ID or shared stream name
  sequence: number,       // Monotonically increasing per stream
  timestamp: string,      // ISO 8601
  type: string,           // Dotted event type (e.g., "task.completed")
  correlationId?: string, // Links related events across operations
  causationId?: string,   // The event that caused this one
  agentId?: string,       // Agent that produced the event
  source?: string,        // Emission context
  schemaVersion: string,  // Data schema version (default "1.0")
  data?: object,          // Type-specific payload
  idempotencyKey?: string // Prevents duplicate appends
}
```

## Emission sources

Each event type has a designated emission source:

| Source | Meaning | Example |
|--------|---------|---------|
| `auto` | Emitted by MCP server handlers (deterministic, no manual emission needed) | `workflow.started`, `gate.executed` |
| `model` | Explicitly emitted by the agent via `exarchos_event` | `team.spawned`, `review.finding` |
| `hook` | Emitted by Claude Code lifecycle hooks | `benchmark.completed` |
| `planned` | Schema exists but not yet used in production | `eval.run.started` |

Events marked `auto` should not be duplicated via manual `exarchos_event` calls. The MCP server emits them as side effects of workflow operations.

## Event types (60 total)

### Workflow (13)

| Type | Source | Description |
|------|--------|-------------|
| `workflow.started` | auto | Workflow initialized. For `oneshot` workflows, the event data includes `synthesisPolicy` so it survives ES v2 rematerialization |
| `workflow.transition` | auto | Phase transition |
| `workflow.fix-cycle` | auto | Fix cycle incremented |
| `workflow.guard-failed` | auto | Transition guard rejected |
| `workflow.checkpoint` | auto | State checkpointed |
| `workflow.compound-entry` | auto | Entered compound state |
| `workflow.compound-exit` | auto | Exited compound state |
| `workflow.cancel` | auto | Workflow cancelled |
| `workflow.cleanup` | auto | Post-merge cleanup |
| `workflow.compensation` | auto | Saga compensation action |
| `workflow.circuit-open` | auto | Circuit breaker tripped |
| `workflow.cas-failed` | auto | Compare-and-swap retry exhausted |
| `workflow.pruned` | auto | Batch-cancelled by `prune_stale_workflows`. Payload: `{ featureId, stalenessMinutes, triggeredBy: "manual" \| "scheduled", skippedSafeguards? }`. Introduced in v2.6.0 |

### Task (5)

| Type | Source | Description |
|------|--------|-------------|
| `task.assigned` | model | Task assigned to agent |
| `task.claimed` | auto | Agent claimed a task |
| `task.progressed` | model | TDD phase progress (red/green/refactor) |
| `task.completed` | auto | Task finished with optional evidence |
| `task.failed` | auto | Task failed with error details |

### Quality (4)

| Type | Source | Description |
|------|--------|-------------|
| `gate.executed` | auto | Convergence gate ran with pass/fail result |
| `quality.regression` | model | Consecutive gate failures detected |
| `quality.hint.generated` | auto | Quality hints generated for a skill |
| `quality.refinement.suggested` | auto | Refinement suggestion based on trends |

### Evaluation (4)

| Type | Source | Description |
|------|--------|-------------|
| `eval.run.started` | planned | Eval suite started |
| `eval.case.completed` | planned | Single eval case finished |
| `eval.run.completed` | planned | Eval suite finished |
| `eval.judge.calibrated` | auto | Judge accuracy metrics recorded |

### Stack (4)

| Type | Source | Description |
|------|--------|-------------|
| `stack.position-filled` | auto | Task placed in stack position |
| `stack.restacked` | auto | Stack rebased |
| `stack.enqueued` | auto | PRs enqueued for merge |
| `stack.submitted` | model | Stack submitted with PR numbers |

### Telemetry (3)

| Type | Source | Description |
|------|--------|-------------|
| `tool.invoked` | auto | MCP tool call started |
| `tool.completed` | auto | MCP tool call finished with metrics |
| `tool.errored` | auto | MCP tool call failed |

### Benchmark (1)

| Type | Source | Description |
|------|--------|-------------|
| `benchmark.completed` | hook | Performance benchmark results |

### Team (7)

| Type | Source | Description |
|------|--------|-------------|
| `team.spawned` | model | Agent team created |
| `team.task.assigned` | model | Task assigned to teammate |
| `team.task.completed` | model | Teammate finished a task |
| `team.task.failed` | model | Teammate task failed |
| `team.task.planned` | model | Task planned for team |
| `team.teammate.dispatched` | model | Teammate dispatched to worktree |
| `team.disbanded` | model | Team dissolved after work complete |

### Review (3)

| Type | Source | Description |
|------|--------|-------------|
| `review.routed` | model | PR routed to review destination |
| `review.finding` | model | Review finding recorded |
| `review.escalated` | model | Review escalated due to critical finding |

### Remediation (2)

| Type | Source | Description |
|------|--------|-------------|
| `remediation.attempted` | model | Remediation strategy attempted |
| `remediation.succeeded` | model | Remediation completed successfully |

### Shepherd (4)

| Type | Source | Description |
|------|--------|-------------|
| `shepherd.started` | auto | Shepherd iteration loop began |
| `shepherd.iteration` | model | Single shepherd assess-fix-resubmit cycle |
| `shepherd.approval_requested` | auto | Review approval requested |
| `shepherd.completed` | auto | Shepherd process finished |

### Session (8)

| Type | Source | Description |
|------|--------|-------------|
| `session.tagged` | model | Session attributed to a feature/concern |
| `worktree.created` | model | Worktree created for a task |
| `worktree.baseline` | model | Worktree baseline test result |
| `test.result` | model | Test suite execution result |
| `typecheck.result` | model | Typecheck execution result |
| `ci.status` | model | CI status for a PR |
| `comment.posted` | model | PR comment posted |
| `comment.resolved` | model | PR comment thread resolved |

### Oneshot choice state (1)

| Type | Source | Description |
|------|--------|-------------|
| `synthesize.requested` | auto | Appended by `request_synthesize`. Consumed by the `synthesisOptedIn` guard at `finalize_oneshot` time. Payload: `{ featureId, reason?, timestamp }`. Duplicate appends are benign (any count ≥ 1 → opted in). Introduced in v2.6.0 |

### Other (1)

| Type | Source | Description |
|------|--------|-------------|
| `state.patched` | auto | Workflow state patched directly |

## Querying events

Query events from a stream with optional type filtering:

```typescript
exarchos_event({
  action: "query",
  stream: "my-feature",
  filter: { type: "task.completed" },
  limit: 10
})
```

Wildcard patterns are supported for type-based queries:

```typescript
exarchos_event({
  action: "query",
  stream: "my-feature",
  filter: { type: "workflow.*" }
})
```

## Appending events

Model-emitted events are appended explicitly:

```typescript
exarchos_event({
  action: "append",
  stream: "my-feature",
  event: {
    type: "team.spawned",
    data: {
      teamSize: 3,
      teammateNames: ["impl-1", "impl-2", "impl-3"],
      taskCount: 3,
      dispatchMode: "parallel"
    }
  }
})
```

Optimistic concurrency is supported via `expectedSequence` to detect conflicting writes.

## Custom event types

Custom event types can be registered at runtime for project-specific concerns. Custom types must follow the `category.name` dot-notation pattern and cannot collide with built-in types.
