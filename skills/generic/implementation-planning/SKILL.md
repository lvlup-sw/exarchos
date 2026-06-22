---
name: implementation-planning
description: "Transform design documents into implementation plans with parallelizable tasks. Triggers: 'plan implementation', 'create tasks from design', or /plan. Applies the verification ladder: verification depth matches each task's blast radius — static analysis for low-risk tasks, scoped tests plus a kill-probe for medium, the integration suite on top for high-risk surfaces (judged test-after, not test-first ordering). Requires an existing design document — use /ideate first if none exists. Do NOT use for brainstorming, debugging, or code review."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: plan
---

# Implementation Planning Skill

## Overview

Transform design documents into TDD-based implementation plans with granular, parallelizable tasks. Ensures complete spec coverage through explicit traceability.

For a complete worked example, see `references/worked-example.md`.

## Triggers

Activate this skill when:
- User runs `plan` command
- User wants to break down a design into tasks
- A design document exists and needs implementation steps
- User says "plan the implementation" or similar
- Auto-chained from `ideate` after design completion
- Auto-chained from plan-review with `--revise` flag (gaps found)

## Revision Mode (--revise flag)

When invoked with `--revise`, plan-review found gaps. Read `.planReview.gaps` from state, re-read the design, add tasks to address each gap, update the plan file, then clear gaps via `mcp__exarchos__exarchos_workflow` `action: "update"`.

### Revision Loop Guard

Max revisions: 3 per plan.

After 3 failed revisions:
1. Set `planReview.revisionsExhausted = true`
2. Output: "Plan revision failed after 3 attempts. Design may be incomplete."
3. Escalate: Suggest `ideate --redesign` to revisit design

> **MANDATORY:** Before accepting any rationalization for skipping tests, planning, or TDD steps, consult `references/rationalization-refutation.md`. Every common excuse is catalogued with a counter-argument and the correct action.

## The Verification Ladder

Verification depth matches blast radius. The deeper rungs add tests, an adequacy kill-probe, and integration coverage — judged by **outcome, test-after**, not by a universal failing-test-first law (#1587). Each task gets the cheapest verification that still captures its risk:

| Risk tier | What it adds | Why |
|-----------|--------------|-----|
| **low** | Static analysis (typecheck + lint) suffices | A docs/config/rename-only edit has near-zero blast radius; a test ceremony is pure overhead. |
| **medium** | Scoped tests + the `check_test_adequacy` kill-probe | The kill-probe recaptures test-first's one real guarantee — that a test can actually fail — at lower cost, judged test-after instead of mandating a failing test first on every commit. |
| **high** | The integration suite (and mutation-adequacy at the boundary) on top of medium | Schema/type/API/shared-contract surfaces span the codebase; here adequacy-judged coverage plus real-collaborator integration across the seam earns its cost. |

The planner stamps each task's `riskTier` (and `boundaryTouching`); the classifier derives it from blast radius when the planner does not override. The dispatched implementer prompt and the gate sequence both scale off that stamp — so the verification effort is data-driven, not a blanket rule.

For a **high-tier** task, the discipline is **outcome-based** (write the behavior and its tests in whatever order is natural — test-after is fine):
1. Cover the new/changed behavior with scoped tests that pin its contract
2. Let the `check_test_adequacy` kill-probe prove the tests can actually fail (it reverts your source and asserts at least one test goes red)
3. Add real-collaborator integration coverage across the seam

**Verify high-tier test adequacy** after implementation — the keeper gate (the test-FIRST ordering gate `check_tdd_compliance` was retired in #1587):

```typescript
exarchos_orchestrate({
  action: "check_test_adequacy",
  featureId: "<featureId>",
  taskId: "<taskId>",
  branch: "feature/<name>",
  riskTier: "high"
})
```

- **`passed: true`** — Reverting the task's source makes at least one new/changed test fail: the tests are not vacuous
- **`passed: false`** — A test still passes against the reverted source; strengthen it

## Planning Process

### Step 1: Analyze Design Document

Read the design document thoroughly. For each major section, extract:
- **Problem Statement** — Context (no tasks, but informs scope)
- **Chosen Approach** — Architectural decisions to implement
- **Technical Design** — Core implementation requirements
- **Integration Points** — Integration and glue code tasks
- **Testing Strategy** — Test coverage requirements
- **Open Questions** — Decisions to resolve or explicitly defer

### Step 1.5: Spec Tracing (Required)

Create a traceability matrix mapping design sections to planned tasks.
Consult `references/spec-tracing-guide.md` for the methodology and template.

**Pre-populate the matrix** using the traceability generator script:

```typescript
exarchos_orchestrate({
  action: "generate_traceability",
  designFile: "docs/designs/<feature>.md",
  planFile: "docs/plans/<date>-<feature>.md",
  output: "docs/plans/<date>-<feature>-traceability.md"
})
```

- **`passed: true`** — Matrix generated; review and fill in "Key Requirements" column
- **`passed: false`** — Parse error; design document may lack expected `##`/`###` headers

### Step 2: Decompose into Tasks

Each task follows the TDD format in `references/task-template.md`.

**Granularity Guidelines:**
- Each task: 2-5 minutes of focused work
- One test = one behavior
- Prefer many small tasks over few large ones

Assign a `testingStrategy` to each task using `references/testing-strategy-guide.md` to control which verification techniques agents apply. Auto-determine `propertyTests` and `benchmarks` flags by matching each task's description and file paths against the category tables — do not leave these for the implementer to decide.

**Task Ordering:**
1. Foundation first (types, interfaces, data structures)
2. Core behaviors second
3. Edge cases and error handling third
4. Integration and glue code last

### Step 3: Identify Parallelization

Analyze dependencies to find sequential chains and parallel-safe groups that can run simultaneously in worktrees.

### Step 4: Generate Plan Document

Save to: `docs/plans/YYYY-MM-DD-<feature>.md`
Use the template from `references/plan-document-template.md`.

> For features authored under the unified-artifact flow (design + plan in one depth-scaled document under `docs/specs/`), use `references/spec-template.md` instead — its `## Decomposition` section carries the same task breakdown, with traceability resolved within the single document.

### Step 5: Plan Verification

Run deterministic verification scripts instead of manual checklist review.

**5a. Design-to-plan coverage** — verify every Technical Design subsection maps to a task:

```typescript
exarchos_orchestrate({
  action: "check_plan_coverage",
  featureId: "<id>",
  designPath: "docs/designs/<feature>.md",
  planPath: "docs/plans/<date>-<feature>.md"
})
```

- **passed: true** — All design sections covered; proceed to 5a-ii
- **passed: false** — Gaps found; add tasks for uncovered sections or defer with rationale
- **error** — Usage error or empty design; check arguments

**5a-ii. Provenance chain verification** — verify every DR-N requirement maps to a task via `Implements:` field:

```typescript
exarchos_orchestrate({
  action: "check_provenance_chain",
  featureId: "<id>",
  designPath: "docs/designs/<feature>.md",
  planPath: "docs/plans/<date>-<feature>.md"
})
```

- **passed: true** — All DR-N requirements traced; proceed to 5b
- **passed: false** — **Block:** gaps or orphan references found. Add `**Implements:** DR-N` to tasks for each uncovered requirement before proceeding. Every DR-N requirement MUST trace to at least one task.
- **error** — No DR-N identifiers in design (exit 2); if design doesn't use DR-N identifiers, this check is skipped (exempt)

**5a-iii. D5: Task decomposition quality (advisory)** — verify each task has clear description, file targets, and test expectations; dependency graph is a valid DAG; parallelizable tasks don't modify the same files:

```typescript
exarchos_orchestrate({
  action: "check_task_decomposition",
  featureId: "<id>",
  planPath: "docs/plans/<date>-<feature>.md"
})
```

- **passed: true** — All tasks well-decomposed; proceed to 5b
- **passed: false** — Findings recorded as D5 gate events for the ConvergenceView. Present findings to the user for awareness but do not block plan approval.
- **error** — Input error (missing file, no task headers); check arguments

**Advisory:** This gate verifies task structure quality but does not block plan approval. Findings are recorded for convergence tracking.

**5b. Spec coverage check** — verify planned test files exist and pass:

```typescript
exarchos_orchestrate({
  action: "spec_coverage_check",
  planFile: "docs/plans/<date>-<feature>.md",
  repoRoot: ".",
  threshold: 80
})
```

- **`passed: true`** — All planned tests found and passing; plan verification complete
- **`passed: false`** — Missing test files or test failures; create missing tests or fix failures

For reference, consult `references/spec-tracing-guide.md` for the underlying methodology.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Ship medium/high-tier behavior with no tests | Cover it with adequacy-judged tests (test-after is fine) |
| Mandate red-green-refactor on every task | Scale verification to the task's `riskTier`; RGR is a high-tier opt-in |
| Create large tasks | Break into 2-5 min chunks |
| Skip dependency analysis | Identify parallel opportunities |
| Vague test descriptions | Specific: Method_Scenario_Outcome |
| Assume your tests can fail | Let `check_test_adequacy` prove they can (revert source, re-run, expect red) |
| Add "nice to have" code | Only what the behavior requires |

## Rationalization Debunking

The ladder already prices in genuinely low-risk work — so these excuses apply to **medium/high-tier** tasks, where they are rationalizations rather than reasonable tier choices:

| Excuse | Reality |
|--------|---------|
| "This is too simple for a test" (on a medium/high-tier task) | If it touches a high-blast surface, its tier is not low. Test it at the tier the ladder assigns. |
| "I'll add tests after" | You won't. Or they'll be weak — and `check_test_adequacy` will catch tests that can't fail. |
| "Tests slow me down" | Debugging an untested medium/high-tier change is slower. |
| "The design is obvious" | Obvious to you now. Not in 3 months. |

## State Management

On plan save, transition phase based on `workflowType`: feature → `plan-review`, refactor → `overhaul-plan-review`.
```
action: "update", featureId: "<id>", phase: "<plan-review-phase>", updates: {
  "artifacts": { "plan": "<plan-file-path>" },
  "tasks": [{ "id": "001", "title": "...", "status": "pending", "branch": "...", "blockedBy": [] }, ...]
}
```

### Phase Transitions and Guards

For the full transition table, consult `@skills/workflow-state/references/phase-transitions.md`.

**Quick reference:** The `plan` → `plan-review` transition requires guard `plan-artifact-exists` — set `artifacts.plan` in the same `set` call as `phase`.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["update", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
(or `"debug"`, `"refactor"`) for phase transitions, guards, and playbook guidance.
Use `exarchos_orchestrate({ action: "describe", actions: ["check_plan_coverage", "check_provenance_chain"] })`
for orchestrate action schemas.

## Completion Criteria

- [ ] Design document read and understood
- [ ] Spec traceability table created (`exarchos_orchestrate({ action: "generate_traceability" })`)
- [ ] Scope declared (full or partial with rationale)
- [ ] Tasks decomposed to 2-5 min granularity
- [ ] Each task carries a `riskTier` (and `boundaryTouching`) stamp; medium/high-tier tasks carry adequacy-judged tests (test-after), high-tier adds the integration suite
- [ ] Dependencies mapped
- [ ] Parallel groups identified
- [ ] Plan verification passed — `exarchos_orchestrate({ action: "check_plan_coverage" })` returns passed: true
- [ ] Provenance chain checked — `exarchos_orchestrate({ action: "check_provenance_chain" })` passed (blocking; gaps must be resolved before proceeding)
- [ ] Task decomposition checked — `exarchos_orchestrate({ action: "check_task_decomposition" })` run (advisory; findings presented but non-blocking)
- [ ] Spec coverage check passed — `exarchos_orchestrate({ action: "spec_coverage_check" })` passed: true
- [ ] Coverage thresholds met — `exarchos_orchestrate({ action: "check_coverage_thresholds" })` passed: true:

```typescript
exarchos_orchestrate({
  action: "check_coverage_thresholds",
  coverageFile: "coverage/coverage-summary.json",
  lineThreshold: 80,
  branchThreshold: 70,
  functionThreshold: 100
})
```

- [ ] Plan saved to `docs/plans/`
- [ ] State file updated with plan path and tasks

## Transition

After planning completes, **auto-continue to plan-review** (delta analysis). Set `.phase` to the appropriate review phase (feature: `plan-review`, refactor: `overhaul-plan-review`). Plan-review compares design sections against planned tasks:
- Gaps found: set `.planReview.gaps`, auto-loop back to `plan --revise`
- No gaps: present to user for approval (human checkpoint)
- On approval: set `.planReview.approved = true`, invoke `delegate`

**REQUIRED:** Run `exarchos_orchestrate({ action: "check_plan_coverage" })`. If passed: false → auto-invoke `plan --revise`. If passed: true → continue to the plan-review phase (feature: `plan-review`, refactor: `overhaul-plan-review`) and only invoke `delegate` after plan-review approval.

## Exarchos Integration

Phase transitions auto-emit `workflow.transition` events via `exarchos_workflow` `set`. No manual `exarchos_event` append needed.

## Troubleshooting

| Issue | Cause | Resolution |
|-------|-------|------------|
| `check_plan_coverage` returns passed: false | Design sections not mapped to tasks | Add tasks for uncovered sections or add explicit deferral rationale |
| `spec_coverage_check` passed: false | Planned test files missing or failing | Create missing test stubs, verify file paths in plan match actual paths |
| `generate_traceability` passed: false | Design doc missing expected `##`/`###` headers | Verify design uses standard Markdown headings |
| Revision loop (3+ attempts) | Persistent gaps between design and plan | Set `planReview.revisionsExhausted = true`, suggest `ideate --redesign` |

## Performance Notes

- Complete each step fully before advancing — quality over speed
- Do not skip validation checks even when the change appears trivial
- Trace every design section to at least one task. Do not leave uncovered sections without explicit rationale.
