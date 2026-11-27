# Shepherd Event Schemas

Event data schemas for the shepherd events. You append `shepherd.iteration` with `exarchos_event append` to the workflow's stream. No Exarchos action appends it for you.

`shepherd.iteration` is the only shepherd event that you append. The other four types are retired as emissions. Their rows from earlier loops stay in old logs, and the `shepherd_status` view still reads them. The section [Retired shepherd events](#retired-shepherd-events) gives their form.

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

## Retired shepherd events

Append none of these events. Old logs hold rows of these forms.

### shepherd.started

| Field | Type | Description |
|-------|------|-------------|
| featureId | string | Workflow feature ID |

### shepherd.approval_requested

| Field | Type | Description |
|-------|------|-------------|
| prUrl | string | URL of the PR ready for approval |

### shepherd.escalated

| Field | Type | Description |
|-------|------|-------------|
| featureId | string | Workflow feature ID |
| prNumbers | number[] (int, >0) | PRs in the stack when the loop stopped |
| iterationCount | number (int, ≥0) | Iterations run when the loop stopped |
| maxIterations | number (int, >0) | The iteration limit |
| reason | string | Human-readable escalation reason |

### shepherd.completed

| Field | Type | Description |
|-------|------|-------------|
| prUrl | string | URL of the merged PR |
| outcome | string | Completion outcome (e.g., "merged") |
