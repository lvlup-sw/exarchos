# Verification Ladder

Verification depth matches a task's **blast radius**. Pick the cheapest rung that still captures the risk — the deeper rungs add tests that can fail and integration coverage, all judged by **outcome (test-after)**, not by a failing-test-first ordering ceremony on every change.

## The Ladder

| Risk tier | What it adds on top of the rung below | Why this depth |
|-----------|----------------------------------------|----------------|
| **low** | Static analysis only (typecheck + lint) | Docs/config/rename-only edits have near-zero blast radius. A test ceremony is pure overhead here. |
| **medium** | Scoped tests that can fail | A test that can actually fail is test-first's one real guarantee. It is judged test-after, at review, instead of mandating a failing test first on every commit. |
| **high** | The integration suite on top of medium | Schema/type/API/shared-contract surfaces span the codebase. Cover them with adequacy-judged tests plus real-collaborator integration coverage across the seam. |

`boundaryTouching` is an orthogonal flag: a boundary-crossing task (I/O adapter, client, schema artifact) adds contract-drift verification, and at medium/high also mock-boundary verification, regardless of its tier.

The task's `riskTier` / `boundaryTouching` stamp comes from the planner (or the classifier's blast-radius heuristic). Both the dispatched implementer prompt and the gate sequence scale off that stamp — the verification effort is data-driven, not hand-applied per task.

## High-Tier Discipline: Outcome-Based Adequacy (test-after)

When a task is high-tier (or you have chosen to write a test for a medium-tier behavior), the discipline is **outcome-based**, not ordering-based. Write the behavior and its tests in whatever order is natural — test-after is fine — then let the review judge whether the tests are adequate. The cost-effective guarantee is that your tests *can actually fail*, not that a failing test came first.

### Cover the behavior
1. Write scoped tests that exercise the new/changed behavior and pin its contract
2. Use `Method_Scenario_Outcome` naming; one behavior per test
3. Property tests (where they fit) are written alongside the example tests

### Prove the tests are not vacuous
1. Run your tests on the task source. They must pass there
2. Ask what each test does when the changed source is stubbed out. At least one test must go red
3. A test that still passes against a stubbed-out source is vacuous — strengthen it

### Integration coverage (high tier)
1. Real-collaborator coverage across the seam belongs in the task's own scoped tests — write them at the layer the seam lives at
2. Refactor freely while those tests stay green
3. The `check_integration_suite` gate is **not** yours to run: `settle` runs the pinned suite for a high-tier task, and it is also a wave-boundary backstop owned by the lead that runs once, after the wave's merges land

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

`spec_coverage_check` runs the declared test files with the probe command.
That command, and the `test:files` script that selects it, are in
`@skills/delegate/references/testing-patterns.md`, which every runtime ships.

For test code patterns and examples, see `@skills/delegate/references/testing-patterns.md`.
For property-based testing templates, see `@skills/delegate/references/pbt-patterns.md`.

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
