# Design: Outside-In TDD Refinement

## Problem Statement

Exarchos enforces strict TDD (red-green-refactor) at the task level, but each task's test cycle is self-contained — there is no feature-level acceptance test wrapping the inner cycles. This creates a gap: all unit tests can pass while the feature as a whole doesn't satisfy the user's intent. In an agentic world where AI generates implementation, tests become the most valuable artifact — they define AND validate behavior. We need to strengthen our testing methodology to make tests the primary specification mechanism, not just a verification afterthought.

Research across testing methodologies (Outside-In TDD, ATDD, Specification by Example, Testing Trophy, Test Desiderata) converges on a common insight: **start from the outside (user-facing behavior), work inward, and favor behavioral tests over structure-coupled tests**. This aligns with our existing neuroanatomy-informed patterns — cognitive function isolation (Pattern 3), multi-pass refinement (Pattern 2), and effort control (Pattern 8) all apply to how we structure test creation.

## Chosen Approach

**Specification-Executable Testing** — extend the existing provenance chain so design requirements (DR-N) carry structured acceptance criteria that become executable acceptance tests. These tests serve as the "north star" for inner TDD cycles. Combined with Testing Trophy distribution guidance, characterization testing for refactoring safety, and neuroanatomy-aligned effort control for test tasks.

**Why this approach:** It builds on infrastructure we already have (DR-N identifiers, provenance chain, task classification, TDD compliance checking) rather than requiring a paradigm shift. The acceptance test falls out naturally from structured acceptance criteria — no new task graph topology needed.

## Requirements

### DR-1: Structured acceptance criteria in design documents

Design requirements (DR-N) gain a mandatory structured acceptance criteria format using Given/When/Then syntax. Each criterion becomes an executable specification anchor.

The `/ideate` phase produces acceptance criteria like:

**Example (illustrative, not a real requirement):**

> **DR-X: Password reset with expired token**
>
> **Acceptance criteria:**
> - Given a user with a valid account
>   When they submit a password reset with an expired token
>   Then the system returns a 401 status
>   And the response body contains "Token expired"
>   And no password change is persisted
>
> - Given a user with a valid account
>   When they submit a password reset with a valid token
>   Then the password is updated
>   And the old password no longer authenticates

The `check_design_completeness` handler validates that every DR-N has at least one Given/When/Then criterion.

**Acceptance criteria:**
- Design template includes Given/When/Then format guidance with examples
- `check_design_completeness` rejects designs where any DR-N lacks structured acceptance criteria
- Existing DR-N acceptance criteria (bullet-point format) remain valid as a fallback — Given/When/Then is preferred but not the only valid format
- Design documents produced by `/ideate` use Given/When/Then for behavioral requirements and bullet points for non-behavioral requirements (performance, constraints)

### DR-2: Acceptance test as first task per feature

The implementation planner emits an acceptance test task as the first task (or first task per DR-N cluster). This task writes a failing end-to-end or integration test derived from the DR-N acceptance criteria. Inner TDD tasks then implement toward it.

The acceptance test task:
- Translates Given/When/Then criteria into executable test code
- Uses real collaborators where possible (sociable tests), mocks only at infrastructure boundaries
- Is classified as high-effort reasoning (Pattern 1 / Pattern 8) because it requires understanding user intent
- Remains failing (red) until inner tasks complete — it is the "north star"

Inner tasks declare a dependency on the acceptance test task (they need the test file to exist, not to pass).

**Acceptance criteria:**
- Task template gains `testLayer` field with values: `acceptance`, `integration`, `unit`, `property`
- Task template gains `acceptanceTestRef` field linking inner tasks to their acceptance test task
- Planner emits at least one task with `testLayer: "acceptance"` per feature
- Acceptance test tasks have no dependencies (they are first in the graph)
- Inner tasks with `acceptanceTestRef` declare a dependency on the referenced acceptance test task
- The `check_plan_coverage` handler validates that every DR-N with Given/When/Then criteria maps to at least one acceptance test task

### DR-3: Test layer selection as a planning decision

The planner explicitly selects the test layer for each task based on the scope of what's being tested. This replaces implicit layer inference.

Test layer taxonomy (from highest to lowest scope):

| Layer | Scope | When to use | Speed |
|---|---|---|---|
| `acceptance` | Feature-level behavior from user perspective | First task per feature/DR-N cluster | Slow |
| `integration` | Multiple components working together | Default for most tasks | Medium |
| `unit` | Single function/class in isolation | Complex algorithmic logic, pure functions | Fast |
| `property` | Invariants across input space | Transformations, state machines, serialization | Medium |

The planner follows Testing Trophy distribution: **integration-heavy, unit-light**. Unit tests are reserved for naturally isolated complex logic (parsers, algorithms, mathematical operations). Integration tests are the default.

**Acceptance criteria:**
- `testLayer` is a required field in the task template (no implicit default)
- Testing strategy guide updated with layer selection decision tree
- Planner auto-determines `testLayer` based on task scope (like existing `propertyTests` auto-determination)
- Task classification in `prepare_delegation` incorporates `testLayer` into effort recommendation: `acceptance` → high effort, `integration` → medium effort, `unit`/`property` → standard effort

### DR-4: Provenance chain extension with specification nodes

The provenance chain extends from `DR-N → Task → Test → Code` to `DR-N → Spec Criteria → Acceptance Test → Inner Tests → Code`. The acceptance test is the bridge between design requirements and implementation tests.

```
DR-3 (design requirement)
  ├── Given/When/Then criteria (in design doc)
  │     ├── AcceptanceTest_PasswordReset_ExpiredToken_Returns401 (acceptance test)
  │     │     ├── resetPassword_ExpiredToken_ReturnsError (integration test, inner task)
  │     │     │     └── src/auth/reset.ts (implementation)
  │     │     └── tokenValidator_Expired_ReturnsFalse (unit test, inner task)
  │     │           └── src/auth/token.ts (implementation)
  │     └── AcceptanceTest_PasswordReset_ValidToken_UpdatesPassword (acceptance test)
  │           └── ...
```

The `task.completed` event's provenance payload gains an `acceptanceTestRef` field linking inner task tests to their parent acceptance test.

**Acceptance criteria:**
- `TaskCompletedData` schema includes optional `acceptanceTestRef: string` field
- ProvenanceView traces from DR-N through acceptance test to inner tests
- `verify-provenance-chain` script validates the extended chain: every DR-N with Given/When/Then → acceptance test task → inner test tasks
- `check_provenance_chain` orchestrate handler reports coverage at both acceptance and inner test levels

### DR-5: Neuroanatomy-aligned effort for test tasks

Test task types map to cognitive function tiers from the applied neuroanatomy patterns (Pattern 1, Pattern 6, Pattern 8):

| Test Task Type | Cognitive Function | Effort | Model Tier | Rationale |
|---|---|---|---|---|
| Write acceptance test | Reasoning (understand user intent, design test architecture) | High | Opus | Requires understanding feature intent holistically |
| Write integration test | Reasoning + Decoding (understand component interactions, produce test code) | Medium-High | Sonnet | Requires understanding interfaces between components |
| Write unit test | Decoding (translate known behavior into test) | Medium | Sonnet | Scope is narrow, behavior is well-defined by acceptance test |
| Write property test | Reasoning (identify invariants from domain) | High | Sonnet/Opus | Identifying properties requires abstract domain reasoning |

The `classifyTask` function in `prepare-delegation.ts` incorporates `testLayer` as a classification signal alongside existing keyword and dependency heuristics.

**Acceptance criteria:**
- `classifyTask` returns `effort: "high"` for tasks with `testLayer: "acceptance"`
- `classifyTask` returns `effort: "medium"` or `"high"` for tasks with `testLayer: "integration"` (based on dependency count)
- Task classification reason includes test layer when it influences the classification
- Decision runbook for review strategy incorporates test layer into review depth (acceptance tests get thorough review, unit tests get standard review)

### DR-6: Testing Trophy distribution guidance

Update the testing strategy guide and implementer prompt to favor integration tests over unit tests, aligned with the Testing Trophy model (Kent C. Dodds) and Spotify Honeycomb.

Guidance principles:
1. **Static analysis is the base** — TypeScript strict mode + ESLint catch type errors before any test runs (already enforced)
2. **Integration tests are the default** — test components with real collaborators, mock only at infrastructure boundaries (HTTP, database, filesystem)
3. **Unit tests are for isolated complexity** — parsers, algorithms, mathematical operations, pure functions with complex edge cases
4. **Acceptance tests are the outer boundary** — one per feature, behavioral, structure-insensitive

Sociable test preference: tests should use real collaborators by default (sociable tests, per Martin Fowler). Mock only when collaboration is "awkward" — external services, non-deterministic resources, expensive infrastructure. This reduces mock-related brittleness and produces tests that survive agent refactoring.

**Acceptance criteria:**
- Testing strategy guide includes test distribution guidance (integration default, unit for isolated complexity)
- Testing strategy guide includes sociable test preference with mock decision criteria
- Implementer prompt references Testing Trophy distribution
- TDD rules reference updated with sociable vs solitary test guidance
- Quality review evaluates test structure-insensitivity: tests that break on refactoring without behavioral change are flagged

### DR-7: Characterization testing for refactoring and debugging

Before modifying existing code, agents capture current behavior as characterization tests. This is a mandatory pre-step in the refactor and debug workflows — not the feature workflow.

The characterization test workflow:
1. **Before modification**: Write tests that document what the code currently does (not what it should do)
2. **During modification**: Any characterization test failure means behavior changed — agent must evaluate if the change was intentional
3. **After modification**: Characterization tests become regression tests

This aligns with Pattern 2 (multi-pass refinement) — the first pass captures behavior, the second pass modifies it with the safety net in place.

**Acceptance criteria:**
- Refactor skill (`/refactor`) includes characterization test step before implementation phase
- Debug skill (`/debug`) includes characterization test step for thorough track (not hotfix track)
- Implementer prompt gains a "Characterization Testing" section activated when the task involves modifying existing behavior
- Characterization tests use snapshot/approval style: capture output, assert it matches on subsequent runs
- Task template gains `characterizationRequired: boolean` field, auto-determined by planner when task modifies existing functions

### DR-8: Test Desiderata quality criteria

Incorporate Kent Beck's Test Desiderata into the quality review rubric. Four properties are critical for agent-generated tests:

1. **Behavioral** — Tests are sensitive to changes in behavior, not structure. Tests that assert on implementation details (mock call counts, internal state) are flagged.
2. **Structure-insensitive** — Tests don't break when implementation is refactored without changing behavior. Tests coupled to method signatures of internal helpers are flagged.
3. **Deterministic** — Tests produce the same result every run. Flaky tests are catastrophic for agents — they can't distinguish "my code is wrong" from "the test is flaky."
4. **Specific** — When a test fails, the cause is obvious. Vague assertions (`expect(result).toBeTruthy()`) or catch-all tests are flagged.

These four properties form a quality rubric evaluated during stage 2 (quality review).

**Acceptance criteria:**
- Quality review skill includes Test Desiderata checklist (behavioral, structure-insensitive, deterministic, specific)
- Quality review flags tests that assert on implementation details (mock call order, internal state)
- Quality review flags tests with non-deterministic dependencies (Date.now(), Math.random()) without proper control
- Quality review flags tests with vague assertions (toBeTruthy, toBeDefined without additional specific assertions)
- Test Desiderata criteria added to quality review reference documentation

### DR-9: Error handling, edge cases, and failure modes

The outside-in approach introduces new failure modes that must be handled:

**Acceptance test that can never pass:** If the acceptance test is mis-specified (tests behavior that isn't achievable with the planned architecture), inner tasks will complete but the acceptance test remains red forever. Detection: if all inner tasks complete but the acceptance test still fails, flag for human review — the acceptance criteria or the architecture may need revision.

**Test layer mismatch:** Planner selects `unit` layer for a task that actually requires integration (e.g., the behavior depends on database interaction). Detection: if a unit test requires extensive mocking to work, the task classification was wrong. Advisory finding during quality review.

**Characterization test false positives in refactoring:** Characterization tests capture current behavior including bugs. If a refactoring intentionally changes buggy behavior, characterization tests will fail. The agent must distinguish intentional behavioral changes from accidental regressions. Resolution: agent documents which characterization test failures are expected and why.

**Acceptance test performance:** Acceptance tests are slower than unit tests. Running them on every inner task's TDD cycle would slow the feedback loop. Resolution: inner tasks run only their own unit/integration tests during TDD cycles. The acceptance test runs at task completion and at the feature review stage.

**Acceptance criteria:**
- When all inner tasks for an acceptance test are complete but the acceptance test still fails, the delegation skill flags this as a blocker requiring human review
- Quality review flags unit tests with >3 mocked dependencies as potential layer mismatches
- Refactoring workflow requires agents to document expected characterization test failures before committing
- Acceptance tests are excluded from inner task TDD cycles — they run at task completion and feature review

## Technical Design

### Task Template Changes

```typescript
// Extended testingStrategy schema
testingStrategy: {
  exampleTests: true;              // Always required
  propertyTests: boolean;          // Property-based tests required?
  benchmarks: boolean;             // Performance benchmarks required?
  testLayer: 'acceptance' | 'integration' | 'unit' | 'property';  // NEW
  acceptanceTestRef?: string;      // NEW — links to acceptance test task ID
  characterizationRequired?: boolean;  // NEW — pre-step for existing code modification
  properties?: string[];
  performanceSLAs?: PerformanceSLA[];
}
```

### Task Classification Extension

```typescript
// In prepare-delegation.ts classifyTask()
// Add testLayer as a classification signal:

if (task.testLayer === 'acceptance') {
  return {
    taskId: task.id,
    complexity: 'high',
    recommendedAgent: 'implementer',
    effort: 'high',
    reason: 'Acceptance test task — requires understanding feature intent holistically',
  };
}
```

### Acceptance Test Task Structure

```markdown
### Task 1: Write acceptance test for password reset

**Phase:** RED (this task is ONLY the red phase — the test stays failing)

**Test Layer:** acceptance
**Implements:** DR-3

**TDD Steps:**
1. [RED] Write acceptance test from DR-3 Given/When/Then criteria
   - File: `src/auth/reset.acceptance.test.ts`
   - Translate each Given/When/Then criterion into a test case
   - Use real collaborators; mock only external HTTP boundaries
   - Expected failure: function/module under test does not exist yet
   - Run: `npm run test:run` — MUST FAIL

**This task produces a failing test only. Implementation happens in subsequent tasks.**

**Dependencies:** None (first task)
**Parallelizable:** No (other tasks depend on this)
```

### Inner Task Structure (linked to acceptance test)

```markdown
### Task 3: Implement token validation

**Phase:** RED | GREEN | REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** Task 1

**TDD Steps:**
1. [RED] Write integration test: `tokenValidator_Expired_ReturnsError`
   - File: `src/auth/token.test.ts`
   - Expected failure: tokenValidator function does not exist
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Implement minimum code
   - File: `src/auth/token.ts`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Clean up

**On completion:** Run acceptance test from Task 1 to check progress.

**Dependencies:** Task 1
**Parallelizable:** Yes (with Task 2, after Task 1 completes)
```

### Design Template Changes

Add to the acceptance criteria format guidance:

```markdown
**Acceptance criteria:**
- Given [precondition]
  When [action]
  Then [expected outcome]
  And [additional outcome]
```

### Provenance Extension

The `TaskCompletedData` schema adds:

```typescript
interface TaskCompletedData {
  // Existing fields
  implements: string[];
  tests: Array<{ name: string; file: string }>;
  files: string[];
  // New field
  acceptanceTestRef?: string;  // Task ID of parent acceptance test
}
```

## Integration Points

| Existing Component | Change | Scope |
|---|---|---|
| `skills/brainstorming/references/design-template.md` | Add Given/When/Then format guidance | Content only |
| `skills/implementation-planning/references/task-template.md` | Add `testLayer`, `acceptanceTestRef`, `characterizationRequired` fields | Schema + guidance |
| `skills/implementation-planning/references/testing-strategy-guide.md` | Add test layer selection decision tree, Testing Trophy distribution | Content only |
| `skills/delegation/references/implementer-prompt.md` | Add sociable test guidance, characterization testing section, acceptance test completion check | Content only |
| `skills/shared/references/tdd.md` | Add sociable vs solitary guidance, Test Desiderata reference | Content only |
| `skills/quality-review/SKILL.md` | Add Test Desiderata evaluation checklist | Content only |
| `skills/spec-review/SKILL.md` | Add acceptance test coverage check | Content only |
| `skills/refactor/SKILL.md` | Add characterization testing pre-step | Content only |
| `skills/debug/SKILL.md` | Add characterization testing for thorough track | Content only |
| `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts` | Extend `classifyTask` with `testLayer` signal | Code change |
| `servers/exarchos-mcp/src/orchestrate/pure/tdd-compliance.ts` | Extend to validate acceptance test existence | Code change |
| `servers/exarchos-mcp/src/orchestrate/check-design-completeness.ts` | Validate Given/When/Then criteria presence | Code change |
| `servers/exarchos-mcp/src/orchestrate/check-plan-coverage.ts` | Validate acceptance test task per DR-N | Code change |
| Event schema: `task.completed` | Add `acceptanceTestRef` to `TaskCompletedData` | Schema change |

## Testing Strategy

This is a content-heavy feature — most changes are to Markdown skill references and guidance documents. Code changes are limited to:

1. **`classifyTask` extension** — Unit tests: verify `testLayer: "acceptance"` → `effort: "high"`, verify `testLayer: "integration"` with high deps → `effort: "high"`
2. **`check_design_completeness` extension** — Unit tests: verify Given/When/Then detection, verify fallback bullet-point format still passes
3. **`check_plan_coverage` extension** — Unit tests: verify acceptance test task validation per DR-N
4. **`TaskCompletedData` schema extension** — Schema validation tests for `acceptanceTestRef` field
5. **TDD compliance extension** — Unit tests: verify acceptance test existence check

The Markdown content changes are validated by the existing `check_design_completeness` and `check_plan_coverage` handlers consuming them.

## Open Questions

1. **Acceptance test naming convention:** Should acceptance tests use a distinct naming pattern (e.g., `*.acceptance.test.ts`) or co-locate with the module they test? Distinct naming makes them easy to filter for selective test runs.

2. **Multi-DR acceptance tests:** When multiple DR-N requirements share a natural acceptance boundary (e.g., DR-3 and DR-4 both involve password reset), should the planner emit one acceptance test covering both, or one per DR-N? One per DR-N is simpler and more traceable; one per boundary is more realistic.

3. **Characterization test retention:** After refactoring completes, should characterization tests be kept as permanent regression tests, or removed? Keeping them adds test maintenance burden; removing them loses the safety net.

4. **Stack-specific acceptance test patterns:** The Given/When/Then format translates differently across stacks (Vitest for TS, TUnit for C#, pytest for Python). Should we provide stack-specific acceptance test templates, or keep guidance generic?
