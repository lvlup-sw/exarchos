---
paths: "**/*.ts", "**/*.tsx", "**/*.cs"
---

# TDD Rules

Enforce strict TDD when modifying TypeScript or C# files.

## TDD Workflow

### RED Phase
1. Write a test that describes expected behavior
2. Run tests — test MUST fail
3. Verify it fails for the RIGHT reason (not a compilation error)

### GREEN Phase
1. Write the minimum code to make the test pass
2. Run tests — test MUST pass
3. No extra features or optimizations

### REFACTOR Phase
1. Clean up code while tests stay green
2. Extract helpers, improve naming, apply SOLID
3. Run tests after each change

## Conventions

| | TypeScript | C# |
|--|-----------|-----|
| Framework | Vitest | TUnit |
| Test files | `foo.test.ts` (co-located) | `Foo.Tests.cs` (co-located) |
| Naming | `Method_Scenario_Outcome` | `Method_Scenario_Outcome` |
| Run | `npm run test:run` | `dotnet test` |
| Pattern | Arrange / Act / Assert | Arrange / Act / Assert |
| Mocking | `vi.mock()`, `vi.fn()` | NSubstitute (`Substitute.For<T>()`) |
| PBT | `@fast-check/vitest` | FsCheck |

For test code patterns and examples, see `@skills/delegation/references/testing-patterns.md`.
For property-based testing templates, see `@skills/delegation/references/pbt-patterns.md`.

Property tests are written alongside example tests in the RED phase. They complement, not replace, example tests.

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
