---
name: implementation-planning
description: "Transform design documents into TDD-based implementation plans with granular, parallelizable tasks. Use when the user says 'plan implementation', 'create tasks from design', 'break down the design', or runs /plan. Enforces the Iron Law: no production code without a failing test first. Do NOT use for design exploration -- use brainstorming instead."
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

## Triggers

Activate this skill when:
- User runs `/plan` command
- User wants to break down a design into tasks
- A design document exists and needs implementation steps
- User says "plan the implementation" or similar
- Auto-chained from `/ideate` after design completion
- Auto-chained from plan-review with `--revise` flag (gaps found)

## Revision Mode (--revise flag)

When invoked with `--revise`, plan-review found gaps. Read `.planReview.gaps` from state, re-read the design, add tasks to address each gap, update the plan file, then clear gaps via `mcp__exarchos__exarchos_workflow` `action: "set"`.

## The Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

Every implementation task MUST:
1. Start with writing a failing test
2. Specify the expected failure reason
3. Only then implement minimum code to pass

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

### Step 2: Decompose into Tasks

Each task follows the TDD format in `references/task-template.md`.

**Granularity Guidelines:**
- Each task: 2-5 minutes of focused work
- One test = one behavior
- Prefer many small tasks over few large ones

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

Follow the coverage checklist and delta analysis in `references/spec-tracing-guide.md`.

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

On plan save, update state via `mcp__exarchos__exarchos_workflow` `action: "set"`:
- `artifacts.plan` -- plan file path
- `tasks` -- array of objects: `id`, `title`, `status` ("pending"), `branch`
- `phase` -- "plan-review"

## Completion Criteria

- [ ] Design document read and understood
- [ ] Spec traceability table created
- [ ] Scope declared (full or partial with rationale)
- [ ] Tasks decomposed to 2-5 min granularity
- [ ] Each task starts with failing test
- [ ] Dependencies mapped
- [ ] Parallel groups identified
- [ ] Plan verification passed (Step 5)
- [ ] Plan saved to `docs/plans/`
- [ ] State file updated with plan path and tasks

## Transition

After planning completes, **auto-continue to plan-review** (delta analysis):

1. Set `.phase = "plan-review"` and populate tasks in state
2. Run plan-review: compare design sections against planned tasks
   - Gaps found: set `.planReview.gaps`, auto-loop back to `/plan --revise`
   - No gaps: present to user for approval (human checkpoint)
   - On approval: set `.planReview.approved = true`, invoke `/delegate`

## Exarchos Integration

On plan completion, call `mcp__exarchos__exarchos_event` with `action: "append"` and event type `phase.transitioned` from plan to plan-review.
