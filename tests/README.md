# `tests/` — the single test tree

Every test lives here. None lives beside its subject, and
`tests/architecture/test-tree-contract.test.ts` fails the build if one does.

Pick a tier by what the test IS, then let the tier decide its runtime policy —
timeout, parallelism, environment. The tiers are `acceptance`, `architecture`,
`benchmarks`, `core`, `e2e`, `evals`, `helpers`, `integration`, `migration`,
`outcome`, `process`, `scripts`, `smoke`, `support`, `unit`.

## The rule that matters most

**A tier must be collected by exactly one vitest project.** The tier-to-project
mapping is declared in `test-tree-contract.test.ts`, which fails if a tier is
collected by NO project or by two. That check exists because a whole directory
of tests once matched no project at all: the suite passed, in the way that a
suite passes when it never runs.

## Conventions

- Vitest: `import { describe, it, expect, vi } from 'vitest'`. Shell suites are
  `*.test.sh`.
- Mirror the subject's path within the tier, so a moved module and its test
  move together.
- Name a test for the claim it makes, not the function it calls —
  `Registry_AfterDecomposition_WireProjectionIsByteIdentical` says what breaks
  if it fails.

## Verifying

`npx vitest run` runs every root project. `npm run test:run` is the `unit`
project ONLY — narrower than it sounds, and it omits the outcome lane that
exercises the built binary. Prefer the former before claiming green.

## Guards, and how they die

Most checks in `architecture/` compare the tree against a recorded baseline.
The failure mode to watch for is not a red test, it is a quiet one: a path-
pinned guard whose target moved matches nothing and passes forever. So assert
the denominator — the count of things scanned — alongside the verdict, and seed
a violation to confirm the guard names it.
