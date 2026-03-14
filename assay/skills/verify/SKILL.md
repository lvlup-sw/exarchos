---
name: verify
description: "Validate test quality by finding test-production divergence, mock overuse, and schema drift. Use when evaluating test suite health or after discovering a bug that tests missed. Triggers: 'check tests', 'test quality', 'verify contracts', or /assay:verify. Do NOT use for architecture review — use assay:critique instead."
user-invokable: true
metadata:
  author: lvlup-sw
  version: 0.1.0
  category: assessment
  dimensions:
    - test-fidelity
    - contracts
---

# Verify — Test Validation

## Overview

Test validation skill covering DIM-4 (Test Fidelity) and DIM-3 (Contracts) from the backend quality dimension taxonomy. Verify finds the gap between what your tests claim to prove and what they actually exercise — the space where bugs hide behind passing suites.

This skill focuses on two complementary concerns:

- **Test Fidelity (DIM-4):** Do tests exercise actual production behavior, or do they test a parallel universe of mocks and test-only wiring?
- **Contracts (DIM-3):** Do schemas, types, and API boundaries stay in sync between declaration and usage?

## Triggers

Activate this skill when:
- Evaluating test suite health after a milestone
- A bug was found that existing tests should have caught
- Reviewing test quality during code review
- Investigating why tests pass but production breaks
- Checking schema/contract integrity after API changes

Do NOT activate when:
- Reviewing architecture, coupling, or SOLID compliance — use `assay:critique`
- Investigating error handling or observability — use `assay:harden`
- Looking for dead code or vestigial patterns — use `assay:distill`

## Process

### Step 1: Load Dimension Definitions

Load the relevant dimension definitions from `@skills/backend-quality/references/dimensions.md` — specifically the DIM-4 (Test Fidelity) and DIM-3 (Contracts) sections. These define the invariants, detectable signals, and severity guides for each dimension.

### Step 2: Run Deterministic Checks

Run `assay:scan` targeting the Test Fidelity and Contracts dimensions. This surfaces mechanical findings — grep-detectable patterns like:
- `describe.skip` / `it.skip` without issue references
- More than 3 `vi.mock()` or `jest.mock()` calls in a single test file
- `as Type` assertions without preceding type guards
- Schema fields referenced in code but absent from Zod/JSON schema definitions

### Step 3: Layer Qualitative Assessment

On top of deterministic findings, apply human-judgment assessment for patterns that require understanding intent:

- **Test-production divergence:** Compare test setup and factory functions against production initialization code. Are tests creating instances the same way production does? Different instances of shared resources, different initialization order, different configuration, and different wiring are all divergence signals.

- **Mock fidelity:** Are mocks placed at true infrastructure boundaries only (HTTP, database, filesystem)? More than 3 mocks in a single test is a smell — it usually means the test is operating at the wrong layer. Check whether mocks verify behavior (what happened) or implementation (how it happened).

- **Missing integration tests:** Identify cross-cutting concerns tested only with unit tests. Shared state, event propagation, multi-module workflows, and initialization sequences need integration-level coverage.

- **Schema/contract drift:** Look for types removed but still read at runtime, breaking API changes without versioning, and Zod schemas that have diverged from their TypeScript type counterparts. See `@skills/verify/references/contract-testing.md` for detailed detection approaches.

- **Test coverage gap analysis:** Are tests exercising only the happy path? Look for missing error paths, boundary cases, empty inputs, and concurrent scenarios.

For detailed patterns and taxonomy, see `@skills/verify/references/test-antipatterns.md`.

### Step 4: Output Findings

Format all findings per `@skills/backend-quality/references/findings-format.md`. Each finding must include:
- Dimension (DIM-3 or DIM-4)
- Severity (HIGH, MEDIUM, LOW)
- Evidence (file:line references)
- Explanation and optional suggestion

## The "Passing Tests, Broken System" Problem

High test counts and high coverage percentages can create false confidence when tests do not exercise production paths. A suite of thousands of tests proves nothing if every test creates its own isolated world that diverges from how the system actually runs.

**Canonical example — the EventStore divergence bug:** 4192 tests passed while the system silently lost events. The root cause: tests created and consumed events through the same EventStore instance, but production wired two separate instances that were never connected. Every test exercised a path that did not exist in production. The tests were not wrong in isolation — they were wrong in aggregate, testing a topology that production never used.

This is the most dangerous class of test failure: the test suite becomes a confidence generator rather than a defect detector. Verify exists to find these gaps before they become production incidents.

**Warning signs:**
- Test setup differs from production startup sequence
- All tests use in-memory implementations of dependencies that production resolves differently
- No test exercises the actual wiring/initialization path
- Tests mock the very thing they should be testing

## Error Handling

- **Empty scope:** If no files match the provided scope (or no scope is provided), output an informative message: "No files in scope for verify analysis. Provide a file path, directory, or glob pattern." Do not produce empty findings.
- **No test files found:** If the scope contains source code but no test files, report this as a DIM-4 finding (severity depends on context).
- **Parse failures:** If a file cannot be parsed for schema analysis, log and skip with a note in the output.

## References

- Dimension definitions: `@skills/backend-quality/references/dimensions.md`
- Finding output format: `@skills/backend-quality/references/findings-format.md`
- Test antipattern catalog: `@skills/verify/references/test-antipatterns.md`
- Contract testing guide: `@skills/verify/references/contract-testing.md`
