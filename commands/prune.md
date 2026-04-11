---
description: Prune stale workflows from the pipeline (dry-run → confirm → apply)
---

# Prune

Prune stale non-terminal workflows from the pipeline. Wraps the `prune_stale_workflows` orchestrate action with an interactive dry-run-then-confirm flow.

## When to Use

Use `/exarchos:prune` when:
- `exarchos_view pipeline` shows many inactive workflows
- The pipeline has accumulated abandoned plans, debug branches, or one-shots
- Periodic maintenance to keep the pipeline view actionable

## Skill Reference

Follow the prune-workflows skill: `@skills/prune-workflows/SKILL.md`

## Process

### Step 1: Dry-Run

Invoke the orchestrate action in dry-run mode (default):

```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "prune_stale_workflows",
  args: { dryRun: true }
})
```

### Step 2: Display Candidates

Render a table of `candidates` (feature ID, type, phase, staleness in minutes) and `skipped` (feature ID, reason). If both are empty, report "No stale workflows to prune" and exit.

### Step 3: Prompt

Ask the user one of:
- **proceed** — prune the listed candidates
- **abort** — exit without changes
- **force** — bypass safeguards and prune skipped workflows too

### Step 4: Apply

On `proceed`:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "prune_stale_workflows",
  args: { dryRun: false }
})
```

On `force`:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "prune_stale_workflows",
  args: { dryRun: false, force: true }
})
```

On `abort`: exit.

### Step 5: Report

Output the `pruned` array as a summary table along with any safeguards that were bypassed.

## Output

```markdown
## Prune Complete

**Pruned:** <count> workflows transitioned to cancelled
**Skipped:** <count> workflows preserved by safeguards
**Force bypass:** <yes/no>
```

## Safeguards

By default the orchestrate handler skips workflows that have:
- An open PR on the inferred branch (`open-pr`)
- Recent commits in the last 24 hours (`active-branch`)

`force: true` bypasses both, but the bypassed safeguard names are still recorded in the `workflow.pruned` event payload for audit.

## Error Handling

- **No state directory:** Initialize an exarchos workflow first.
- **gh/git not available:** Safeguards short-circuit with errors; consider `force: true` after manually verifying no PRs are open.
- **All workflows clean:** Output "No stale workflows to prune" and exit.
