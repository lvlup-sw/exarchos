# exarchos_workflow

Workflow lifecycle management -- init, read, update, cancel, cleanup, and reconcile workflows. CLI alias: `wf`.

## Actions

### init

Initialize a new workflow. Auto-emits a `workflow.started` event. For `oneshot` workflows, the optional `synthesisPolicy` is embedded in the event payload so it survives ES v2 rematerialization.

```json
{
  "action": "init",
  "featureId": "my-feature",
  "workflowType": "feature"
}
```

```json
{
  "action": "init",
  "featureId": "fix-readme-typo",
  "workflowType": "oneshot",
  "synthesisPolicy": "on-request"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Kebab-case identifier (`^[a-z0-9-]+$`) |
| `workflowType` | yes | `"feature"` \| `"debug"` \| `"refactor"` \| `"oneshot"` | Determines phase graph and initial phase |
| `synthesisPolicy` | no | `"always"` \| `"never"` \| `"on-request"` | **oneshot only.** Default `"on-request"`. Determines whether the `implementing → ?` choice state routes to `synthesize` or `completed`. Silently ignored for non-oneshot workflow types |

Returns: `{ featureId, workflowType, phase }` where `phase` is the initial phase for the workflow type (`ideate` for feature, `triage` for debug, `explore` for refactor, `plan` for oneshot).

Phases: none (creates the workflow). Role: `lead`.

---

### get

Read workflow state with optional field projection or natural-language query.

```json
{
  "action": "get",
  "featureId": "my-feature",
  "fields": ["phase", "tasks", "artifacts"]
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |
| `fields` | no | string[] | Field projection -- return only these fields. Reduces response size by ~90% |
| `query` | no | string | Natural language query resolved to fields |

Returns: Projected state object containing only the requested fields. If neither `fields` nor `query` is provided, returns the full state.

Phases: all. Role: `any`.

---

### set

Update workflow state fields or transition phase. Auto-emits `workflow.transition` event when `phase` is provided -- do not duplicate via manual event append.

```json
{
  "action": "set",
  "featureId": "my-feature",
  "phase": "delegate",
  "updates": { "artifacts": { "plan": "docs/plans/my-plan.md" } }
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |
| `phase` | no | string | Target phase. Triggers a validated state-machine transition |
| `updates` | no | object | Key-value pairs merged into workflow state |

Phase transitions are validated against the state machine. Invalid transitions return an error listing valid target phases from the current phase.

Phases: all. Role: `lead`.

---

### cancel

Cancel a workflow with saga compensation. Auto-emits `workflow.cancel` and `workflow.compensation` events.

```json
{
  "action": "cancel",
  "featureId": "my-feature",
  "dryRun": true
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |
| `dryRun` | no | boolean | When true, preview compensation actions without executing |

Compensation reverses side effects (worktree cleanup, branch cleanup) based on the event history.

Phases: all. Role: `lead`.

---

### cleanup

Resolve a merged workflow to completed. Verifies merge status, backfills synthesis metadata, force-resolves pending reviews, and transitions to the `completed` phase. Auto-emits `workflow.cleanup` event.

```json
{
  "action": "cleanup",
  "featureId": "my-feature",
  "mergeVerified": true,
  "prUrl": "https://github.com/org/repo/pull/42"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |
| `mergeVerified` | yes | boolean | Confirms the PR has been merged |
| `prUrl` | no | string or string[] | PR URL(s) for provenance tracking |
| `mergedBranches` | no | string[] | Branch names that were merged |
| `dryRun` | no | boolean | Preview cleanup actions without executing |

Phases: all. Role: `lead`.

---

### reconcile

Rebuild workflow state from the event store. Replays events newer than the state's `_eventSequence` marker. Idempotent -- if no new events exist, returns `{ reconciled: false, eventsApplied: 0 }`.

```json
{
  "action": "reconcile",
  "featureId": "my-feature"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `featureId` | yes | string | Workflow identifier |

Returns: `{ reconciled: boolean, eventsApplied: number }`.

Use after crash recovery, compaction, or when state appears inconsistent with the event stream.

Phases: all. Role: `lead`.

---

### describe

Get full schemas for specific actions and/or HSM topology for workflow types.

```json
{
  "action": "describe",
  "actions": ["init", "set"]
}
```

```json
{
  "action": "describe",
  "topology": "feature"
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `actions` | no | string[] (1-10) | Action names to describe |
| `topology` | no | string | Workflow type to return HSM topology for. Use `"all"` to list all types |

At least one of `actions` or `topology` must be provided.

**Actions response:** Full Zod schemas, descriptions, gate metadata, and phase/role constraints for each requested action.

**Topology response:** When a specific type is given (e.g. `"feature"`), returns the serialized HSM definition including states (with type, parent, initial), transitions (with guard id/description), and tracks (compound state children). When `"all"` is given, returns a listing of all registered workflow types with phase count and track count.

Both parameters can be used together in a single call.

Phases: all. Role: `any`.
