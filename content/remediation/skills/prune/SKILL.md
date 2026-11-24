---
name: prune
description: "Interactively prune stale non-terminal workflows from the pipeline. Use when the user says 'prune workflows', 'clean stale workflows', 'pipeline cleanup', or runs /prune. Runs a dry-run preview, displays candidates with staleness and safeguard skips, prompts the user to proceed/abort/force, then bulk-cancels approved workflows with a workflow.pruned audit event. The safeguard skips workflows with recent commits unless force is set. The agent checks for open PRs with its own tools before it applies."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: maintenance
---

# Prune Workflows Skill

## VCS Provider

Exarchos reads no PR, CI or review state, and it does no VCS write.
The prune action does not check for open PRs. You own that check: before you
apply a prune, read the open PRs of each candidate branch with your own tools:
`gh` for GitHub (for example `gh pr list --head <branch> --state open`),
`glab` for GitLab, `az repos` for Azure DevOps. See Step 2b.

## Overview

Bulk-cancel stale non-terminal workflows that have accumulated in the pipeline. Wraps the `prune_stale_workflows` orchestrate action with an interactive dry-run-then-confirm UX so the user always sees the candidate set before any state mutates.

Pruning is a maintenance operation -- not a workflow phase. It produces `workflow.pruned` events alongside the standard `workflow.cancelled` events emitted by the underlying cancel path, so downstream views can distinguish user-intent cancellations from batch cleanup.

## Triggers

Activate this skill when:
- User runs `prune` command
- User says "prune workflows", "clean stale workflows", "pipeline cleanup"
- `exarchos:exarchos_view({ action: "pipeline", scope: "all" })` shows many inactive workflows the user wants to clear in bulk. Prune observes candidates with `scope: "all"` because the default view is repo-scoped and hides the *legacy* rows (workflows started before repo identity was recorded) that prune exists to drain — a repo-scoped observation would miss the very inventory it targets.

## Prerequisites

- An exarchos state directory with one or more non-terminal workflows
- For the open PR check: your own PR tool (for example `gh`)
- For the safeguard check against branch activity: `git` available in PATH

## Process

### Step 1: Dry-Run Preview

Always start with `dryRun: true`. This call performs candidate selection and safeguard evaluation but does not mutate any workflow state.

```typescript
exarchos:exarchos_orchestrate({
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
    { featureId: string, reason: "active-branch" }
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

## Skipped by Safeguard (1)

| Feature ID | Reason |
|---|---|
| feat-recent-work | active-branch |
```

If `candidates.length === 0` AND `skipped.length === 0`, output:

> No stale workflows to prune. Pipeline is clean.

Then exit -- no further action.

### Step 2b: Check for Open PRs

For each candidate with a branch, read its open PRs with your own tools.
Show each candidate that has an open PR to the user. Apply mode prunes every
candidate, so do not proceed while a candidate has an open PR unless the user
accepts that it will be cancelled. An open PR means that work on the feature
is still in progress.

### Step 3: Prompt for Confirmation

Ask the user one of three choices:

> **proceed** -- prune the listed candidates (skipped workflows stay)
> **abort** -- exit without changes
> **force** -- bypass the safeguard and prune skipped workflows too

Wait for explicit user input. Do **not** auto-proceed.

### Step 4a: Apply (proceed)

On `proceed`, invoke the same action with `dryRun: false`. Pass through `thresholdMinutes` and `includeOneShot` if the user set them in Step 1.

```typescript
exarchos:exarchos_orchestrate({
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

On `force`, set `force: true`. The safeguard is bypassed but the bypass is recorded in the `workflow.pruned` event payload as `skippedSafeguards: [...]` so the audit trail is intact.

```typescript
exarchos:exarchos_orchestrate({
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
**Skipped:** 1 workflow preserved by the safeguard
**Force bypass:** no

### Pruned Workflows
- feat-old-experiment (was: implementing)
- oneshot-typo-fix (was: plan)
- debug-flaky-test (was: investigate)
```

If `force` was used, also list the workflows whose safeguard was bypassed:

```markdown
### Safeguards Bypassed
- feat-recent-work: active-branch
```

## Safeguards Explained

One safeguard runs automatically in the orchestrate handler before each cancel:

| Safeguard | Behavior | Reason key |
|---|---|---|
| **Recent commits** | Skip if `git log --since "24 hours ago" origin/<branch>` shows commits | `active-branch` |

The handler reads no PR. You check for open PRs with your own tools before you apply (Step 2b).

A workflow without a `branchName` in state (e.g., abandoned at ideate/plan before delegation) has no branch activity, so the safeguard short-circuits and the workflow is eligible for pruning.

`force: true` bypasses the check but does not bypass the audit -- the bypassed safeguard name is recorded in the `workflow.pruned` event payload. Events from older versions can also name `open-pr`.

## Error Handling

- **No state directory:** initialize an exarchos workflow first — there is nothing to prune.
- **`git` not available:** the safeguard keeps the candidate with reason `active-branch`. Verify the branch activity manually, then re-run with `force: true`.
- **No PR tool available:** verify manually that no candidate has an open PR before you apply.
- **All workflows clean:** report "No stale workflows to prune" and exit (see Example 3).

## Anti-Patterns

| Don't | Do Instead |
|---|---|
| Skip the dry-run step | Always start with `dryRun: true` so the user sees candidates first |
| Auto-confirm without showing the table | Render the candidate table and wait for explicit user input |
| Apply without the open PR check | Read the open PRs of each candidate branch with your own tools first |
| Use `force: true` by default | Reserve `force` for cases where the user has explicitly opted in |
| Manually call `cancel` for each stale workflow | Use this skill -- it batches the cancel loop and emits the `workflow.pruned` audit event |
| Run on every session | Pruning is a maintenance operation; run when pipeline accumulation is observable |

## Examples

### Example 1: Clean dry-run, user proceeds

```
> prune

## Prune Candidates (2)

| Feature ID | Type | Phase | Stale (min) |
|---|---|---|---|
| feat-old-spike | feature | plan | 12880 |
| oneshot-readme-tweak | oneshot | implementing | 9700 |

## Skipped by Safeguard (0)

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
> prune

## Prune Candidates (1)

| Feature ID | Type | Phase | Stale (min) |
|---|---|---|---|
| feat-stale-quiet | feature | implementing | 11200 |

## Skipped by Safeguard (1)

| Feature ID | Reason |
|---|---|
| feat-stale-busy | active-branch |

Proceed? (proceed/abort/force)

> force

## Prune Complete

**Pruned:** 2 workflows transitioned to cancelled
**Skipped:** 0
**Force bypass:** yes

### Pruned Workflows
- feat-stale-quiet (was: implementing)
- feat-stale-busy (was: implementing)

### Safeguards Bypassed
- feat-stale-busy: active-branch
```

### Example 3: Empty pipeline

```
> prune

No stale workflows to prune. Pipeline is clean.
```

## Schema Discovery

For the canonical argument schema and any future fields, use:

```typescript
exarchos:exarchos_orchestrate({
  action: "describe",
  actions: ["prune_stale_workflows"]
})
```

## Exarchos Integration

The `prune_stale_workflows` action emits two events per pruned workflow:
- `workflow.cancelled` (auto-emitted by the underlying `handleCancel` path)
- `workflow.pruned` (emitted by this handler with `triggeredBy: 'manual'` and optional `skippedSafeguards`)

Both are projected into the workflow state's `_events` array by the standard projection. Downstream views can filter on `workflow.pruned` to identify batch cleanups versus user-initiated cancels.
