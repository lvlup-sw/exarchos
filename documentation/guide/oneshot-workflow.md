---
outline: deep
---

# Oneshot Workflow

The oneshot workflow is a lightweight path for changes that are too small to justify the full `feature` pipeline (`ideate → plan → plan-review → delegate → review → synthesize → completed`) but still deserve event-sourced auditability and a planning step. It skips subagent dispatch and two-stage review, runs everything in-session, and commits directly by default — with an opt-in escape hatch to the standard synthesis flow if the user decides they want a PR mid-stream.

Introduced in v2.6.0 (#1010) alongside the `prune_stale_workflows` maintenance action.

## Phase chain

```text
     plan ──────► implementing ──┬── [synthesisOptedOut] ──► completed
                                 │
                                 └── [synthesisOptedIn]  ──► synthesize ──► completed
```

Four phases. The fork after `implementing` is a UML choice state implemented as two mutually-exclusive HSM transitions whose guards are pure functions of `state.oneshot.synthesisPolicy` and the `synthesize.requested` event count. Both `completed` branches are terminal; `cancelled` is reachable from any non-terminal phase via the universal cancel transition.

## When to use oneshot

Reach for oneshot when **all** of the following are true:

- The change is bounded — typically one file, or a tightly-coupled cluster of 2-3 files
- No subagent dispatch is needed — the work fits in one TDD loop in a single session
- No design document is required — the goal is obvious from the task description
- No two-stage review is required — either direct-commit is acceptable, or a single PR review suffices

Concrete fits: fixing a typo, bumping a dependency version, adding a missing null-check in one function, tweaking a CI workflow YAML, renaming a config key, adding a one-off helper script, exploratory spikes.

### When NOT to use oneshot

Use the full `feature` workflow (`/exarchos:ideate`) instead for:

- Cross-cutting refactors that touch many files or modules
- Multi-file features that benefit from subagent decomposition
- Anything that needs design exploration or competing approaches weighed
- Anything that needs spec-review + quality-review (two-stage)
- Anything that needs to coordinate with another agent team
- Changes that should land in stages (stacked PRs)

If you start a oneshot and the change turns out bigger than expected, cancel it and restart with `/exarchos:ideate`. Do not try to grow a oneshot into a feature workflow mid-stream — the playbooks have different shapes.

## Synthesis policy

The `synthesisPolicy` field on a oneshot workflow declares up-front intent about whether the change should be turned into a PR. It takes one of three values, persisted on `state.oneshot.synthesisPolicy`:

| Policy | Behavior | When to use |
|---|---|---|
| `always` | Always route `implementing → synthesize` at finalize, regardless of events. A PR is always created. | User wants a review paper trail for every change in this workflow. |
| `never` | Always route `implementing → completed` at finalize, regardless of events. No PR is created — commits go directly to the current branch. | User is iterating on scratch work and explicitly opts out of PRs. |
| `on-request` *(default)* | Direct-commit by default. The user can opt in mid-`implementing` by calling `request_synthesize`; if any `synthesize.requested` event is on the stream at finalize, the workflow routes to `synthesize` instead of `completed`. | The common case: start lightweight, leave the door open for the user to change their mind once they see the diff. |

**Policy wins over event.** If `synthesisPolicy: 'never'` is set and a `synthesize.requested` event somehow lands on the stream, the guard still routes to `completed`. The user's declared intent overrides runtime signal.

The default is `on-request` because it is the least surprising: the user gets the lightweight path until they explicitly ask for the heavy one.

## Planning phase

A oneshot plan is intentionally minimal — no design doc, no parallelization analysis, no decomposition into N tasks. Answer four questions in 5-10 lines each:

1. **Goal** — what is the user trying to accomplish?
2. **Approach** — what's the one-line implementation strategy?
3. **Files** — which files will be touched? (1-5 typically)
4. **Tests** — which test cases will be added? (named, not described)

Persist the plan and transition to `implementing` in a single call. The `oneshotPlanSet` guard requires `artifacts.plan` to be a non-empty string (whitespace trimmed); `oneshot.planSummary` is an optional pipeline-view label but does **not** satisfy the guard on its own.

## Implementing phase

Run an in-session TDD loop. The iron law from `@rules/tdd.md` applies unchanged:

> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

For each behavior in the plan:

1. **RED** — write a failing test; confirm it fails for the right reason
2. **GREEN** — write the minimum production code to make the test pass
3. **REFACTOR** — clean up while keeping the test green

Commit each RED-GREEN-REFACTOR cycle as a single atomic commit. In oneshot there is no separate review phase to catch bundled changes, so commit hygiene matters more, not less.

There is **no subagent dispatch** in oneshot. The main agent does the work directly. There is **no separate review phase**. Quality is maintained by the TDD loop and (if the user opts in) the synthesize PR review.

## The choice point

When the implementing loop is done — tests pass, typecheck clean, all commits made — call `finalize_oneshot` to resolve the choice state:

```ts
exarchos_orchestrate({
  action: "finalize_oneshot",
  featureId: "fix-readme-typo"
})
```

The handler:

1. Reads current state and verifies `workflowType === 'oneshot'` and `phase === 'implementing'`
2. Hydrates `_events` from the event store so the guard sees the same view the HSM will see at the transition boundary
3. Evaluates `guards.synthesisOptedIn` against the state (pure function of policy + events)
4. Calls `handleSet` with the resolved target phase (`synthesize` or `completed`)

The HSM re-evaluates the guard at the transition boundary, so any race between the read and the transition is caught safely. The choice is replay-safe: the decision is a pure function of inputs already persisted in the state and event store.

| `synthesisPolicy` | `synthesize.requested` event present? | Resolved target | Path |
|---|---|---|---|
| `always` | (any) | `synthesize` | PR path |
| `never` | (any) | `completed` | direct-commit path |
| `on-request` (default) | yes | `synthesize` | PR path |
| `on-request` (default) | no | `completed` | direct-commit path |

## Direct-commit path

If finalize resolved to `completed`, the commits made during implementing are already on the current branch — push them if they aren't pushed already:

```bash
git push
```

The workflow is now in `completed` and will not appear in the default pipeline view. There is no PR, no review, no synthesize phase. The audit trail lives in the event stream.

## Synthesize path (opt-in)

If at any point during `plan` or `implementing` the user asks for a PR ("actually, let's open a PR for this", "I want a review on this before it lands", "make this a PR"), call the runtime opt-in action:

```ts
exarchos_orchestrate({
  action: "request_synthesize",
  featureId: "fix-readme-typo",
  reason: "user requested review of the parser changes"
})
```

This appends a `synthesize.requested` event to the workflow's stream. Calling it does **not** transition the phase — the workflow stays in its current phase and the decision is only acted on at finalize.

`request_synthesize` is accepted from both `plan` and `implementing` phases. Terminal phases (`synthesize`, `completed`, `cancelled`) are rejected at the handler boundary. Duplicate calls are routing-idempotent but not event-idempotent: each call appends a new event, but the guard treats any count `>= 1` as "opted in" so the routing is unchanged.

When `finalize_oneshot` resolves to `synthesize`, hand off to the standard synthesis flow ([Review Process](/guide/review-process), plus the `synthesis` skill). The same `prepare_synthesis` / `validate_pr_body` / `gh pr create` machinery used by the `feature` workflow applies. After the PR merges, the workflow transitions `synthesize → completed` via the existing `mergeVerified` / `pr-url-exists` guard.

You do **not** run `/exarchos:delegate` or `/exarchos:review` on an opt-in oneshot synthesize. Those phases do not exist in the oneshot playbook. The PR review is the only review.

## Comparison with feature workflow

| Aspect | `feature` | `oneshot` |
|---|---|---|
| Phases | ideate → plan → plan-review → delegate → review → synthesize → completed | plan → implementing → `{completed \| synthesize → completed}` |
| Initial phase | `ideate` | `plan` |
| Design doc | required (`artifacts.design`) | not required |
| Plan-review | yes (human checkpoint) | no |
| Subagent dispatch | yes (`delegate`) | no — main agent only |
| Two-stage review | yes (spec + quality) | no — PR review only (if opted in) |
| Fix-cycle circuit breaker | yes (3 cycles) | no |
| PR creation | always | opt-in via `synthesisPolicy` / `request_synthesize` |
| Compound states | `implementation` (delegate + review) | none |
| Choice states | no | yes (end of `implementing`) |
| Checkpoint-resume | yes | yes |
| Human checkpoints | plan approval, merge confirmation | none (direct-commit) or merge confirmation (synthesize path) |

## Example end-to-end

```text
User: "Quick fix — typo in the README, 'recieve' should be 'receive'. Use oneshot."

Agent:
  1. exarchos_workflow init { featureId: "fix-readme-typo", workflowType: "oneshot" }
     → workflow created in 'plan', synthesisPolicy defaults to 'on-request'
  2. Writes a 4-line plan: goal=fix typo, approach=sed, files=[README.md],
     tests=[readme has no occurrence of 'recieve']
  3. exarchos_workflow set {
       featureId: "fix-readme-typo",
       phase: "implementing",
       updates: {
         "artifacts.plan": "...",
         "oneshot.planSummary": "Fix 'recieve' typo in README"
       }
     }
  4. [RED] writes a test that greps README for 'recieve', expects 0 matches — fails
  5. [GREEN] edits README, fixes typo — test passes
  6. git commit -m "docs: fix 'recieve' typo in README"
  7. exarchos_orchestrate finalize_oneshot { featureId: "fix-readme-typo" }
     → guard sees policy='on-request' + no synthesize.requested event
     → resolves to 'completed'
  8. git push
     "Done. Workflow completed via direct-commit path."
```

For a mid-implementing opt-in walkthrough and a `synthesisPolicy: 'always'` example, see `@skills/oneshot-workflow/SKILL.md`.

## References

- Skill: `@skills/oneshot-workflow/SKILL.md` — full prose walkthrough with worked examples
- HSM reference: `@skills/workflow-state/references/phase-transitions.md` — transition table, guards, prerequisites
- Design doc: `docs/designs/2026-04-11-oneshot-and-pruning.md` — rationale, non-goals, research links
- Orchestrate actions: [`request_synthesize`, `finalize_oneshot`](/reference/tools/orchestrate)
- Events: [`synthesize.requested`, `workflow.pruned`](/reference/events)
- State machine reference: [State Machine — Oneshot Workflow](/architecture/state-machine)
