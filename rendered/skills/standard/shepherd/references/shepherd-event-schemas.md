# Shepherd Event Schemas

Event data schemas for the five shepherd lifecycle events. You append each event with `exarchos_event append` to the workflow's stream. No Exarchos action appends them for you.

## shepherd.started

Append once, on the first iteration of the loop.

| Field | Type | Description |
|-------|------|-------------|
| featureId | string | Workflow feature ID |

## shepherd.iteration

Emitted after each assess → fix → resubmit cycle.

| Field | Type | Description |
|-------|------|-------------|
| iteration | number (int, ≥0) | Zero-based iteration counter |
| prsAssessed | number (int, ≥0) | Count of PRs assessed this iteration |
| fixesApplied | number (int, ≥0) | Count of fixes applied this iteration |
| status | string | Iteration outcome (e.g., "resubmitted", "waiting", "escalated") |

```javascript
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  stream: "<featureId>",
  event: {
    type: "shepherd.iteration",
    data: {
      iteration: 1,
      prsAssessed: 1,
      fixesApplied: 2,
      status: "resubmitted"
    }
  },
  idempotencyKey: "<featureId>:shepherd.iteration:<n>"
})
```

## shepherd.approval_requested

Emitted when all checks pass and approval is requested.

| Field | Type | Description |
|-------|------|-------------|
| prUrl | string | URL of the PR ready for approval |

## shepherd.escalated

Append when an escalation trigger stops the loop, such as the iteration limit.

| Field | Type | Description |
|-------|------|-------------|
| featureId | string | Workflow feature ID |
| prNumbers | number[] (int, >0) | PRs in the stack when the loop stopped |
| iterationCount | number (int, ≥0) | Iterations run when the loop stopped |
| maxIterations | number (int, >0) | The iteration limit |
| reason | string | Human-readable escalation reason |

## shepherd.completed

Append when your own read shows that the PR is merged.

| Field | Type | Description |
|-------|------|-------------|
| prUrl | string | URL of the merged PR |
| outcome | string | Completion outcome (e.g., "merged") |
