---
name: prune-workflows
description: "Interactively prune stale non-terminal workflows from the pipeline. Use when the user says 'prune workflows', 'clean stale workflows', 'pipeline cleanup', or runs /prune. Runs a dry-run preview, displays candidates with staleness and safeguard skips, prompts the user to proceed/abort/force, then bulk-cancels approved workflows with a workflow.pruned audit event. Safeguards skip workflows with open PRs or recent commits unless force is set."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: maintenance
---

# Prune Workflows Skill

## VCS Provider

This skill's safeguards use VCS operations internally (open PR detection).
The orchestrate handler manages VCS provider dispatch automatically.
No `gh`/`glab`/`az` commands needed — the MCP server handles provider dispatch.

## Overview

Bulk-cancel stale non-terminal workflows that have accumulated in the pipeline. Wraps the `prune_stale_workflows` orchestrate action with an interactive dry-run-then-confirm UX so the user always sees the candidate set before any state mutates.

Pruning is a maintenance operation -- not a workflow phase. It produces `workflow.pruned` events alongside the standard `workflow.cancelled` events emitted by the underlying cancel path, so downstream views can distinguish user-intent cancellations from batch cleanup.

## Triggers

Activate this skill when:
- User runs `{{COMMAND_PREFIX}}prune` command
- User says "prune workflows", "clean stale workflows", "pipeline cleanup"
- `{{MCP_PREFIX}}exarchos_view({ action: "pipeline" })` shows many inactive workflows the user wants to clear in bulk

## Prerequisites

- An exarchos state directory with one or more non-terminal workflows
- For safeguard checks against live PRs: `gh` available in PATH (the orchestrate handler shells out)
- For safeguard checks against branch activity: `git` available in PATH

## Process

### Step 1: Dry-Run Preview

Always start with `dryRun: true`. This call performs candidate selection and safeguard evaluation but does not mutate any workflow state.

```typescript
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "prune_stale_workflows",
  args: {
    dryRun: true
  }
})
```

The response shape is:

```ts
{
  candidates: [
    { featureId: string, phase: string, workflowType: string, stalenessMinutes: number }
  ],
  skipped: [
    { featureId: string, reason: "open-pr" | "active-branch" }
  ]
}
```

Optional args:
- `thresholdMinutes` -- staleness cutoff. Default is 10080 (7 days).
- `includeOneShot` -- whether to include `oneshot` workflows in the candidate set. Default `true`.
- `force` -- not relevant in dry-run; only honored in apply mode (Step 4).

### Step 2: Display Candidate Table

Render a table to the user so they can review what would be pruned. Use this format:

```markdown
## Prune Candidates (3)

| Feature ID | Type | Phase | Stale (min) |
|---|---|---|---|
| feat-old-experiment | feature | implementing | 14430 |
| oneshot-typo-fix | oneshot | plan | 9120 |
| debug-flaky-test | debug | investigate | 8650 |

## Skipped by Safeguards (2)

| Feature ID | Reason |
|---|---|
| feat-active-pr | open-pr |
| feat-recent-work | active-branch |
```

If `candidates.length === 0` AND `skipped.length === 0`, output:

> No stale workflows to prune. Pipeline is clean.

Then exit -- no further action.

### Step 3: Prompt for Confirmation

Ask the user one of three choices:

> **proceed** -- prune the listed candidates (skipped workflows stay)
> **abort** -- exit without changes
> **force** -- bypass safeguards and prune skipped workflows too

Wait for explicit user input. Do **not** auto-proceed.

### Step 4a: Apply (proceed)

On `proceed`, invoke the same action with `dryRun: false`. Pass through `thresholdMinutes` and `includeOneShot` if the user set them in Step 1.

```typescript
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "prune_stale_workflows",
  args: {
    dryRun: false
  }
})
```

The response now includes a `pruned` array:

```ts
{
  candidates: [...],
  skipped: [...],
  pruned: [
    { featureId: string, previousPhase: string }
  ]
}
```

Each entry in `pruned` corresponds to a workflow that transitioned to `cancelled` and emitted a `workflow.pruned` event.

### Step 4b: Apply (force)

On `force`, set `force: true`. Safeguards are bypassed but the bypass is recorded in the `workflow.pruned` event payload as `skippedSafeguards: [...]` so the audit trail is intact.

```typescript
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "prune_stale_workflows",
  args: {
    dryRun: false,
    force: true
  }
})
```

In force mode, workflows that were in the `skipped` list during dry-run are now eligible for pruning.

### Step 4c: Apply (abort)

On `abort`, exit without invoking the action a second time. The dry-run has not mutated any state.

### Step 5: Report Results

After the apply call returns, summarize the outcome:

```markdown
## Prune Complete

**Pruned:** 3 workflows transitioned to cancelled
**Skipped:** 2 workflows preserved by safeguards
**Force bypass:** no

### Pruned Workflows
- feat-old-experiment (was: implementing)
- oneshot-typo-fix (was: plan)
- debug-flaky-test (was: investigate)
```

If `force` was used, also list any safeguards that were bypassed:

```markdown
### Safeguards Bypassed
- feat-active-pr: open-pr
- feat-recent-work: active-branch
```

## Safeguards Explained

Two safeguards run automatically in the orchestrate handler before each cancel:

| Safeguard | Behavior | Reason key |
|---|---|---|
| **Open PR** | Skip if `gh pr list --head <branch> --state open` returns any results | `open-pr` |
| **Recent commits** | Skip if `git log --since "24 hours ago" origin/<branch>` shows commits | `active-branch` |

A workflow without a `branchName` in state (e.g., abandoned at ideate/plan before delegation) cannot have a PR or branch activity, so safeguards short-circuit and the workflow is eligible for pruning.

`force: true` bypasses both checks but does not bypass the audit -- the bypassed safeguard names are recorded in the `workflow.pruned` event payload.

## Anti-Patterns

| Don't | Do Instead |
|---|---|
| Skip the dry-run step | Always start with `dryRun: true` so the user sees candidates first |
| Auto-confirm without showing the table | Render the candidate table and wait for explicit user input |
| Use `force: true` by default | Reserve `force` for cases where the user has explicitly opted in |
| Manually call `cancel` for each stale workflow | Use this skill -- it batches the cancel loop and emits the `workflow.pruned` audit event |
| Run on every session | Pruning is a maintenance operation; run when pipeline accumulation is observable |

## Examples

### Example 1: Clean dry-run, user proceeds

```
> {{COMMAND_PREFIX}}prune

## Prune Candidates (2)

| Feature ID | Type | Phase | Stale (min) |
|---|---|---|---|
| feat-old-spike | feature | plan | 12880 |
| oneshot-readme-tweak | oneshot | implementing | 9700 |

## Skipped by Safeguards (0)

(none)

Proceed? (proceed/abort/force)

> proceed

## Prune Complete

**Pruned:** 2 workflows transitioned to cancelled
**Skipped:** 0
**Force bypass:** no

### Pruned Workflows
- feat-old-spike (was: plan)
- oneshot-readme-tweak (was: implementing)
```

### Example 2: Safeguard skip, user forces

```
> {{COMMAND_PREFIX}}prune

## Prune Candidates (1)

| Feature ID | Type | Phase | Stale (min) |
|---|---|---|---|
| feat-stale-no-pr | feature | implementing | 11200 |

## Skipped by Safeguards (1)

| Feature ID | Reason |
|---|---|
| feat-stale-with-pr | open-pr |

Proceed? (proceed/abort/force)

> force

## Prune Complete

**Pruned:** 2 workflows transitioned to cancelled
**Skipped:** 0
**Force bypass:** yes

### Pruned Workflows
- feat-stale-no-pr (was: implementing)
- feat-stale-with-pr (was: implementing)

### Safeguards Bypassed
- feat-stale-with-pr: open-pr
```

### Example 3: Empty pipeline

```
> {{COMMAND_PREFIX}}prune

No stale workflows to prune. Pipeline is clean.
```

## Schema Discovery

For the canonical argument schema and any future fields, use:

```typescript
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "describe",
  actions: ["prune_stale_workflows"]
})
```

## Exarchos Integration

The `prune_stale_workflows` action emits two events per pruned workflow:
- `workflow.cancelled` (auto-emitted by the underlying `handleCancel` path)
- `workflow.pruned` (emitted by this handler with `triggeredBy: 'manual'` and optional `skippedSafeguards`)

Both are projected into the workflow state's `_events` array by the standard projection. Downstream views can filter on `workflow.pruned` to identify batch cleanups versus user-initiated cancels.
