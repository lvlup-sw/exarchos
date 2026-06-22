# Verification Ladder

Verification depth matches a task's **blast radius**. Pick the cheapest rung that still captures the risk — the deeper rungs add tests, an adequacy kill-probe, and integration coverage, all judged by **outcome (test-after)**, not by a failing-test-first ordering ceremony on every change (#1587).

## The Ladder

| Risk tier | What it adds on top of the rung below | Why this depth |
|-----------|----------------------------------------|----------------|
| **low** | Static analysis only (typecheck + lint) | Docs/config/rename-only edits have near-zero blast radius. A test ceremony is pure overhead here. |
| **medium** | Scoped tests + the `check_test_adequacy` kill-probe | The kill-probe recaptures test-first's one real guarantee — that a test can actually fail — at lower cost, judged test-after instead of mandating a failing test first on every commit. |
| **high** | The integration suite (and mutation-adequacy at the boundary) on top of medium | Schema/type/API/shared-contract surfaces span the codebase. Cover them with adequacy-judged tests plus real-collaborator integration coverage across the seam. |

`boundaryTouching` is an orthogonal flag: a boundary-crossing task (I/O adapter, client, schema artifact) adds contract-drift verification, and at medium/high also mock-boundary verification, regardless of its tier.

The task's `riskTier` / `boundaryTouching` stamp comes from the planner (or the classifier's blast-radius heuristic). Both the dispatched implementer prompt and the gate sequence scale off that stamp — the verification effort is data-driven, not hand-applied per task.

## High-Tier Discipline: Outcome-Based Adequacy (test-after)

When a task is high-tier (or you have chosen to write a test for a medium-tier behavior), the discipline is **outcome-based**, not ordering-based. Write the behavior and its tests in whatever order is natural — test-after is fine — then let the gates judge whether the tests are adequate. The cost-effective guarantee is that your tests *can actually fail*, captured by the `check_test_adequacy` kill-probe rather than by mandating a failing test first (#1587).

### Cover the behavior
1. Write scoped tests that exercise the new/changed behavior and pin its contract
2. Use `Method_Scenario_Outcome` naming; one behavior per test
3. Property tests (where they fit) are written alongside the example tests

### Prove the tests are not vacuous
1. The `check_test_adequacy` gate reverts your source hunks (keeping the tests) and re-runs them, asserting at least one goes red
2. A test that still passes against the reverted source is vacuous — strengthen it

### Integration coverage (high tier)
1. The `check_integration_suite` rung exercises real collaborators across the seam
2. Refactor freely while the suite stays green

## Conventions

| | TypeScript | C# |
|--|-----------|-----|
| Framework | Vitest | TUnit |
| Test files | `foo.test.ts` (co-located) | `Foo.Tests.cs` (co-located) |
| Naming | `Method_Scenario_Outcome` | `Method_Scenario_Outcome` |
| Run | see `.exarchos.yml` for project-specific commands | see `.exarchos.yml` for project-specific commands |
| Pattern | Arrange / Act / Assert | Arrange / Act / Assert |
| Mocking | `vi.mock()`, `vi.fn()` | NSubstitute (`Substitute.For<T>()`) |
| PBT | `@fast-check/vitest` | FsCheck |

### Test commands

Exarchos resolves test/typecheck/install commands from your project's `.exarchos.yml`
(seeded from filesystem detection at workflow init). To override the auto-detected
defaults, edit the file:

```yaml
# .exarchos.yml
test: bun test
typecheck: tsc --noEmit
install: bun install
```

When no `.exarchos.yml` is present and detection cannot resolve a command (e.g.,
an npm project missing a `test:run` script), the relevant gate is skipped with
remediation text rather than failed.

For test code patterns and examples, see `@skills/delegation/references/testing-patterns.md`.
For property-based testing templates, see `@skills/delegation/references/pbt-patterns.md`.

Property tests are written alongside the example tests. They complement, not replace, example tests.

## Sociable vs Solitary Tests

Default to **sociable tests** — tests that use real collaborator objects rather than mocks. This aligns with the Testing Trophy model where integration tests give the best confidence-per-effort ratio.

**When to use real collaborators (default):**
- Logic dependencies (pure computation, no side effects)
- Value objects (immutable data carriers)
- In-process collaborators that are fast and deterministic

**When to mock (solitary tests):**
- External services (HTTP APIs, third-party integrations)
- Non-deterministic resources (system clock, random number generators)
- Slow dependencies (databases, network calls, filesystem)
- When simulating specific error conditions

**Guideline:** If a test requires >3 mocked dependencies, consider whether the test is at the wrong layer. A unit test with heavy mocking may be better written as an integration test with real collaborators.
