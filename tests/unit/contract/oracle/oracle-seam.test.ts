import { describe, it, expect } from 'vitest';
import {
  ORACLE_AXES,
  checkGenerationConsistency,
  checkIncorrectHandler,
  checkMalformedOutput,
  checkMissingAuthorization,
  checkUndeclaredEffect,
  deriveGeneratedDescriptor,
  failureFor,
  observeBehavior,
  runOracle,
  runOracleSuite,
  serializeGeneratedDescriptor,
  summarizeReport,
  type OracleAxis,
} from '../../../../src/contract/oracle/oracle-seam.js';
import {
  correctBaselineSubject,
  liveOutputSubjects,
  liveSuccessOutputSubjects,
  seedActionId,
  seededBreak,
} from '../../../../src/contract/oracle/fixtures.js';

// The oracle compares the DECLARED contract against OBSERVED behavior, by a
// route independent of the generation pipeline. These tests are the API-010
// exit proof: (a) the live system passes; (b)–(f) each seeded break is caught
// with a diagnostic naming the action + axis; (g) each seeded break is invisible
// to generation-consistency — which is what proves the independence.

describe('P03-09 oracle — (a) the live system passes the oracle', () => {
  it('EveryRealActionOutputContractAdmitsTheRuntimeErrorEnvelope', async () => {
    const subjects = liveOutputSubjects();
    // Sanity: the whole live surface is under observation, not a token slice.
    expect(subjects.length).toBeGreaterThanOrEqual(100);

    const suite = await runOracleSuite(subjects);
    // A single-glance diagnostic if the live system ever regresses.
    expect(suite.failures.map((f) => `${f.actionId}/${f.axis}: ${f.diagnostic}`)).toEqual([]);
    expect(suite.ok).toBe(true);
  });

  it('EveryDataAgnosticActionAdmitsTheRuntimeSuccessEnvelope', async () => {
    const { subjects, skipped } = liveSuccessOutputSubjects();
    // Most actions carry an `EnvelopeSchema(z.unknown())`; only a handful pin a
    // typed `data` shape that rejects empty data (those are output-observed via
    // the error branch above). Assert the split is as expected, not silent.
    expect(subjects.length).toBeGreaterThanOrEqual(100);
    expect(skipped.length).toBeLessThan(subjects.length);

    const suite = await runOracleSuite(subjects, { axes: ['malformed-output'] });
    expect(suite.failures).toEqual([]);
    expect(suite.ok).toBe(true);
  });

  it('TheCorrectBaselineSubjectPassesAllFiveAxes', async () => {
    const report = await runOracle(correctBaselineSubject());
    expect(report.ok).toBe(true);
    // Every axis is actively observed (none merely skipped) and passes.
    const byAxis = new Map(report.verdicts.map((v) => [v.axis, v]));
    for (const axis of ORACLE_AXES) {
      expect(byAxis.get(axis)?.status, `${axis}: ${summarizeReport(report)}`).toBe('pass');
    }
  });
});

describe('P03-09 oracle — (b)–(f) each seeded break is caught', () => {
  it.each(ORACLE_AXES)(
    'catches the seeded %s break with a diagnostic naming the action and the axis',
    async (axis: OracleAxis) => {
      const { correct, broken } = seededBreak(axis);

      // The correct counterpart — same declaration, faithful behavior — passes.
      const correctReport = await runOracle(correct);
      expect(correctReport.ok, summarizeReport(correctReport)).toBe(true);

      // The broken handler is caught.
      const report = await runOracle(broken);
      expect(report.ok, summarizeReport(report)).toBe(false);

      // The failure is on EXACTLY this axis (per-axis isolation), and it names
      // the offending action and axis.
      const failedAxes = report.verdicts.filter((v) => v.status === 'fail').map((v) => v.axis);
      expect(failedAxes).toEqual([axis]);

      const failure = failureFor(report, axis);
      expect(failure).toBeDefined();
      expect(failure?.actionId).toBe(seedActionId(axis));
      expect(failure?.axis).toBe(axis);
      expect(failure?.diagnostic.length).toBeGreaterThan(0);

      // The human-readable summary carries both identifiers.
      const summary = summarizeReport(report);
      expect(summary).toContain(seedActionId(axis));
      expect(summary).toContain(axis);
    },
  );
});

describe('P03-09 oracle — (g) each seeded break is INVISIBLE to generation-consistency', () => {
  it.each(ORACLE_AXES)(
    'the %s break leaves the generated artifact byte-identical, yet the oracle distinguishes it',
    async (axis: OracleAxis) => {
      const { correct, broken } = seededBreak(axis);

      // 1. The generation route sees ONLY the declaration. Broken and correct
      //    share a byte-identical declaration, so the generated descriptor is
      //    byte-identical — "the generated files all agree".
      const correctGen = serializeGeneratedDescriptor(
        deriveGeneratedDescriptor(correct.declaration),
      );
      const brokenGen = serializeGeneratedDescriptor(
        deriveGeneratedDescriptor(broken.declaration),
      );
      expect(brokenGen).toBe(correctGen);

      // 2. A generation/drift guard is green for BOTH (identical digest). No
      //    function of the generated artifacts can tell them apart.
      const correctConsistency = checkGenerationConsistency(correct.declaration);
      const brokenConsistency = checkGenerationConsistency(broken.declaration);
      expect(correctConsistency.ok).toBe(true);
      expect(brokenConsistency.ok).toBe(true);
      expect(brokenConsistency.digest).toBe(correctConsistency.digest);

      // 3. Yet the behavioral oracle DOES tell them apart.
      const correctReport = await runOracle(correct);
      const brokenReport = await runOracle(broken);
      expect(correctReport.ok).toBe(true);
      expect(brokenReport.ok).toBe(false);
      expect(failureFor(brokenReport, axis)).toBeDefined();
    },
  );

  it('the whole seeded-break suite fails behaviorally but agrees under generation-consistency', async () => {
    const brokenSubjects = ORACLE_AXES.map((axis) => seededBreak(axis).broken);

    // Behaviorally: every broken subject is caught (five distinct failing axes).
    const suite = await runOracleSuite(brokenSubjects);
    expect(suite.ok).toBe(false);
    expect(new Set(suite.failures.map((f) => f.axis))).toEqual(new Set(ORACLE_AXES));

    // Under generation-consistency: every broken subject is green and matches
    // its correct twin — the drift guards would wave all five through.
    for (const axis of ORACLE_AXES) {
      const { correct, broken } = seededBreak(axis);
      expect(checkGenerationConsistency(broken.declaration).ok).toBe(true);
      expect(deriveGeneratedDescriptor(broken.declaration).digest).toBe(
        deriveGeneratedDescriptor(correct.declaration).digest,
      );
    }
  });
});

// ─── Discriminating unit tests for each axis check (pin the contract) ────────

describe('P03-09 oracle — per-axis check discrimination', () => {
  it('incorrect-handler: fails on non-idempotent output, passes on stable output', async () => {
    const { broken, correct } = seededBreak('incorrect-handler');
    const brokenObs = await observeBehavior(broken);
    const correctObs = await observeBehavior(correct);
    expect(checkIncorrectHandler(broken.declaration, brokenObs).status).toBe('fail');
    expect(checkIncorrectHandler(correct.declaration, correctObs).status).toBe('pass');
  });

  it('missing-authorization: fails when unauthorized caller is served, passes when refused', async () => {
    const { broken, correct } = seededBreak('missing-authorization');
    const brokenObs = await observeBehavior(broken);
    const correctObs = await observeBehavior(correct);
    expect(brokenObs.unauthorizedRefused).toBe(false);
    expect(correctObs.unauthorizedRefused).toBe(true);
    expect(checkMissingAuthorization(broken.declaration, brokenObs).status).toBe('fail');
    expect(checkMissingAuthorization(correct.declaration, correctObs).status).toBe('pass');
  });

  it('undeclared-effect: fails on a performed effect outside the declared set', async () => {
    const { broken, correct } = seededBreak('undeclared-effect');
    const brokenObs = await observeBehavior(broken);
    const correctObs = await observeBehavior(correct);
    expect(brokenObs.performedEffects.map((e) => e.effectClass)).toContain('network');
    expect(checkUndeclaredEffect(broken.declaration, brokenObs).status).toBe('fail');
    expect(checkUndeclaredEffect(correct.declaration, correctObs).status).toBe('pass');
  });

  it('malformed-output: fails on a schema-violating value, passes on a valid value', async () => {
    const { broken, correct } = seededBreak('malformed-output');
    const brokenObs = await observeBehavior(broken);
    const correctObs = await observeBehavior(correct);
    const brokenVerdict = checkMalformedOutput(broken.declaration, brokenObs);
    expect(brokenVerdict.status).toBe('fail');
    expect(brokenVerdict.diagnostic).toContain('OUTPUT_CONTRACT_VIOLATION');
    expect(checkMalformedOutput(correct.declaration, correctObs).status).toBe('pass');
  });

  // Renamed under DR-24. The old name ("…when the contract declares no roles")
  // described the VACUITY this change removed: live subjects used to carry a
  // hard-coded `requiredRoles: []`. They now carry the REAL registry roles, so
  // the axis is `not-observed` for an honest reason — either the registry
  // declares the open-role marker (no restrictive requirement to enforce) or
  // the subject exposes no authorization surface to withhold a principal at.
  it('missing-authorization axis is not-observed for a live subject that carries real registry roles', async () => {
    const subject = liveOutputSubjects()[0];
    expect(subject).toBeDefined();
    if (subject === undefined) return;
    // The declaration is no longer vacuous: it names the registry's roles.
    expect(subject.declaration.requiredRoles).not.toEqual([]);
    const obs = await observeBehavior(subject);
    const verdict = checkMissingAuthorization(subject.declaration, obs);
    expect(verdict.status).toBe('not-observed');
    expect(verdict.diagnostic).toMatch(/open-role marker|no authorization surface/);
  });
});
