# TDD Task Template

## Task Format

Each task follows this structure:

```markdown
### Task [N]: [Brief Description]

**Phase:** [RED | GREEN | REFACTOR]
**Test Layer:** [acceptance | integration | unit | property]
**Risk Tier:** [low | medium | high — optional; omit to let `classifyTask` derive it]
**Boundary Touching:** [true | false — optional; omit to let `classifyTask` derive it]
**Acceptance Test Ref:** [Task ID of parent acceptance test, or omit]
**Implements:** [DR-N identifiers]

**TDD Steps:**
1. [RED] Write test: `TestName_Scenario_ExpectedOutcome`
   - File: `path/to/test.ts`
   - Expected failure: [Specific failure reason]
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `path/to/implementation.ts`
   - Changes: [Brief description]
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up (optional)
   - Apply: [SOLID principle or improvement]
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** [Task IDs this depends on, or "None"]
**Parallelizable:** [Yes/No]
```

## Risk Tier and Boundary Tag

Each task carries two orthogonal verification-routing signals, derived **mechanically** by
`classifyTask` (`prepare-delegation.ts`) — no LLM in the hot path. An explicit value in the plan
**always wins** over derivation (override-first, mirroring the toolchain resolver's layering).

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

## Test Naming Convention

Follow: `MethodName_Scenario_ExpectedOutcome`

**Examples:**
- `CreateUser_ValidInput_ReturnsUserId`
- `CreateUser_EmptyEmail_ThrowsValidationError`
- `GetUser_NonExistentId_ReturnsNull`
