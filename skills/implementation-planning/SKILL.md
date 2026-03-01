---
name: implementation-planning
description: "Transform design documents into TDD-based implementation plans with granular, parallelizable tasks. Use when the user says 'plan implementation', 'create tasks from design', 'break down the design', or runs /plan. Enforces the Iron Law: no production code without a failing test first. Do NOT use for brainstorming, debugging, or code review. Requires an existing design document as input. Do NOT use if no design document exists — use /ideate first."
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
- User runs `/plan` command
- User wants to break down a design into tasks
- A design document exists and needs implementation steps
- User says "plan the implementation" or similar
- Auto-chained from `/exarchos:ideate` after design completion
- Auto-chained from plan-review with `--revise` flag (gaps found)

## Revision Mode (--revise flag)

When invoked with `--revise`, plan-review found gaps. Read `.planReview.gaps` from state, re-read the design, add tasks to address each gap, update the plan file, then clear gaps via `mcp__plugin_exarchos_exarchos__exarchos_workflow` `action: "set"`.

### Revision Loop Guard

Max revisions: 3 per plan.

After 3 failed revisions:
1. Set `planReview.revisionsExhausted = true`
2. Output: "Plan revision failed after 3 attempts. Design may be incomplete."
3. Escalate: Suggest `/exarchos:ideate --redesign` to revisit design

> **MANDATORY:** Before accepting any rationalization for skipping tests, planning, or TDD steps, consult `references/rationalization-refutation.md`. Every common excuse is catalogued with a counter-argument and the correct action.

## The Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

Every implementation task MUST:
1. Start with writing a failing test
2. Specify the expected failure reason
3. Only then implement minimum code to pass

**Verify TDD compliance** in git history after implementation:

```bash
scripts/check-tdd-compliance.sh \
  --repo-root . \
  --branch feature/<name> \
  --base-branch main
```

- **exit 0** — All commits have test files before or alongside implementation
- **exit 1** — Violations found; commits have implementation without corresponding tests
- **exit 2** — Usage error; check arguments

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

```bash
scripts/generate-traceability.sh \
  --design-file docs/designs/<feature>.md \
  --plan-file docs/plans/<date>-<feature>.md \
  --output docs/plans/<date>-<feature>-traceability.md
```

- **exit 0** — Matrix generated; review and fill in "Key Requirements" column
- **exit 1** — Parse error; design document may lack expected `##`/`###` headers
- **exit 2** — Usage error; check arguments

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

**5b. Spec coverage check** — verify planned test files exist and pass:

```bash
scripts/spec-coverage-check.sh \
  --plan-file docs/plans/<date>-<feature>.md \
  --repo-root . \
  --threshold 80
```

- **exit 0** — All planned tests found and passing; plan verification complete
- **exit 1** — Missing test files or test failures; create missing tests or fix failures
- **exit 2** — Usage error; check arguments

For reference, consult `references/spec-tracing-guide.md` for the underlying methodology.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Write implementation first | Write failing test first |
| Create large tasks | Break into 2-5 min chunks |
| Skip dependency analysis | Identify parallel opportunities |
| Vague test descriptions | Specific: Method_Scenario_Outcome |
| Assume tests pass | Verify each test fails first |
| Add "nice to have" code | Only what the test requires |

## Rationalization Debunking

| Excuse | Reality |
|--------|---------|
| "This is too simple for tests" | Simple code breaks too. Test it. |
| "I'll add tests after" | You won't. Or they'll be weak. |
| "Tests slow me down" | Debugging without tests is slower. |
| "The design is obvious" | Obvious to you now. Not in 3 months. |

## State Management

On plan save:
```
action: "set", featureId: "<id>", phase: "plan-review", updates: {
  "artifacts": { "plan": "<plan-file-path>" },
  "tasks": [{ "id": "001", "title": "...", "status": "pending", "branch": "...", "blockedBy": [] }, ...]
}
```

## Completion Criteria

- [ ] Design document read and understood
- [ ] Spec traceability table created (`scripts/generate-traceability.sh`)
- [ ] Scope declared (full or partial with rationale)
- [ ] Tasks decomposed to 2-5 min granularity
- [ ] Each task starts with failing test
- [ ] Dependencies mapped
- [ ] Parallel groups identified
- [ ] Plan verification passed — `exarchos_orchestrate({ action: "check_plan_coverage" })` returns passed: true
- [ ] Provenance chain checked — `exarchos_orchestrate({ action: "check_provenance_chain" })` passed (blocking; gaps must be resolved before proceeding)
- [ ] Spec coverage check passed — `scripts/spec-coverage-check.sh` exit 0
- [ ] Coverage thresholds met — `scripts/check-coverage-thresholds.sh` exit 0:

```bash
scripts/check-coverage-thresholds.sh \
  --coverage-file coverage/coverage-summary.json \
  --line-threshold 80 \
  --branch-threshold 70 \
  --function-threshold 100
```

- [ ] Plan saved to `docs/plans/`
- [ ] State file updated with plan path and tasks

## Transition

After planning completes, **auto-continue to plan-review** (delta analysis):

1. Set `.phase = "plan-review"` and populate tasks in state
2. Run plan-review: compare design sections against planned tasks
   - Gaps found: set `.planReview.gaps`, auto-loop back to `/exarchos:plan --revise`
   - No gaps: present to user for approval (human checkpoint)
   - On approval: set `.planReview.approved = true`, invoke `/exarchos:delegate`

**REQUIRED:** Run `exarchos_orchestrate({ action: "check_plan_coverage", featureId: "<id>", designPath: "<design>", planPath: "<plan>" })`. If passed: false: auto-invoke `Skill({ skill: "exarchos:plan", args: "--revise <design>" })`. If passed: true: proceed to delegation.

## Exarchos Integration

On plan completion, auto-emitted by `exarchos_workflow` `set` when phase transitions — emits `workflow.transition` from plan to plan-review. No manual `exarchos_event` append needed.

## Troubleshooting

| Issue | Cause | Resolution |
|-------|-------|------------|
| `check_plan_coverage` returns passed: false | Design sections not mapped to tasks | Add tasks for uncovered sections or add explicit deferral rationale |
| `spec-coverage-check.sh` exit 1 | Planned test files missing or failing | Create missing test stubs, verify file paths in plan match actual paths |
| `generate-traceability.sh` exit 1 | Design doc missing expected `##`/`###` headers | Verify design uses standard Markdown headings |
| Revision loop (3+ attempts) | Persistent gaps between design and plan | Set `planReview.revisionsExhausted = true`, suggest `/ideate --redesign` |

## Performance Notes

- Complete each step fully before advancing — quality over speed
- Do not skip validation checks even when the change appears trivial
- Trace every design section to at least one task. Do not leave uncovered sections without explicit rationale.
