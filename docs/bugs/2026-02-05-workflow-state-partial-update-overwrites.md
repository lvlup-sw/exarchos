# Bug: Workflow State Partial Update Overwrites Sibling Keys

## Summary

When using `mcp__workflow-state__workflow_set` with an `updates` object that sets a nested key inside `artifacts`, the entire `artifacts` object is replaced rather than merged. This causes sibling keys to be lost.

## Reproduction

### Steps

1. Initialize a workflow:
   ```
   mcp__workflow-state__workflow_init({ featureId: "test", workflowType: "feature" })
   ```
   State has: `artifacts: { design: null, plan: null, pr: null }`

2. Set the design artifact:
   ```
   mcp__workflow-state__workflow_set({
     featureId: "test",
     updates: { artifacts: { design: "docs/designs/foo.md" } }
   })
   ```
   State now has: `artifacts: { design: "docs/designs/foo.md" }` — `plan` and `pr` keys are **gone**

3. Attempt to transition phase:
   ```
   mcp__workflow-state__workflow_set({
     featureId: "test",
     phase: "plan"
   })
   ```
   **Result:** `STATE_CORRUPT` error — schema validation fails because `plan` and `pr` are required but undefined.

### Expected Behavior

The `updates` parameter should deep-merge into existing state, preserving sibling keys:

```json
// Before
{ "artifacts": { "design": null, "plan": null, "pr": null } }

// Update: { "artifacts": { "design": "docs/designs/foo.md" } }

// Expected after (deep merge)
{ "artifacts": { "design": "docs/designs/foo.md", "plan": null, "pr": null } }

// Actual after (shallow replace)
{ "artifacts": { "design": "docs/designs/foo.md" } }
```

### Actual Behavior

The `updates` object performs a shallow replace on nested objects. Setting `updates.artifacts` replaces the entire `artifacts` object, losing any keys not included in the update.

## Impact

- **Workaround required:** Must manually include all sibling keys when updating any nested object, or fix the state file with the `Edit` tool after each update.
- **Breaks phase transitions:** Phase transition guards (`plan-artifact-exists`, `design-artifact-exists`) fail because required artifact keys are missing from the schema.
- **Affects all nested objects:** Any nested object in state (artifacts, synthesis, etc.) is vulnerable to the same overwrite behavior.

## Workaround

Always include all sibling keys when updating a nested object:

```
// Instead of:
updates: { artifacts: { plan: "docs/plans/foo.md" } }

// Use:
updates: { artifacts: { design: "docs/designs/foo.md", plan: "docs/plans/foo.md", pr: null } }
```

Or manually fix the state file after each partial update using the `Edit` tool to restore missing keys.

## Root Cause (Suspected)

The `workflow_set` tool likely uses `Object.assign()` or spread (`{ ...state, ...updates }`) at the top level, which performs shallow merging. Nested objects need recursive/deep merging to preserve sibling keys.

## Affected Component

`plugins/workflow-state/` MCP server — the `workflow_set` tool handler.

## Severity

**Medium** — Does not cause data loss (state file is editable), but requires manual intervention during every workflow run. Breaks the auto-continue flow when artifacts are set incrementally across phases.
