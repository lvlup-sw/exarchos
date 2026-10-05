// Detector fixtures.
//
// Synthetic test sources, held as strings. They prove that each detector in
// `detectors.ts` can fire and can stay silent. A sweep that reports zero
// violations has meaning only with proof from the same run. The proof is a 1
// on a positive fixture and a 0 on its matched negative.
//
// The fixtures live in a module that is not a `.test.ts` file. The corpus scan
// lists `*.test.ts` files only, and some fixtures hold the defects that the
// detectors look for. `checkCouldNotRunVerdicts` reads string bodies, so the
// same strings inside a test block of `suite-invariants.test.ts` make the
// meta-test flag itself.

/** An assertion that puts a fixture in scope by its shape. */
const IN_SCOPE_ASSERTION = `  it('SomeCensusClaim', () => {
    expect(missing).toEqual([]);
  });`;

/** POSITIVE for `oracle-sources-missing`: in scope, declares nothing. */
export const FIXTURE_NO_ANNOTATION = `import { it, expect } from 'vitest';
${IN_SCOPE_ASSERTION}
`;

/** NEGATIVE: the source matches no covered shape, so it owes no annotation. */
export const FIXTURE_OUT_OF_SCOPE = `import { it, expect } from 'vitest';
  it('AddsTwoNumbers', () => {
    expect(add(1, 2)).toBe(3);
  });
`;

/** POSITIVE for `oracle-sources-too-few`: one authority is not a comparison. */
export const FIXTURE_SINGLE_AUTHORITY = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts
${IN_SCOPE_ASSERTION}
`;

/** POSITIVE: two names for one authority, because the same module is written twice. */
export const FIXTURE_SAME_AUTHORITY_TWICE = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./corpus.js
${IN_SCOPE_ASSERTION}
`;

/**
 * POSITIVE for `oracle-sources-derived`. `registry.ts` imports
 * `legacy-shape-debt.ts`, so the second authority is reachable from the first.
 * Both are real modules in this directory, so the graph walk runs on a real
 * edge.
 */
export const FIXTURE_DERIVED_AUTHORITIES = `import { it, expect } from 'vitest';
// @oracle-sources: ./registry.ts, ./legacy-shape-debt.ts
${IN_SCOPE_ASSERTION}
`;

/**
 * NEGATIVE. `corpus.ts` reads the filesystem, and `registry.ts` holds
 * hand-written data. Neither reaches the other in the import graph.
 */
export const FIXTURE_INDEPENDENT_AUTHORITIES = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
${IN_SCOPE_ASSERTION}
`;

/** POSITIVE for `oracle-sources-unresolvable`. */
export const FIXTURE_UNRESOLVABLE_AUTHORITY = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./this-module-does-not-exist.ts
${IN_SCOPE_ASSERTION}
`;

/** NEGATIVE: two non-path labels are valid and count as distinct authorities. */
export const FIXTURE_OPAQUE_AUTHORITIES = `import { it, expect } from 'vitest';
// @oracle-sources: compiled-binary-stdio, live-TOOL_REGISTRY
${IN_SCOPE_ASSERTION}
`;

/** POSITIVE: two non-path labels that `KNOWN_DERIVATIONS` registers as a derivation pair. */
export const FIXTURE_KNOWN_DERIVED_LABELS = `import { it, expect } from 'vitest';
// @oracle-sources: TOOL_REGISTRY, contract-drift-baseline
${IN_SCOPE_ASSERTION}
`;

/** POSITIVE: the block raises the claim and declares no seam. */
export const FIXTURE_BLOCKING_WITHOUT_SEAM = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  /**
   * BLOCKING ARM: the guard refuses the transition.
   */
  it('Governance_UnsatisfiedGuard_RefusesTransition', async () => {
    expect(refusal.code).toBe('GUARD_FAILED');
    expect(missing).toEqual([]);
  });
`;

/** NEGATIVE: the `NEGATIVE TWIN` marker names the seam. */
export const FIXTURE_BLOCKING_WITH_TWIN = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  /**
   * BLOCKING ARM: the guard refuses the transition.
   * NEGATIVE TWIN: satisfy the guard and the SAME transition moves the phase,
   * so the non-mutation above is attributable to the denial.
   */
  it('Governance_UnsatisfiedGuard_RefusesTransition', async () => {
    expect(refusal.code).toBe('GUARD_FAILED');
    expect(missing).toEqual([]);
  });
`;

/** NEGATIVE: the `@kill-seam` annotation names the seam. */
export const FIXTURE_BLOCKING_WITH_KILL_SEAM = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  /**
   * BLOCKING ARM: the guard refuses the transition.
   * @kill-seam: admission guard evaluation in transition-command
   */
  it('Governance_UnsatisfiedGuard_RefusesTransition', async () => {
    expect(refusal.code).toBe('GUARD_FAILED');
    expect(missing).toEqual([]);
  });
`;

/**
 * POSITIVE: a bare `NEGATIVE TWIN` divider with no words after it. The divider
 * declares no seam. This case separates "declares the seam" from "contains the
 * phrase".
 */
export const FIXTURE_BLOCKING_WITH_EMPTY_TWIN = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  /** BLOCKING ARM: the guard refuses the transition. */
  it('Governance_UnsatisfiedGuard_RefusesTransition', async () => {
    // ── NEGATIVE TWIN ─────────────────────────────────────────────────
    expect(refusal.code).toBe('GUARD_FAILED');
    expect(missing).toEqual([]);
  });
`;

/** POSITIVE: the asserted expression is itself a verdict that did not run. */
export const FIXTURE_PASSED_TRUE_INLINE = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  it('Gate_WhenToolchainAbsent_IsReportedAsPassing', () => {
    expect(runGate({ discriminant: 'could-not-run' }).passed).toBe(true);
    expect(missing).toEqual([]);
  });
`;

/** POSITIVE: the block binds a verdict that did not run, then asserts a pass. */
export const FIXTURE_PASSED_TRUE_BY_BINDING = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  it('Gate_WhenToolchainAbsent_IsReportedAsPassing', () => {
    const verdict = { kind: 'couldNotRun', passed: true, report: 'no toolchain' };
    expect(verdict.passed).toBe(true);
    expect(missing).toEqual([]);
  });
`;

/**
 * NEGATIVE, and the most important one. Two corpus tests have this shape:
 * `tests/unit/verbs/gates/static-analysis.test.ts` and
 * `tests/unit/verbs/gates/test-adequacy.production-path.test.ts`. Each builds
 * a carrier of a verdict that did not run, to prove that the system does not
 * read it as a pass. R6 keys on the asserted claim, so it does not flag them.
 */
export const FIXTURE_COULD_NOT_RUN_NEGATIVE_FIXTURE = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  it('VerdictOf_LegacyVacuousCarrier_ReconstructsIndeterminateNotPass', () => {
    const verdict = verdictOf({ passed: true, discriminant: 'could-not-run' });
    expect(verdict.kind).toBe('indeterminate');
    expect(interpret(verdict, 'high').passed).toBe(false);
    expect(missing).toEqual([]);
  });
`;

/** POSITIVE: a cast of an object literal to `DispatchContext`. */
export const FIXTURE_SYNTHESIZED_CONTEXT = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  const ctx = {
    stateDir,
    eventStore,
    enableTelemetry: false,
  } as unknown as DispatchContext;
${IN_SCOPE_ASSERTION}
`;

/** POSITIVE: a `vi.mock` of the wiring that the tier proves. */
export const FIXTURE_MOCKED_COMPOSITE = `import { it, expect, vi } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
vi.mock('../../src/dispatch/core/dispatch.js', () => ({ dispatch: vi.fn() }));
${IN_SCOPE_ASSERTION}
`;

/** NEGATIVE: the approved route through the production composition root. */
export const FIXTURE_HARNESS_DRIVEN = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
import { createPublicRootHarness } from '../_harness.js';
const harness = await createPublicRootHarness();
${IN_SCOPE_ASSERTION}
`;
