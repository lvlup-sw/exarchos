---
description: Run a lightweight oneshot workflow — plan + TDD implement + optional PR
---

# Oneshot

Start a lightweight oneshot workflow for: "$ARGUMENTS"

## When to use

Reach for `/exarchos:oneshot` when the change is:

- Bounded — single file or 2-3 tightly-coupled files
- Self-contained — no subagent dispatch needed
- Obvious — no design exploration required
- Small — direct-commit acceptable, or a single PR review will suffice

Examples: typo fixes, dependency bumps, single-function null checks, CI YAML
tweaks, config key renames, exploratory spikes.

For anything cross-cutting, multi-file, or needing two-stage review, use
`/exarchos:ideate` instead.

## Skill Reference

Follow the oneshot workflow skill: `@skills/oneshot-workflow/SKILL.md`

## Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

TDD applies to oneshot workflows. There is no exemption for "small" changes —
the test is what makes the change auditable.

## Workflow position

```
plan ──► implementing ──┬── [direct-commit] ──► completed
                        │
                        └── [opt-in PR]     ──► synthesize ──► completed
```

Choice state at the end of `implementing` is decided by `synthesisPolicy`
(set at init) plus any `synthesize.requested` events on the stream.

## Process

### Step 1: Init

Initialize a oneshot workflow using
`mcp__plugin_exarchos_exarchos__exarchos_workflow` with
`action: "init"`, `workflowType: "oneshot"`, a `featureId`, and optionally
`synthesisPolicy: "always" | "never" | "on-request"` (default: `"on-request"`).

If the user has stated a clear preference ("I want a PR for this" → `always`;
"don't open a PR" → `never`), pass it explicitly. Otherwise rely on the
default and let the user opt in mid-implementing if they change their mind.

### Step 2: Plan

Produce a one-page plan with four sections:

1. **Goal** — what the user is trying to accomplish (1-2 lines)
2. **Approach** — implementation strategy (1-2 lines)
3. **Files** — which files will change (1-5)
4. **Tests** — which tests will be added (named, not described)

Persist via `mcp__plugin_exarchos_exarchos__exarchos_workflow` with
`action: "set"`:

- Set `artifacts.plan` to the plan text
- Set `oneshot.planSummary` to a one-line summary
- Set `phase` to `"implementing"`

### Step 3: Implementing — in-session TDD loop

For each behavior in the plan:

1. **[RED]** Write a failing test. Run it. Confirm it fails for the right reason.
2. **[GREEN]** Write minimum code to pass. Run the test. Confirm green.
3. **[REFACTOR]** Clean up while keeping tests green.

Commit each cycle as a single atomic commit. No subagent dispatch — the main
agent does the work directly.

### Step 4: Mid-implementing opt-in (optional)

If the user says something like "actually, let's open a PR for this" or "I
want a review on this", call:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "request_synthesize",
  featureId: "<id>",
  reason: "<why the user wants a PR>"
})
```

This appends a `synthesize.requested` event. The workflow stays in
`implementing` — the choice is only acted on at finalize.

### Step 5: Finalize

When all tests pass and typecheck is clean, call:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "finalize_oneshot",
  featureId: "<id>"
})
```

The handler evaluates `synthesisPolicy` + events and transitions to either
`synthesize` (PR path) or `completed` (direct-commit path). Outcomes:

| Policy | Event present? | Resolved phase |
|---|---|---|
| `always` | (any) | `synthesize` |
| `never` | (any) | `completed` |
| `on-request` | yes | `synthesize` |
| `on-request` | no | `completed` |

### Step 6a: Direct-commit path (`completed`)

Push the commits if not already pushed:

```bash
git push
```

Workflow is terminal — done.

### Step 6b: Synthesize path

Hand off to the standard synthesis flow: `@skills/synthesis/SKILL.md`. The
existing `prepare_synthesis` / `validate_pr_body` / `gh pr create` machinery
applies. After PR merge, the workflow transitions `synthesize → completed`.

You do **not** need to run `/exarchos:delegate` or `/exarchos:review` for an
opt-in oneshot synthesize — those phases are not in the oneshot playbook.

## When NOT to use oneshot

| Symptom | Use instead |
|---|---|
| Cross-cutting refactor | `/exarchos:refactor` or `/exarchos:ideate` |
| Multi-file feature | `/exarchos:ideate` |
| Needs design exploration | `/exarchos:ideate` |
| Needs two-stage review | `/exarchos:ideate` |
| Coordinates multiple agents | `/exarchos:ideate` + `/exarchos:delegate` |
| Should land in stages | `/exarchos:ideate` (stacked PRs) |

If you start a oneshot and discover it's bigger than expected: cancel and
restart with `/exarchos:ideate`. Don't try to grow a oneshot into a feature
workflow mid-stream.

## Output

Direct-commit path:
```markdown
## Oneshot Complete (direct-commit)

Workflow: <featureId>
Plan: <one-line summary>
Tests added: N
Commits: <hash list>
Path: direct-commit
```

Synthesize path:
```markdown
## Oneshot Complete (synthesize)

Workflow: <featureId>
PR: <url>
Tests: X pass | Build: 0 errors
Path: synthesize → PR review → merge
```
