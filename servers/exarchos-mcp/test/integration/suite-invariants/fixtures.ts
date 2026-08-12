// ─── Detector fixtures ──────────────────────────────────────────────────────
//
// Synthetic test SOURCES, held as strings, used to prove every detector in
// `detectors.ts` is capable of both firing and not firing. This is the
// anti-vacuity mechanism for the corpus sweep: "0 violations across 920 files"
// only means something if the detector that produced the 0 has been shown, in
// the same run, to produce a 1 on a positive and a 0 on a matched negative.
//
// These live in a NON-`.test.ts` module on purpose. The corpus scanner
// enumerates `*.test.ts` only, and several fixtures below deliberately contain
// the exact defects the detectors look for. If they lived inside
// `suite-invariants.test.ts`, the meta-test would flag ITSELF — the string
// bodies are visible to the could-not-run detector, which must read string
// literals because verdicts are usually strings.
//
// Every fixture pairs a POSITIVE (must fire) with a NEGATIVE (must not).

/** Every fixture carries this so it is in scope by assertion shape. */
const IN_SCOPE_ASSERTION = `  it('SomeCensusClaim', () => {
    expect(missing).toEqual([]);
  });`;

// ─── R1–R4: the @oracle-sources family ──────────────────────────────────────

/** POSITIVE for `oracle-sources-missing`: in scope, declares nothing. */
export const FIXTURE_NO_ANNOTATION = `import { it, expect } from 'vitest';
${IN_SCOPE_ASSERTION}
`;

/** NEGATIVE: asserts nothing DR-30 cares about, so no annotation is owed. */
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

/** POSITIVE: two names, one authority — the same module written twice. */
export const FIXTURE_SAME_AUTHORITY_TWICE = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./corpus.js
${IN_SCOPE_ASSERTION}
`;

/**
 * POSITIVE for `oracle-sources-derived`. `registry.ts` statically imports
 * `legacy-shape-debt.ts`, so the second authority is reachable from the first
 * in the real import graph — one authority wearing two names. This uses REAL
 * modules in this directory, so the graph walk is exercised against a real
 * edge rather than a mocked one.
 */
export const FIXTURE_DERIVED_AUTHORITIES = `import { it, expect } from 'vitest';
// @oracle-sources: ./registry.ts, ./legacy-shape-debt.ts
${IN_SCOPE_ASSERTION}
`;

/**
 * NEGATIVE. `corpus.ts` (reads the filesystem) and `registry.ts` (hand-written
 * data, import-free apart from the generated list) do not reach each other in
 * either direction. Two genuine authorities.
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

/** NEGATIVE: opaque (non-path) labels are allowed and counted as distinct. */
export const FIXTURE_OPAQUE_AUTHORITIES = `import { it, expect } from 'vitest';
// @oracle-sources: compiled-binary-stdio, live-TOOL_REGISTRY
${IN_SCOPE_ASSERTION}
`;

/** POSITIVE: two opaque labels registered as a derivation pair. */
export const FIXTURE_KNOWN_DERIVED_LABELS = `import { it, expect } from 'vitest';
// @oracle-sources: TOOL_REGISTRY, contract-drift-baseline
${IN_SCOPE_ASSERTION}
`;

// ─── R5: a blocking claim must declare the seam its kill fixture kills ──────

/** POSITIVE: raises the claim, declares no seam. */
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

/** NEGATIVE: the established NEGATIVE TWIN convention names the seam. */
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

/** NEGATIVE: the explicit annotation form. */
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
 * POSITIVE: a bare rule with no words after it. A decorative
 * `── NEGATIVE TWIN ──` divider is not a declaration of anything, and this is
 * the case that separates "declares the seam" from "contains the phrase".
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

// ─── R6: no `passed === true` on a could-not-run verdict ────────────────────

/** POSITIVE: the asserted expression is itself a could-not-run verdict. */
export const FIXTURE_PASSED_TRUE_INLINE = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  it('Gate_WhenToolchainAbsent_IsReportedAsPassing', () => {
    expect(runGate({ discriminant: 'could-not-run' }).passed).toBe(true);
    expect(missing).toEqual([]);
  });
`;

/** POSITIVE: bound to a could-not-run verdict, then asserted as a pass. */
export const FIXTURE_PASSED_TRUE_BY_BINDING = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  it('Gate_WhenToolchainAbsent_IsReportedAsPassing', () => {
    const verdict = { kind: 'couldNotRun', passed: true, report: 'no toolchain' };
    expect(verdict.passed).toBe(true);
    expect(missing).toEqual([]);
  });
`;

/**
 * NEGATIVE — and the most important one. This is the shape of the two REAL
 * corpus tests (`orchestrate/static-analysis.test.ts` and
 * `orchestrate/test-adequacy.production-path.test.ts`) that deliberately BUILD
 * a could-not-run carrier in order to prove the system refuses to read it as a
 * pass. An earlier draft of R6 keyed on "an object literal carrying both
 * markers" and flagged exactly those two, i.e. it punished the tests that
 * already enforce the property. The rule keys on the ASSERTED CLAIM instead,
 * and this fixture pins that.
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

// ─── R7: the integration tier may not synthesize its own root ───────────────

/** POSITIVE: the exact shortcut T-36 predicted and DR-27 forbids. */
export const FIXTURE_SYNTHESIZED_CONTEXT = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
  const ctx = {
    stateDir,
    eventStore,
    enableTelemetry: false,
  } as unknown as DispatchContext;
${IN_SCOPE_ASSERTION}
`;

/** POSITIVE: mocking away the wiring the tier exists to prove. */
export const FIXTURE_MOCKED_COMPOSITE = `import { it, expect, vi } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
vi.mock('../../src/dispatch/core/dispatch.js', () => ({ dispatch: vi.fn() }));
${IN_SCOPE_ASSERTION}
`;

/** NEGATIVE: the sanctioned route through the production composition root. */
export const FIXTURE_HARNESS_DRIVEN = `import { it, expect } from 'vitest';
// @oracle-sources: ./corpus.ts, ./registry.ts
import { createPublicRootHarness } from '../_harness.js';
const harness = await createPublicRootHarness();
${IN_SCOPE_ASSERTION}
`;
