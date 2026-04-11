---
name: oneshot-workflow
description: "Lightweight workflow for straightforward changes — plan → implement → optional PR. Direct-commit by default; synthesize is opt-in via synthesisPolicy or a runtime request_synthesize event. Use for trivial fixes, config tweaks, single-file changes, or exploratory work that doesn't warrant subagent dispatch or two-stage review. Triggers: 'oneshot', 'quick fix', 'small change', or {{COMMAND_PREFIX}}oneshot."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: plan
---

# Oneshot Workflow Skill

A lean, four-phase workflow type for changes that are too small to justify the
full `feature` flow (`ideate → plan → delegate → review → synthesize`) but
still deserve event-sourced auditability and a planning step. The workflow is
**direct-commit by default** with an opt-in PR path; the choice between the
two is resolved at the end of `implementing` via a pure event-sourced guard,
not a heuristic.

> **Read this first if you have never run a oneshot:** the workflow has a
> *choice state* at the end of `implementing`. Whether you land on
> `completed` (direct commit) or transition through `synthesize` (PR) is
> decided by two inputs: the `synthesisPolicy` set at init, and whether the
> user emitted a `synthesize.requested` event during implementing. Both
> inputs are persisted; the decision is replay-safe.

## When to use oneshot

Reach for oneshot when **all** of the following are true:

- The change is bounded — typically a single file, or a tightly-coupled
  cluster of 2-3 files
- No subagent dispatch is needed — the work fits comfortably in one TDD
  loop in a single session
- No design document is required — the goal is obvious from the task
  description, and a one-page plan is enough scaffolding
- No two-stage review is required — either the change is trivial enough
  that direct-commit is acceptable, or a single PR review will suffice

Concrete examples that fit oneshot:
- Fixing a typo in a README
- Bumping a dependency version
- Adding a missing null-check in one function
- Tweaking a CI workflow YAML
- Renaming a config key everywhere it's referenced
- Adding a one-off helper script
- Exploratory spikes that may or may not be kept

## When NOT to use oneshot

Do not use oneshot for any of the following — use the full `feature`
workflow instead (`{{COMMAND_PREFIX}}ideate`):

- Cross-cutting refactors that touch many files or modules
- Multi-file features that benefit from subagent decomposition
- Anything that needs design exploration or competing approaches weighed
- Anything that needs spec-review + quality-review (two-stage)
- Anything that needs to coordinate with another agent team
- Changes that should land in stages (stacked PRs)
- Anything where you'd want a written design doc to look back at

If you start a oneshot and discover the change is bigger than expected, the
right move is `{{COMMAND_PREFIX}}cancel` and restart with `{{COMMAND_PREFIX}}ideate`.
Don't try to grow a oneshot into a feature workflow mid-stream; the
playbooks have different shapes and you'll fight the state machine.

## Synthesis policy — three options

The `synthesisPolicy` field on a oneshot workflow declares the user's
intent up front about whether the change should be turned into a PR. It
takes one of three values, persisted on `state.oneshot.synthesisPolicy`:

| Policy | Behavior | When to use |
|---|---|---|
| `always` | Always transition `implementing → synthesize` at finalize, regardless of events. A PR is always created. | The user wants a paper trail / review for every change in this workflow, even small ones. |
| `never` | Always transition `implementing → completed` at finalize, regardless of events. No PR is created — commits go directly to the current branch. | The user is iterating on personal/scratch work and explicitly opts out of PRs. |
| `on-request` *(default)* | Direct-commit by default. The user can opt in to a PR mid-implementing by calling `request_synthesize`; if any `synthesize.requested` event is on the stream at finalize, the workflow transitions to `synthesize` instead of `completed`. | The common case: start with the assumption of direct-commit, but leave the door open for the user to change their mind once they see the diff. |

The default is `on-request` because it's the least surprising: the user
gets the lightweight path until they explicitly ask for the heavy one.

**Policy wins over event.** If `synthesisPolicy: 'never'` is set and a
`synthesize.requested` event is somehow on the stream (e.g. the user
called the action on a workflow they thought was `on-request`), the
guard still routes to `completed`. Policy is the user's declared intent
and overrides runtime signal.

## Lifecycle

```
     plan ──────► implementing ──┬── [synthesisOptedOut] ──► completed
                                 │
                                 └── [synthesisOptedIn]  ──► synthesize ──► completed
```

Four phases. The fork after `implementing` is a UML *choice state*,
implemented via two mutually-exclusive HSM transitions whose guards are
pure functions of `state.oneshot.synthesisPolicy` and the
`synthesize.requested` event count.

| Phase | What happens | Exit criteria |
|---|---|---|
| `plan` | Lightweight one-page plan: goal, approach, files to touch, tests to add. No design doc. No subagent dispatch. | `artifacts.plan` set → transition to `implementing` |
| `implementing` | In-session TDD loop. Write a failing test, make it pass, refactor. Commit as you go. The TDD iron law applies — *no production code without a failing test first*. | Tests pass + typecheck clean + finalize_oneshot called |
| `synthesize` | Reached **only** when `synthesisOptedIn` is true. Hands off to the existing synthesis flow — see `@skills/synthesis/SKILL.md`. PR created via `gh pr create`, auto-merge enabled, CI gates apply. | PR merged → `completed` |
| `completed` | Terminal. For direct-commit path, commits are already on the branch — there's nothing more to do. For synthesize path, the PR merge event terminates the workflow. | — |

`cancelled` is also reachable from any phase via the universal cancel
transition, same as every other workflow type.

## Step-by-step

### Step 1 — Init

Call `exarchos_workflow` with `action: 'init'`, `workflowType: 'oneshot'`,
and an optional `synthesisPolicy`:

```typescript
{{MCP_PREFIX}}exarchos_workflow({
  action: "init",
  featureId: "fix-readme-typo",
  workflowType: "oneshot",
  synthesisPolicy: "on-request" // optional — defaults to 'on-request'
})
```

If the user has been clear up front ("I want a PR for this"), pass
`synthesisPolicy: "always"`. If they've been clear ("don't open a PR,
just commit it"), pass `synthesisPolicy: "never"`. Otherwise, omit the
field and rely on the `on-request` default — you can always escalate
later in the implementing phase.

The init returns the new workflow state; the workflow lands in `plan`.

### Step 2 — Plan phase

Produce a one-page plan. This is intentionally lightweight — no design
doc, no parallelization analysis, no decomposition into N tasks. The
plan should answer four questions in 5-10 lines each:

1. **Goal** — what is the user trying to accomplish?
2. **Approach** — what's the one-line implementation strategy?
3. **Files** — which files will be touched? (1-5 typically)
4. **Tests** — which test cases will be added? (named, not described)

Persist the plan and transition to `implementing` in a single set call:

```typescript
{{MCP_PREFIX}}exarchos_workflow({
  action: "set",
  featureId: "fix-readme-typo",
  updates: {
    "artifacts": { "plan": "<plan text>" },
    "oneshot": { "planSummary": "<one-line summary>" },
    "phase": "implementing"
  }
})
```

The plan goes on `artifacts.plan` for parity with the `feature` workflow;
the human-readable one-liner goes on `oneshot.planSummary` for the
pipeline view.

### Step 3 — Implementing phase

Run an in-session TDD loop. Same iron law as every other workflow:

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

For each behavior in the plan:

1. **[RED]** Write a failing test. Run the test. Confirm it fails for
   the right reason.
2. **[GREEN]** Write the minimum production code to make the test pass.
   Run the test. Confirm it passes.
3. **[REFACTOR]** Clean up while keeping the test green.

Commit each red-green-refactor cycle as a single commit. Do not batch
multiple unrelated changes into one commit — keeping commits atomic
matters even more in oneshot, where there's no separate review phase
to catch bundled changes.

There is **no subagent dispatch** in oneshot. The main agent does the
work directly. There is **no separate review phase**. Quality is
maintained by the TDD loop and (if the user opts in) the synthesize PR
review.

#### Mid-implementing: opting in to a PR

If at any point during implementing the user decides they want a PR
after all (policy is `on-request`, default), they can opt in by calling
the `request_synthesize` orchestrate action:

```typescript
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "request_synthesize",
  featureId: "fix-readme-typo",
  reason: "user requested review of the parser changes"
})
```

**The trigger for this is conversational, not a magic keyword.** Listen
for phrases like:
- "actually, let's open a PR for this"
- "I want a review on this before it lands"
- "make this a PR"
- "let's get eyes on this"
- "synthesize this"

When you hear any of those, call `request_synthesize` immediately. The
handler appends a `synthesize.requested` event to the workflow's event
stream; the `synthesisOptedIn` guard reads the stream at finalize and
routes accordingly. This is **idempotent** — calling
`request_synthesize` twice appends two events but the guard treats any
count >= 1 as "opted in", so duplicate calls are benign.

Calling `request_synthesize` does **not** transition the phase. The
workflow stays in `implementing`. The decision is only acted on when
you call `finalize_oneshot` in step 4.

### Step 4 — Finalize (the choice point)

When the implementing loop is done — tests pass, typecheck clean, all
commits made — call `finalize_oneshot` to resolve the choice state:

```typescript
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "finalize_oneshot",
  featureId: "fix-readme-typo"
})
```

The handler:

1. Reads the current state and verifies `workflowType === 'oneshot'` and
   `phase === 'implementing'`.
2. Hydrates `_events` from the event store so the guard sees the same
   view the HSM will see during the actual transition.
3. Evaluates `guards.synthesisOptedIn` against the state. The guard
   inspects `state.oneshot.synthesisPolicy` and the `_events` array.
4. Calls `handleSet` with the resolved target phase (`synthesize` or
   `completed`). The HSM re-evaluates the guard at the transition
   boundary, so any race between the read and the transition is caught
   safely.

Possible outcomes:

| `synthesisPolicy` | `synthesize.requested` event present? | Resolved target | Path |
|---|---|---|---|
| `always` | (any) | `synthesize` | PR path |
| `never` | (any) | `completed` | direct-commit path |
| `on-request` (default) | yes | `synthesize` | PR path |
| `on-request` (default) | no | `completed` | direct-commit path |

### Step 5a — Direct-commit path (terminal)

If finalize resolved to `completed`, you're done. The commits made
during implementing are already on the current branch. Push them if
they aren't already pushed:

```bash
git push
```

The workflow is now in `completed` and will not appear in the default
pipeline view.

### Step 5b — Synthesize path

If finalize resolved to `synthesize`, hand off to the standard synthesis
flow — see `@skills/synthesis/SKILL.md`. The same `prepare_synthesis` /
`validate_pr_body` / `gh pr create` machinery used by the `feature`
workflow applies. After the PR merges, the workflow transitions
`synthesize → completed` via the existing `mergeVerified` guard, same as
every other workflow type.

You do **not** need to run `{{COMMAND_PREFIX}}delegate` or
`{{COMMAND_PREFIX}}review` for an opt-in oneshot synthesize. Those phases
do not exist in the oneshot playbook. The PR review is the only review.

## Example invocations

### Example A — Direct-commit (default `on-request` policy, no opt-in)

```
User: "Quick fix — there's a typo in the README, 'recieve' should be 'receive'.
       Use oneshot."

Agent:
  1. exarchos_workflow init { featureId: "fix-readme-typo", workflowType: "oneshot" }
     → workflow created in 'plan' phase, synthesisPolicy defaults to 'on-request'
  2. Produces a 4-line plan: goal=fix typo, approach=sed, files=[README.md],
     tests=[readme has no occurrence of 'recieve']
  3. exarchos_workflow set { artifacts.plan, oneshot.planSummary, phase: 'implementing' }
  4. [RED] writes test that greps README for 'recieve' and expects 0 matches
        — fails (1 match exists)
  5. [GREEN] edits README, fixes typo
        — test passes
  6. git commit -m "docs: fix 'recieve' typo in README"
  7. exarchos_orchestrate finalize_oneshot { featureId: "fix-readme-typo" }
     → guard sees policy='on-request' + no synthesize.requested event
     → resolves to 'completed'
  8. git push
     "Done. Workflow completed via direct-commit path."
```

### Example B — Mid-implementing opt-in (`on-request` → user changes mind)

```
User: "Add input validation to the parseConfig helper. Oneshot."

Agent:
  1. exarchos_workflow init { workflowType: "oneshot" }
     → 'plan' phase, default 'on-request'
  2. plans (goal: validate input, files: [parser.ts, parser.test.ts])
  3. transitions to 'implementing'
  4. [RED] writes test for null-input case
  5. [GREEN] adds null check
  6. [REFACTOR] extracts validateInput helper
  7. commits

User: "Actually, this is touching the parser — I want a review on it before
       it lands."

Agent:
  8. exarchos_orchestrate request_synthesize {
       featureId, reason: "user requested review of parser changes"
     }
     → appends synthesize.requested event
  9. exarchos_orchestrate finalize_oneshot { featureId }
     → guard sees policy='on-request' + 1 synthesize.requested event
     → resolves to 'synthesize'
 10. hands off to @skills/synthesis/SKILL.md → prepare_synthesis →
     validate_pr_body → gh pr create → merge
```

### Example C — `synthesisPolicy: 'always'` (PR mandatory)

```
User: "I want a PR for any change to the auth module, even small ones.
       Use oneshot but always make a PR."

Agent:
  1. exarchos_workflow init {
       workflowType: "oneshot",
       synthesisPolicy: "always"
     }
  2-7. plan + TDD + commits, identical to Example A
  8. exarchos_orchestrate finalize_oneshot { featureId }
     → guard sees policy='always' (short-circuits — no event check needed)
     → resolves to 'synthesize'
  9. synthesis flow → PR
```

## State management

Track oneshot-specific state under the `oneshot` key on the workflow state:

```typescript
{{MCP_PREFIX}}exarchos_workflow({
  action: "set",
  featureId: "<id>",
  updates: {
    "oneshot": {
      "synthesisPolicy": "on-request",
      "planSummary": "Fix off-by-one in pagination helper"
    }
  }
})
```

The `synthesisPolicy` field is optional and defaults to `'on-request'` per
the schema in `servers/exarchos-mcp/src/workflow/schemas.ts`. Setting it
explicitly is recommended when the user has stated a preference.

## Phase Transitions and Guards

For the full transition table for oneshot, consult
`@skills/workflow-state/references/phase-transitions.md`.

**Quick reference for oneshot:**

| From | To | Guard |
|---|---|---|
| `plan` | `implementing` | `planApproved` (or `oneshotPlanSet`, checks `artifacts.plan` presence) |
| `implementing` | `synthesize` | `synthesisOptedIn` |
| `implementing` | `completed` | `synthesisOptedOut` |
| `synthesize` | `completed` | `mergeVerified` |
| (any) | `cancelled` | universal — always allowed |

`synthesisOptedIn` and `synthesisOptedOut` are pure functions of
`state.oneshot.synthesisPolicy` and `state._events`. They are mutually
exclusive across all 8 (3 policies × event-present/absent, with `always`
and `never` ignoring the event flag) combinations — exactly one returns
true at any given time.

### Schema discovery

Use `exarchos_workflow({ action: "describe", actions: ["init", "set"] })`
for parameter schemas (including the `synthesisPolicy` enum) and
`exarchos_workflow({ action: "describe", playbook: "oneshot" })` for the
phase transitions, guard names, and playbook prose. Use
`exarchos_orchestrate({ action: "describe", actions: ["request_synthesize", "finalize_oneshot"] })`
for the orchestrate action schemas.

## TDD is still mandatory

The iron law from `@rules/tdd.md` applies to oneshot. There is no
exemption for "small" changes. Specifically:

- Every behavior change starts with a failing test
- Every test must fail before its implementation is written
- Tests must be run after each change to verify state
- Commits stay atomic — one logical change per commit

The temptation in a oneshot is to skip the test "because it's just one
line". Resist that. The test is what makes the change auditable, and
auditability is the entire reason oneshot exists alongside the lighter
"bypass workflows entirely" path.

## Anti-patterns

| Don't | Do Instead |
|-------|------------|
| Skip the plan phase ("it's obvious") | Write the four-line plan anyway — it's the artifact future-you reads |
| Skip the TDD loop in implementing | Always RED → GREEN → REFACTOR, even for one-liners |
| Use oneshot for multi-file refactors | Use `{{COMMAND_PREFIX}}ideate` and the full feature workflow |
| Try to grow a oneshot into a feature workflow mid-stream | Cancel and restart with `{{COMMAND_PREFIX}}ideate` |
| Call `request_synthesize` without listening for the user's intent | Wait for the user to ask for a PR, then call it |
| Bundle unrelated changes into one commit "since it's a oneshot" | Keep commits atomic — there's no review phase to catch bundling |
| Forget to call `finalize_oneshot` at the end | The workflow stays in `implementing` forever otherwise — call it explicitly |

## Completion criteria

- [ ] `exarchos_workflow init` called with `workflowType: "oneshot"`
- [ ] One-page plan persisted to `artifacts.plan`
- [ ] Phase transitioned to `implementing`
- [ ] All planned behaviors implemented via TDD with atomic commits
- [ ] `finalize_oneshot` called and resolved to either `completed` or `synthesize`
- [ ] If direct-commit path: commits pushed
- [ ] If synthesize path: PR created via `@skills/synthesis/SKILL.md` and merged
