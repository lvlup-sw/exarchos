# Shepherd Event Schemas

Event data schemas for the four shepherd lifecycle events. All events are appended via `exarchos_event append` to the workflow's stream.

## shepherd.started

Emitted automatically by `assess_stack` on first invocation.

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

## shepherd.completed

Emitted automatically by `assess_stack` when a PR is detected as merged.

| Field | Type | Description |
|-------|------|-------------|
| prUrl | string | URL of the merged PR |
| outcome | string | Completion outcome (e.g., "merged") |
