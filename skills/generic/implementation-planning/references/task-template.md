# Task Template

## Task Format

Each task follows this structure. The verification fields lead: `riskTier` selects how deeply the task is verified (see the ladder in `@skills/_shared/references/verification.md`). Tests are judged by **outcome, test-after** — the failing-test-first ordering ceremony is not required (#1587).

```markdown
### Task [N]: [Brief Description]

**Risk Tier:** [low | medium | high]   ← REQUIRED — drives the verification depth
**Boundary Touching:** [true | false — optional; omit to let `classifyTask` derive it]
**Test Layer:** [acceptance | integration | unit | property]
**Acceptance Test Ref:** [Task ID of parent acceptance test, or omit]
**Implements:** [DR-N identifiers]

**Files:**
- `path/to/implementation.ts`
- `path/to/implementation.test.ts` (medium/high tiers)

**Verification (scales with Risk Tier):**
- **low** — static analysis (typecheck + lint). No tests required; add a focused test only if behavior is non-obvious.
- **medium** — scoped tests covering the new/changed behavior + the `check_test_adequacy` kill-probe. Test-after is fine.
- **high** — the medium set + the integration suite across the seam. Granular per-behavior red-green is available as an explicit opt-in, never a requirement.

**Steps:**
1. Implement the behavior for this task.
2. Add the tests its tier requires (above), named `Method_Scenario_Outcome`, and confirm they exercise the behavior — the `check_test_adequacy` kill-probe will reject vacuous tests.
3. Refactor while the tests stay green.

**Dependencies:** [Task IDs this depends on, or "None"]
**Parallelizable:** [Yes/No]
```

## Risk Tier and Boundary Tag

Each task carries two orthogonal verification-routing signals. The planner **always stamps `riskTier`
explicitly** (it is a required task field); `boundaryTouching` may be omitted. `classifyTask`
(`prepare-delegation.ts`) derives both **mechanically** as a runtime fallback — no LLM in the hot
path — and an explicit value in the plan **always wins** over derivation (override-first, mirroring
the toolchain resolver's layering).

| Signal | Derivation (when omitted) |
|---|---|
| `riskTier: high` | any file matches schema/type/API/contract globs, `testLayer: acceptance`, `blockedBy ≥ 2`, or `files ≥ 3` |
| `riskTier: low` | ALL files match doc/config/rename globs |
| `riskTier: medium` | default (single-module behavior); ambiguity resolves upward to medium |
| `boundaryTouching: true` | `testLayer ∈ {integration, acceptance}`, IO-adapter/client globs hit, or a schema artifact (proto/OpenAPI/GraphQL) in scope |

The tier→gate **sequence** is resolved by `workflow/verification-policy.ts` (the policy SoT) and
stamped on the delegation record — do not encode gate sequences in plan prose. A low-blast task
can still be boundary-tagged: the axes are independent.

### Tier → default `testingStrategy`

The tier also selects the default verification **mix** (the `testingStrategy` fields), table-driven so
the planner emits them per tier with no implementer guesswork. Medium/high default to the **cheap mix**:
strict/branded types + inline invariants/assertions + one PBT on the pure core + one acceptance
north-star test, with granular per-behavior red-green as an explicit opt-in. Low stays minimal.

| `riskTier` | `propertyTests` | `testLayer` | `characterizationRequired` |
|---|---|---|---|
| `high` | `true` (one PBT on the pure core) | `acceptance` (one north-star test) | `true` when modifying existing code, else `false` |
| `medium` | `true` (one PBT on the pure core) | `integration` | `true` when modifying existing code, else `false` |
| `low` | `false` | `unit` | `false` |

A category match in `testing-strategy-guide.md` (data transformations, serialization, …) raises a field
**upward** from this floor; it never relaxes it. The cheap-mix relaxation is guarded by R5's
mutation-adequacy gate (`/review` boundary) and R3's git-only `check_test_adequacy` kill-probe — see
[testing-strategy-guide.md](./testing-strategy-guide.md) for the full rationale.

## Test Layer Selection

Each task must declare its test layer. This determines the scope and style of testing:

| Layer | Scope | When to use |
|---|---|---|
| `acceptance` | Feature-level behavior from user perspective | First task per feature or DR-N cluster. Uses real collaborators, no mocks. Remains RED until inner tasks complete. |
| `integration` | Multiple components working together | **Default for most tasks.** Uses real collaborators, mocks only at infrastructure boundaries. |
| `unit` | Single function/class in isolation | Complex algorithmic logic, pure functions, parsers. |
| `property` | Invariants across input space | Transformations, state machines, serialization (auto-determined via testingStrategy). |

**Acceptance Test Ref:** Inner tasks that implement toward an acceptance test should declare `**Acceptance Test Ref:** [Task ID]` linking to the parent acceptance test task. This creates the provenance chain: `DR-N → Acceptance Test → Inner Tests → Code`.

## Characterization Testing

When a task modifies existing code behavior, the planner should set `characterizationRequired: true` in the testingStrategy. The implementer captures current behavior as characterization tests before making changes, providing a safety net against unintended regressions.

## Model-Based Conformance Provenance (SIV-6)

When a task drives an **external stateful integration** and the plan calls for a model-based conformance test (see *Model-Based Conformance at Stateful Boundaries* in the testing-strategy guide), the task MUST carry a provenance checklist the reviewer can verify — the LLM-authored model is otherwise prone to mirroring the code instead of the spec:

```text
**Model-Based Conformance (SIV-6):**
- Acceptance criterion cited: [AC-id]   ← required; no citation ⇒ reject the model
- Model is strictly simpler than the implementation (not a line-by-line mirror)
- Model authored before/with the code (not reverse-engineered)
- Known-bad-trace rejection test included (model rejects a seeded-wrong transition)
```

A model that cites no acceptance criterion, or whose known-bad-trace test does not actually reject the seeded transition, is vacuous — the gate fails it.

## Test Naming Convention

Follow: `MethodName_Scenario_ExpectedOutcome`

**Examples:**
- `CreateUser_ValidInput_ReturnsUserId`
- `CreateUser_EmptyEmail_ThrowsValidationError`
- `GetUser_NonExistentId_ReturnsNull`
