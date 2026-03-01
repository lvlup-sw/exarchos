# Design: Adversarial Convergence Gates

**Date:** 2026-02-28
**Status:** Draft
**ADR:** `docs/adrs/adversarial-convergence-theory.md`

## Problem

The Exarchos pipeline runs a full adversarial audit only at the review → synthesize boundary (the feature-audit). Problems discovered there are expensive to fix because the code is already written. Earlier phases have structural guards (artifact exists, deps met) but no semantic quality checks. This creates two failure modes:

1. **Late discovery** — Spec gaps, pattern violations, and traceability holes found only after all implementation is complete
2. **Post-hoc traceability** — The requirement → implementation → test matrix is reconstructed by the auditor at review time, not maintained as a living artifact

## Solution

Implement **graduated adversarial checks** at each pipeline phase gate and a **provenance chain** maintained through event metadata. This is the practical implementation of the three CMDP extensions defined in the adversarial convergence theory ADR ($C_{adv}$, $D_{conv}$, $L'$).

## Design

### 1. Graduated Gate Checks

Each phase gate gets a lightweight adversarial check implemented as a validation script. The scripts evaluate a subset of the feature-audit's convergence dimensions, producing structured findings with severity levels.

#### Gate: ideate → plan

**Trigger:** After design document is saved, before auto-chaining to `/plan`.

**Dimensions:** D1 (spec fidelity) — lightweight.

**Check:** Design completeness validation.
- Design has numbered requirements (DR-N pattern or equivalent structured identifiers)
- Each requirement has acceptance criteria (not just a description)
- Design covers error/edge cases, not just happy path

**Implementation:** `scripts/check-design-completeness.sh`
- Input: design document path
- Output: exit 0 (pass) or exit 1 (findings to stderr)
- Findings are advisory at this gate (MEDIUM severity) — they don't block, but they're recorded as events

**Rationale for advisory-only:** The ideate → plan transition is auto-chained (no human checkpoint). Blocking here would break the flow for minor issues. Findings are emitted as events so the plan phase can address them.

#### Gate: plan → plan-review

**Trigger:** After implementation plan is generated, before presenting to user.

**Dimensions:** D1 (spec fidelity) + D5 (determinism).

**Checks:**
1. **Plan-design delta** — Every design requirement has at least one implementing task. Every task traces to at least one requirement. Flag orphan tasks (scope creep) and uncovered requirements (gaps).
2. **Task quality** — Each task has: clear description, file targets, test expectations, TDD compliance notes. Flag under-specified tasks.
3. **Dependency coherence** — `blockedBy` relationships form a DAG (no cycles). Parallel tasks don't modify the same files.

**Implementation:** `scripts/check-plan-coverage.sh`
- Input: design document path, plan document path
- Output: exit 0 (pass), exit 1 (findings), exit 2 (blocked)
- Exit 2 if >30% of requirements have no implementing task

**This gate feeds into the human checkpoint** — findings are presented to the user alongside the plan for their review.

#### Gate: per-task completion (within delegate)

**Trigger:** After each subagent completes a task, before marking it done.

**Dimensions:** D1 (spec) + D2 (patterns).

**Checks:**
1. **TDD compliance** — `scripts/check-tdd-compliance.sh` scoped to the task's branch
2. **Test suite green** — `npm run test:run` in the task's worktree
3. **Type safety** — `npm run typecheck` in the task's worktree

**Implementation:** Already exists as individual scripts. The change is: run them as a **gate check** on task completion, not just at final audit.

**Failure handling:** Task stays in-progress. Findings emitted as events. Orchestrator can retry the task or escalate.

#### Gate: review → synthesize (existing feature-audit)

**Dimensions:** D1-D5 (all) — deepest adversarial pass.

**Implementation:** Existing `docs/prompts/feature-audit.md` — no changes to the audit itself. The change is framing: this is the **convergence gate**, not a post-hoc audit. The workflow cannot advance to synthesize unless all five dimensions converge.

#### Gate: synthesize → cleanup

**Trigger:** After PR merge, before cleanup.

**Dimensions:** D4 (resilience) — lightweight.

**Checks:**
1. **CI green on merge** — Verify CI passed on the merge commit
2. **No regressions** — Run the test suite against the merged branch

**Implementation:** `scripts/check-post-merge.sh`
- Input: PR URL, merge commit SHA
- Output: exit 0 (pass) or exit 1 (regression detected)

### 2. Provenance Chain

Requirements trace through the pipeline as structured metadata, maintained incrementally (not reconstructed at audit time).

#### 2.1 Requirement Identifiers in Design Documents

Design documents produced by `/ideate` use structured requirement identifiers:

```markdown
### DR-1: Password reset via email

Users can reset their password by receiving a time-limited token via email.

**Acceptance criteria:**
- Valid token resets password and invalidates token
- Expired token returns 401
- Invalid token returns 404
```

The identifiers (DR-1, DR-2, ...) are the provenance anchors.

#### 2.2 Task-to-Requirement Mapping in Plans

Implementation plans produced by `/plan` map tasks to requirements:

```markdown
### Task T-3: Implement password reset endpoint

**Implements:** DR-1
**Files:** src/auth/reset.ts, src/auth/reset.test.ts
**TDD:** Write tests for valid token, expired token, invalid token cases first
```

The `Implements:` field is the provenance link.

#### 2.3 Provenance in Event Metadata

When tasks complete during `/delegate`, the completion event carries provenance:

```typescript
{
  type: "task.completed",
  correlationId: "<featureId>",
  payload: {
    taskId: "T-3",
    implements: ["DR-1"],
    tests: [
      { name: "ResetPassword_ValidToken_ResetsPassword", file: "src/auth/reset.test.ts" },
      { name: "ResetPassword_ExpiredToken_Returns401", file: "src/auth/reset.test.ts" }
    ],
    files: ["src/auth/reset.ts"]
  }
}
```

#### 2.4 Provenance View (CQRS Projection)

A new CQRS materialized view aggregates provenance from task completion events:

```typescript
interface ProvenanceView {
  featureId: string;
  requirements: {
    id: string;
    tasks: string[];          // Task IDs implementing this requirement
    tests: string[];          // Test names covering this requirement
    files: string[];          // Files changed for this requirement
    status: "covered" | "partial" | "uncovered";
  }[];
  coverage: number;           // Fraction of requirements with status "covered"
  orphanTasks: string[];      // Tasks not mapped to any requirement
}
```

**Status derivation:**
- `covered`: has implementing task(s), test(s), and code
- `partial`: has task but missing test or code
- `uncovered`: no implementing task

#### 2.5 Deterministic Traceability Check

At the review → synthesize convergence gate, the provenance view enables a **deterministic** check replacing the qualitative "build a traceability matrix" eval:

```bash
# Check provenance coverage
exarchos_view --action provenance --featureId <id>
# Returns: { coverage: 1.0, uncovered: [], orphanTasks: [] }
# Pass if coverage == 1.0 and orphanTasks is empty
```

### 3. Convergence Framing

The feature-audit's verdict classification is reframed as a **convergence check**:

| Verdict | Convergence Meaning | Workflow Effect |
|---------|-------------------|----------------|
| APPROVED | All 5 dimensions converged | Advance to synthesize |
| NEEDS_FIXES | ≥1 dimension not converged, fixable | Remediation loop (stay in review) |
| BLOCKED | Fundamental dimension failure | Return to design phase |

The verdict is conjunctive: all dimensions must independently pass. A high score in one dimension cannot compensate for failure in another.

### 4. Event Schema Additions

New event types for adversarial gate checks:

```typescript
// Emitted at each gate check
interface GateCheckEvent {
  type: "gate.check";
  correlationId: string;       // featureId
  payload: {
    gate: string;              // "ideate-to-plan" | "plan-to-review" | "task-completion" | "review-to-synthesize" | "post-merge"
    dimensions: string[];      // Which convergence dimensions were evaluated
    verdict: "pass" | "fail" | "blocked" | "advisory";
    findings: {
      dimension: number;       // 1-5
      severity: "HIGH" | "MEDIUM" | "LOW";
      criterion: string;
      evidence: string;
    }[];
  };
}

// Emitted by subagents when tasks complete
interface TaskProvenanceEvent {
  type: "task.provenance";
  correlationId: string;
  payload: {
    taskId: string;
    implements: string[];       // Requirement IDs
    tests: { name: string; file: string }[];
    files: string[];
  };
}
```

### 5. Skill Changes

#### `/ideate` (brainstorming skill)

Add to the design presentation phase:
- Design documents must include numbered requirements with acceptance criteria
- After saving design, run `check-design-completeness.sh` and emit findings as advisory events

#### `/plan` (implementation-planning skill)

Add to the plan generation phase:
- Each task must include an `Implements:` field mapping to design requirement IDs
- After generating plan, run `check-plan-coverage.sh` and present findings alongside the plan at the human checkpoint

#### `/delegate` (delegation skill)

Add to per-task completion:
- Subagent prompts must instruct agents to report provenance (which requirements they implemented, which tests they wrote)
- On task completion, emit `task.provenance` event
- Run TDD compliance and test suite as gate check before marking task complete

#### `/review` (spec-review + quality-review skills)

Add to the review workflow:
- Query provenance view for deterministic traceability check
- Use provenance coverage as a D1 deterministic eval (replacing qualitative matrix construction)
- Convergence framing: present verdict as "dimensions converged / not converged"

### 6. Implementation Order

1. **Provenance view** — New CQRS projection in the MCP server (enables all downstream changes)
2. **Event schema** — Add `gate.check` and `task.provenance` event types
3. **Design completeness script** — `scripts/check-design-completeness.sh` (ideate gate)
4. **Plan coverage script** — `scripts/check-plan-coverage.sh` (plan gate)
5. **Feature-audit convergence framing** — Update `docs/prompts/feature-audit.md` (done in this session)
6. **Skill updates** — Update `/ideate`, `/plan`, `/delegate`, `/review` skills to emit provenance and run gate checks
7. **Post-merge check** — `scripts/check-post-merge.sh` (synthesize gate)

### 7. Non-Goals

- **Formal verification** (proofs, model checking) — VSDD's verification layer is aspirational for our domain. Property-based testing (already in our TDD rules) serves as a pragmatic substitute.
- **Automated requirement extraction** — Requirement IDs are assigned by the human/AI during `/ideate`, not extracted from prose automatically. This is a future enhancement.
- **Cross-feature provenance** — Traceability is per-feature. Cross-feature dependency tracking is out of scope.

### 8. Success Criteria

- **Measurable:** Feature audits that previously required qualitative traceability matrix construction can use the provenance view for a deterministic coverage check
- **Measurable:** Problems caught at earlier gates (plan coverage gaps, TDD violations) reduce the finding count at the review → synthesize convergence gate
- **Measurable:** Gate check scripts execute in <5s each, consuming <500 tokens of context budget per check
