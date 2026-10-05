/**
 * The oracle compares the declared contract with the observed behavior, on a route that is
 * independent of the generation pipeline. The live system passes. The oracle catches each seeded
 * break with a diagnostic that names the action and the axis. Generation-consistency sees none of
 * the breaks, and that proves the independence.
 */
import { z } from 'zod';
import { describe, it, expect } from 'vitest';
import {
  ORACLE_AXES,
  EMISSION_AXIS,
  EmptyAxisSelectionError,
  checkDeclaredEmission,
  checkGenerationConsistency,
  checkIncorrectHandler,
  checkMalformedOutput,
  checkMissingAuthorization,
  checkUndeclaredEffect,
  deriveGeneratedDescriptor,
  emissionWasSelected,
  failureFor,
  observeBehavior,
  runOracle,
  runOracleSuite,
  serializeGeneratedDescriptor,
  summarizeReport,
  type ContractDeclaration,
  type DeclaredEmission,
  type EmissionRecorder,
  type ObservableHandler,
  type OracleAxis,
  type OracleSubject,
} from '../../../../src/contract/oracle/oracle-seam.js';
import {
  correctBaselineSubject,
  liveOutputSubjects,
  liveSuccessOutputSubjects,
  seedActionId,
  seededBreak,
} from '../../../../src/contract/oracle/fixtures.js';

describe('P03-09 oracle — (a) the live system passes the oracle', () => {
  /** The suite must observe the live surface: at least 100 actions. */
  it('EveryRealActionOutputContractAdmitsTheRuntimeErrorEnvelope', async () => {
    const subjects = liveOutputSubjects();
    expect(subjects.length).toBeGreaterThanOrEqual(100);

    const suite = await runOracleSuite(subjects);
    expect(suite.failures.map((f) => `${f.actionId}/${f.axis}: ${f.diagnostic}`)).toEqual([]);
    expect(suite.ok).toBe(true);
  });

  /**
   * Most actions accept the success envelope over empty data. An action with a typed `data` shape
   * rejects it and goes into `skipped`. The error-envelope test above observes those actions.
   */
  it('EveryDataAgnosticActionAdmitsTheRuntimeSuccessEnvelope', async () => {
    const { subjects, skipped } = liveSuccessOutputSubjects();
    expect(subjects.length).toBeGreaterThanOrEqual(100);
    expect(skipped.length).toBeLessThan(subjects.length);

    const suite = await runOracleSuite(subjects, { axes: ['malformed-output'] });
    expect(suite.failures).toEqual([]);
    expect(suite.ok).toBe(true);
  });

  /** Each axis must reach `pass`. A `not-observed` verdict fails this test. */
  it('TheCorrectBaselineSubjectPassesAllFiveAxes', async () => {
    const report = await runOracle(correctBaselineSubject());
    expect(report.ok).toBe(true);
    const byAxis = new Map(report.verdicts.map((v) => [v.axis, v]));
    for (const axis of ORACLE_AXES) {
      expect(byAxis.get(axis)?.status, `${axis}: ${summarizeReport(report)}`).toBe('pass');
    }
  });
});

describe('P03-09 oracle — (b)–(f) each seeded break is caught', () => {
  /**
   * The correct twin has the same declaration and passes. The broken handler fails on this axis
   * only. The failure and the summary both name the action and the axis.
   */
  it.each(ORACLE_AXES)(
    'catches the seeded %s break with a diagnostic naming the action and the axis',
    async (axis: OracleAxis) => {
      const { correct, broken } = seededBreak(axis);

      const correctReport = await runOracle(correct);
      expect(correctReport.ok, summarizeReport(correctReport)).toBe(true);

      const report = await runOracle(broken);
      expect(report.ok, summarizeReport(report)).toBe(false);

      const failedAxes = report.verdicts.filter((v) => v.status === 'fail').map((v) => v.axis);
      expect(failedAxes).toEqual([axis]);

      const failure = failureFor(report, axis);
      expect(failure).toBeDefined();
      expect(failure?.actionId).toBe(seedActionId(axis));
      expect(failure?.axis).toBe(axis);
      expect(failure?.diagnostic.length).toBeGreaterThan(0);

      const summary = summarizeReport(report);
      expect(summary).toContain(seedActionId(axis));
      expect(summary).toContain(axis);
    },
  );
});

describe('P03-09 oracle — (g) each seeded break is INVISIBLE to generation-consistency', () => {
  /**
   * The generation route reads only the declaration. The broken subject and the correct subject
   * share one declaration, so the generated descriptor and the consistency digest are equal.
   * Only the behavioral oracle tells the two subjects apart.
   */
  it.each(ORACLE_AXES)(
    'the %s break leaves the generated artifact byte-identical, yet the oracle distinguishes it',
    async (axis: OracleAxis) => {
      const { correct, broken } = seededBreak(axis);

      const correctGen = serializeGeneratedDescriptor(
        deriveGeneratedDescriptor(correct.declaration),
      );
      const brokenGen = serializeGeneratedDescriptor(
        deriveGeneratedDescriptor(broken.declaration),
      );
      expect(brokenGen).toBe(correctGen);

      const correctConsistency = checkGenerationConsistency(correct.declaration);
      const brokenConsistency = checkGenerationConsistency(broken.declaration);
      expect(correctConsistency.ok).toBe(true);
      expect(brokenConsistency.ok).toBe(true);
      expect(brokenConsistency.digest).toBe(correctConsistency.digest);

      const correctReport = await runOracle(correct);
      const brokenReport = await runOracle(broken);
      expect(correctReport.ok).toBe(true);
      expect(brokenReport.ok).toBe(false);
      expect(failureFor(brokenReport, axis)).toBeDefined();
    },
  );

  /**
   * The oracle catches each broken subject, on five distinct axes. Generation-consistency passes
   * each broken subject, and its digest equals the digest of the correct twin.
   */
  it('the whole seeded-break suite fails behaviorally but agrees under generation-consistency', async () => {
    const brokenSubjects = ORACLE_AXES.map((axis) => seededBreak(axis).broken);

    const suite = await runOracleSuite(brokenSubjects);
    expect(suite.ok).toBe(false);
    expect(new Set(suite.failures.map((f) => f.axis))).toEqual(new Set(ORACLE_AXES));

    for (const axis of ORACLE_AXES) {
      const { correct, broken } = seededBreak(axis);
      expect(checkGenerationConsistency(broken.declaration).ok).toBe(true);
      expect(deriveGeneratedDescriptor(broken.declaration).digest).toBe(
        deriveGeneratedDescriptor(correct.declaration).digest,
      );
    }
  });
});

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

  /**
   * A live subject carries the roles of the registry, so `requiredRoles` is not empty.
   * The axis is `not-observed` for one of two reasons: the registry declares the open-role marker,
   * or the subject has no authorization surface.
   */
  it('missing-authorization axis is not-observed for a live subject that carries real registry roles', async () => {
    const subject = liveOutputSubjects()[0];
    expect(subject).toBeDefined();
    if (subject === undefined) return;
    expect(subject.declaration.requiredRoles).not.toEqual([]);
    const obs = await observeBehavior(subject);
    const verdict = checkMissingAuthorization(subject.declaration, obs);
    expect(verdict.status).toBe('not-observed');
    expect(verdict.diagnostic).toMatch(/open-role marker|no authorization surface/);
  });
});

const EMISSION_EVENT_TYPE = 'oracle_probe.appended';
const EMISSION_EVIDENCE = 'store.append:oracle-probe-stream';
const BRANCH_EVENT_TYPE = 'oracle_probe.branch_appended';

const ALWAYS_EDGE: DeclaredEmission = { event: EMISSION_EVENT_TYPE, condition: 'always' };

function emissionProbeDeclaration(
  declaredEmissions: readonly DeclaredEmission[] = [ALWAYS_EDGE],
): ContractDeclaration {
  return {
    actionId: 'oracle_probe.declared_emission',
    safety: 'local-mutation',
    readOnly: false,
    idempotent: true,
    requiredRoles: [],
    declaredEffects: [],
    declaredEmissions,
    inputSchema: z.object({}),
    outputSchema: z.object({ id: z.string() }),
    surfaceVersion: '1.0.0',
  };
}

function emissionProbeSubject(handler: ObservableHandler): OracleSubject {
  return { declaration: emissionProbeDeclaration(), handler, probeInput: {} };
}

/** Records the emission it declares — the append genuinely lands. */
const emittingHandler: ObservableHandler = (_input, ctx) => {
  ctx.emissions?.record(EMISSION_EVENT_TYPE, EMISSION_EVIDENCE);
  return { id: 'req-1' };
};

/** Declares the emission (via the shared declaration) but never appends. */
const silentHandler: ObservableHandler = () => ({ id: 'req-1' });

/** Records exactly the appends named, wherever the branch it stands for lands. */
function appendingHandler(...events: readonly string[]): ObservableHandler {
  return (_input, ctx) => {
    for (const event of events) ctx.emissions?.record(event, `${EMISSION_EVIDENCE}:${event}`);
    return { id: 'req-1' };
  };
}

/**
 * The evidence of the emission axis is an observed append in the recorder that `observeBehavior`
 * injects. A read of `declaredEmissions` is not evidence. These subjects are local, so each case
 * can vary the declared `{event, condition}` set. `fixtures.test.ts` covers the registry
 * declarations.
 */
describe('P03-09 oracle — emission axis observes the append, not the declaration', () => {
  /**
   * `observeBehavior` calls the handler three times: two authorized calls for the idempotency pair
   * and one unauthorized call. Each call gets a new recorder, and the caller supplies none.
   * The axis reads the append of the first authorized call.
   */
  it('OracleEmission_Recorder_IsMintedAndInjectedLikeTheEffectRecorder', async () => {
    const seenRecorders: (EmissionRecorder | undefined)[] = [];
    const capturingHandler: ObservableHandler = (_input, ctx) => {
      seenRecorders.push(ctx.emissions);
      ctx.emissions?.record(EMISSION_EVENT_TYPE, EMISSION_EVIDENCE);
      return { id: 'req-1' };
    };
    const subject = emissionProbeSubject(capturingHandler);
    const obs = await observeBehavior(subject);

    expect(seenRecorders.length).toBe(3);
    for (const rec of seenRecorders) {
      expect(rec).toBeDefined();
      expect(typeof rec?.record).toBe('function');
    }
    expect(new Set(seenRecorders).size).toBe(3);

    expect(obs.performedEmissions).toEqual([
      { eventType: EMISSION_EVENT_TYPE, evidence: EMISSION_EVIDENCE },
    ]);
    expect(checkDeclaredEmission(subject.declaration, obs).status).toBe('pass');
  });

  /**
   * The two subjects share one declaration, so their generated artifacts are equal.
   * The handler that appends passes. The handler that never appends fails on the emission axis
   * only, and the suite failures carry that verdict.
   */
  it('Oracle_DeclaredButUnappended_FailsWhenGeneratedFilesAgree', async () => {
    const correctSubject = emissionProbeSubject(emittingHandler);
    const brokenSubject = emissionProbeSubject(silentHandler);

    const correctGen = serializeGeneratedDescriptor(
      deriveGeneratedDescriptor(correctSubject.declaration),
    );
    const brokenGen = serializeGeneratedDescriptor(
      deriveGeneratedDescriptor(brokenSubject.declaration),
    );
    expect(brokenGen).toBe(correctGen);
    expect(checkGenerationConsistency(brokenSubject.declaration).ok).toBe(true);
    expect(checkGenerationConsistency(brokenSubject.declaration).digest).toBe(
      checkGenerationConsistency(correctSubject.declaration).digest,
    );

    const correctReport = await runOracle(correctSubject);
    expect(correctReport.emissionVerdict.status, summarizeReport(correctReport)).toBe('pass');
    expect(correctReport.ok, summarizeReport(correctReport)).toBe(true);

    const brokenReport = await runOracle(brokenSubject);
    expect(brokenReport.emissionVerdict.status, summarizeReport(brokenReport)).toBe('fail');
    expect(brokenReport.emissionVerdict.diagnostic).toContain(EMISSION_EVENT_TYPE);
    expect(brokenReport.ok, summarizeReport(brokenReport)).toBe(false);

    const failedAxes = [...brokenReport.verdicts, brokenReport.emissionVerdict]
      .filter((v) => v.status === 'fail')
      .map((v) => v.axis);
    expect(failedAxes).toEqual([EMISSION_AXIS]);

    const suite = await runOracleSuite([brokenSubject]);
    expect(suite.ok).toBe(false);
    expect(suite.failures).toContainEqual(brokenReport.emissionVerdict);
    expect(brokenReport.clean).toBe(false);
    expect(suite.clean).toBe(false);
  });

  it('Oracle_Unobserved_IsNotPass', async () => {
    const declaration: ContractDeclaration = {
      actionId: 'oracle_probe.unobserved',
      safety: 'read-only',
      readOnly: true,
      idempotent: false,
      requiredRoles: [],
      declaredEffects: [],
      inputSchema: z.object({}),
      outputSchema: z.object({ id: z.string() }),
      surfaceVersion: '1.0.0',
    };
    const subject: OracleSubject = {
      declaration,
      handler: () => ({ id: 'req-1' }),
      probeInput: {},
    };

    const emission = checkDeclaredEmission(declaration, await observeBehavior(subject));
    expect(emission.status).toBe('not-observed');
    expect(emission.status).not.toBe('pass');

    const suite = await runOracleSuite([subject], {
      axes: [
        'missing-authorization',
        'undeclared-effect',
        'compatibility-break',
        'incorrect-handler',
        EMISSION_AXIS,
      ],
    });
    const report = suite.reports[0];
    expect(report).toBeDefined();
    if (report === undefined) return;
    expect(report.emissionVerdict).toBeDefined();

    const considered = report.emissionVerdict
      ? [...report.verdicts, report.emissionVerdict]
      : report.verdicts;
    expect(considered.every((v) => v.status === 'not-observed')).toBe(true);
    expect(considered.some((v) => v.status === 'pass')).toBe(false);
    expect(report.clean).toBe(false);
    expect(suite.clean).toBe(false);
  });

  /**
   * The oracle requires only an `always` edge, as the dispatch verifier does.
   * A conditional edge that did not fire is not a fault. It is also not a pass, because the run
   * collected no evidence. When the branch fires, the observed append gives `pass`.
   */
  it('DeclaredEmission_MissingConditionalEdge_DoesNotFail', async () => {
    const declaration = emissionProbeDeclaration([
      { event: BRANCH_EVENT_TYPE, condition: 'conditional' },
    ]);

    const unfired = checkDeclaredEmission(
      declaration,
      await observeBehavior({ declaration, handler: silentHandler, probeInput: {} }),
    );
    expect(unfired.status, unfired.diagnostic).toBe('not-observed');
    expect(unfired.status).not.toBe('fail');
    expect(unfired.diagnostic).toContain(BRANCH_EVENT_TYPE);

    const fired = checkDeclaredEmission(
      declaration,
      await observeBehavior({
        declaration,
        handler: appendingHandler(BRANCH_EVENT_TYPE),
        probeInput: {},
      }),
    );
    expect(fired.status, fired.diagnostic).toBe('pass');
    expect(fired.diagnostic).toContain(BRANCH_EVENT_TYPE);
  });

  /**
   * A missing `always` edge fails. A conditional edge that fired cannot replace it.
   * The same declaration passes when the handler also appends the `always` event.
   */
  it('DeclaredEmission_MissingAlwaysEdge_Fails', async () => {
    const declaration = emissionProbeDeclaration([ALWAYS_EDGE]);
    const verdict = checkDeclaredEmission(
      declaration,
      await observeBehavior({ declaration, handler: silentHandler, probeInput: {} }),
    );
    expect(verdict.status, verdict.diagnostic).toBe('fail');
    expect(verdict.diagnostic).toContain(EMISSION_EVENT_TYPE);

    const mixed = emissionProbeDeclaration([
      ALWAYS_EDGE,
      { event: BRANCH_EVENT_TYPE, condition: 'conditional' },
    ]);
    const masked = checkDeclaredEmission(
      mixed,
      await observeBehavior({
        declaration: mixed,
        handler: appendingHandler(BRANCH_EVENT_TYPE),
        probeInput: {},
      }),
    );
    expect(masked.status, masked.diagnostic).toBe('fail');
    expect(masked.diagnostic).toContain(EMISSION_EVENT_TYPE);

    const honored = checkDeclaredEmission(
      mixed,
      await observeBehavior({
        declaration: mixed,
        handler: appendingHandler(EMISSION_EVENT_TYPE, BRANCH_EVENT_TYPE),
        probeInput: {},
      }),
    );
    expect(honored.status, honored.diagnostic).toBe('pass');
    expect(honored.diagnostic).toContain(BRANCH_EVENT_TYPE);
  });
});

/**
 * `RunOracleOptions.axes` selects from `ALL_AXES`: the five `ORACLE_AXES` and `declared-emission`.
 * An empty array is a caller error, not a run with zero verdicts.
 */
describe('P03-09 oracle — axis selection', () => {
  it('RunOracle_EmptyAxisSelection_RejectsCall', async () => {
    const subject = correctBaselineSubject();
    await expect(runOracle(subject, { axes: [] })).rejects.toThrow(EmptyAxisSelectionError);
    await expect(runOracleSuite([subject], { axes: [] })).rejects.toThrow(EmptyAxisSelectionError);
  });

  /**
   * With the standard axes only, no report carries an emission verdict. With the emission axis
   * only, each subject gets one emission verdict and no standard verdict.
   * By default, each subject gets one emission verdict and all the standard verdicts.
   */
  it('RunOracle_StandardOnly_DoesNotEnterEmissionCensus', async () => {
    const subjects = [correctBaselineSubject(), correctBaselineSubject(), correctBaselineSubject()];

    const standardOnly = await runOracleSuite(subjects, { axes: ORACLE_AXES });
    expect(standardOnly.reports.filter(emissionWasSelected).length).toBe(0);
    expect(standardOnly.reports.every((r) => r.emissionVerdict === undefined)).toBe(true);
    expect(standardOnly.selectedAxes).not.toContain(EMISSION_AXIS);

    const emissionOnly = await runOracleSuite(subjects, { axes: [EMISSION_AXIS] });
    expect(emissionOnly.reports.filter(emissionWasSelected).length).toBe(subjects.length);
    expect(emissionOnly.reports.every((r) => r.verdicts.length === 0)).toBe(true);
    expect(emissionOnly.selectedAxes).toEqual([EMISSION_AXIS]);

    const defaultAll = await runOracleSuite(subjects);
    expect(defaultAll.reports.filter(emissionWasSelected).length).toBe(subjects.length);
    expect(defaultAll.reports.every((r) => r.verdicts.length === ORACLE_AXES.length)).toBe(true);
    expect(defaultAll.selectedAxes).toContain(EMISSION_AXIS);
  });
});
