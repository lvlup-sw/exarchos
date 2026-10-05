// The oracle observes real handlers, and an axis that it did not exercise reports `not-observed`.
//
// The file compares two independent sources:
// - The declarations. `TOOL_REGISTRY` holds the hand-written `roles`, annotations and
//   `outputSchema` of each action. `realActionDeclaration` reads only the registry.
// - The observed behavior. The shipped handlers run through `load()` of the implementation-binding
//   table, and the oracle reads the values that they return and the refusals that they make.
// `Oracle_RealHandlerSkipsAuthorization_IsCaught` shows that the two sources can disagree.
//
// The emission axis is not a member of `ORACLE_AXES`, so `axisCoverage()` has no row for it.
// `emissionAxisCoverage()` gives that row. `checkEmissionAxisObserved()` fails a run in which the
// axis observed nothing.
//
// @oracle-sources: ../../../../src/registry.ts, the values the shipped handlers actually return when invoked through the real implementation-binding table, the durable appends the event store confirms through its own async-scoped observation seam

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir, rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { TOOL_REGISTRY, contractEmissionsOf, type ToolAction } from '../../../../src/registry.js';
import { BINDING_TABLE } from '../../../../src/contract/bindings/binding-table.js';
import {
  derivePolicy,
  projectActionContract,
} from '../../../../src/contract/compiler/meta-model.js';
import {
  unconditionalEmissions,
  verifierDeclaredEmissions,
} from '../../../../src/dispatch/core/interceptors/emission-verifier.js';
import {
  EMISSION_AXIS,
  ORACLE_AXES,
  OPEN_ROLE_MARKER,
  axisCoverage,
  deriveGeneratedDescriptor,
  observeBehavior,
  runOracle,
  runOracleSuite,
  serializeGeneratedDescriptor,
  summarizeReport,
  verdictFor,
  type AxisVerdict,
  type OracleSubject,
} from '../../../../src/contract/oracle/oracle-seam.js';
import {
  EMISSION_PROBE_DETERMINATE_FLOOR,
  OPEN_WORLD_EXCLUSION,
  REAL_REGISTRY_PROBE_ACTION,
  REAL_REGISTRY_PROBE_ROLE,
  REAL_REGISTRY_PROBE_TOOL,
  TRUSTED_CALLER_REQUIRED,
  checkEmissionAxisObserved,
  checkEmissionProbeFloor,
  correctBaselineSubject,
  declaredEmittingActions,
  emissionProbeCorpus,
  runEmissionProbe,
  shippedEmitterCase,
  liveOutputSubjects,
  realActionDeclaration,
  realHandlerSubjects,
  realRegistryActions,
  realRegistryAuthorizationCase,
  registryDeclaredEffects,
  registryDeclaredEmissions,
  registryRequiredRoles,
  runEmissionOracleSuite,
  type DispatchContextFactory,
  type EmissionProbe,
  type RealHandlerObservationSet,
} from '../../../../src/contract/oracle/fixtures.js';
import { EventStore } from '../../../../src/events/store.js';

let stateDir: string;
let realHandlers: RealHandlerObservationSet;

/**
 * Builds the real `DispatchContext` for the fixture harness. The composition-root census allows
 * `new EventStore` only in the composition root, and it excludes test files.
 * The test builds the store here, so the harness needs no entry in the allowlist of the census.
 */
const makeRealContext: DispatchContextFactory = (dir) => ({
  stateDir: dir,
  eventStore: new EventStore(dir),
  enableTelemetry: false,
});

beforeAll(async () => {
  stateDir = makeTempDir('oracle-real-handlers-');
  realHandlers = await realHandlerSubjects(stateDir, makeRealContext);
}, 120_000);

afterAll(() => {
  rmrf(stateDir);
});

function verdictLine(v: AxisVerdict | undefined): string {
  return v === undefined ? '<no verdict>' : `[${v.status}] ${v.axis}: ${v.diagnostic}`;
}

describe('DR-24 — the oracle observes real handlers', () => {
  /**
   * The skipping handler never checks the authorization boundary and serves an unauthorized
   * caller, so the oracle must report `fail`. The enforcing twin has the same registration and
   * must pass. Its refusal comes from the real fail-closed guard, not from the oracle adapter.
   *
   * The required role comes from `ToolAction.roles` and is restrictive, not the open-role marker.
   * The two declarations serialize to the same descriptor, so only the observed behavior can tell
   * the two handlers apart.
   */
  it('Oracle_RealHandlerSkipsAuthorization_IsCaught', async () => {
    const skipping = realRegistryAuthorizationCase('skipping', stateDir, makeRealContext);
    const enforcing = realRegistryAuthorizationCase('enforcing', stateDir, makeRealContext);

    expect(skipping.action.roles.has(REAL_REGISTRY_PROBE_ROLE)).toBe(true);
    expect(skipping.subject.declaration.requiredRoles).toEqual(
      registryRequiredRoles(skipping.action),
    );
    expect(skipping.subject.declaration.requiredRoles).not.toEqual([]);
    expect(skipping.subject.declaration.requiredRoles).not.toContain(OPEN_ROLE_MARKER);

    expect(skipping.binding.tool).toBe(REAL_REGISTRY_PROBE_TOOL);
    expect(typeof skipping.binding.load).toBe('function');

    const skippingReport = await runOracle(skipping.subject);
    const skippingVerdict = verdictFor(skippingReport, 'missing-authorization');
    expect(verdictLine(skippingVerdict)).toContain('[fail]');
    expect(skippingVerdict?.status).toBe('fail');
    expect(skippingReport.ok, summarizeReport(skippingReport)).toBe(false);
    expect(skippingVerdict?.actionId).toBe(
      `${REAL_REGISTRY_PROBE_TOOL}.${REAL_REGISTRY_PROBE_ACTION}`,
    );
    expect(skippingVerdict?.diagnostic).toContain(REAL_REGISTRY_PROBE_ROLE);
    expect(skippingVerdict?.diagnostic).toContain('NOT enforced');

    const enforcingReport = await runOracle(enforcing.subject);
    const enforcingVerdict = verdictFor(enforcingReport, 'missing-authorization');
    expect(verdictLine(enforcingVerdict)).toContain('[pass]');
    expect(enforcingVerdict?.status).toBe('pass');
    expect(enforcingVerdict?.diagnostic).toContain('dispatch-authority');

    const enforcingObs = await observeBehavior(enforcing.subject);
    expect(enforcingObs.authorizedRefused).toBe(false);
    expect(enforcingObs.unauthorizedRefused).toBe(true);
    expect(JSON.stringify(enforcingObs.output)).not.toContain(TRUSTED_CALLER_REQUIRED);
    const intruderProbe = await enforcing.subject.handler(
      {},
      {
        caller: { subjectId: 'oracle-intruder', roles: [] },
        effects: { record: () => undefined, performed: [] },
      },
    );
    expect(JSON.stringify(intruderProbe)).toContain(TRUSTED_CALLER_REQUIRED);

    expect(
      serializeGeneratedDescriptor(deriveGeneratedDescriptor(skipping.subject.declaration)),
    ).toBe(
      serializeGeneratedDescriptor(deriveGeneratedDescriptor(enforcing.subject.declaration)),
    );
  }, 60_000);

  /**
   * Real handlers do not use the effect recorder of the oracle, so the effect axis has no evidence.
   * An empty recorder cannot tell "performed nothing" from "not instrumented". The verdict must be
   * `not-observed` for the real subjects and for the canned envelope subjects.
   * A handler that records its effects still reaches `pass` on the same axis.
   */
  it('Oracle_EffectAxisUnobserved_ReportsNotObservedNotPass', async () => {
    expect(realHandlers.subjects.length).toBeGreaterThan(0);

    const realSuite = await runOracleSuite(realHandlers.subjects);
    for (const report of realSuite.reports) {
      const verdict = verdictFor(report, 'undeclared-effect');
      expect(verdict?.status, `${report.actionId}: ${verdictLine(verdict)}`).toBe('not-observed');
      expect(verdict?.diagnostic).toContain('NOT');
    }

    const liveSuite = await runOracleSuite(liveOutputSubjects());
    const liveEffectStatuses = new Set(
      liveSuite.reports.map((r) => verdictFor(r, 'undeclared-effect')?.status),
    );
    expect(liveEffectStatuses).toEqual(new Set(['not-observed']));

    const combined = axisCoverage([...realSuite.reports, ...liveSuite.reports]);
    const effectCoverage = combined.find((c) => c.axis === 'undeclared-effect');
    expect(effectCoverage?.pass).toBe(0);
    expect(effectCoverage?.observed).toBe(0);
    expect(effectCoverage?.notObserved).toBeGreaterThan(100);

    const instrumented = await runOracle(correctBaselineSubject());
    expect(verdictFor(instrumented, 'undeclared-effect')?.status).toBe('pass');
  }, 60_000);
});

describe('DR-24 — live declarations are registry-derived, not fixture literals', () => {
  /**
   * The roles and the effects of each declaration equal those of the registry entry of its action.
   * No role list and no effect list is empty. At least one action must declare a restrictive role.
   * If none does, populated roles prove nothing.
   */
  it('EveryLiveSubjectCarriesTheRealRegistryRolesAndEffects', () => {
    const subjects = liveOutputSubjects();
    const actions = realRegistryActions();
    expect(subjects.length).toBe(actions.length);
    expect(subjects.length).toBeGreaterThanOrEqual(100);

    for (const [index, subject] of subjects.entries()) {
      const entry = actions[index];
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      expect(subject.declaration.requiredRoles).toEqual([...entry.action.roles].sort());
      expect(subject.declaration.declaredEffects).toEqual(
        registryDeclaredEffects(entry.action),
      );
      expect(subject.declaration.requiredRoles.length).toBeGreaterThan(0);
      expect(subject.declaration.declaredEffects.length).toBeGreaterThan(0);
    }

    const restrictive = subjects.filter(
      (s) => !s.declaration.requiredRoles.every((r) => r === OPEN_ROLE_MARKER),
    );
    expect(restrictive.length).toBeGreaterThan(0);
  });

  /** No annotation claims a subprocess, so `process` is never a declared effect. */
  it('DeclaredEffectsFollowTheRegistryOpenWorldAnnotation', () => {
    for (const { action } of realRegistryActions()) {
      const effects = registryDeclaredEffects(action);
      expect(effects).toContain('filesystem');
      expect(effects.includes('network')).toBe(action.annotations.openWorld);
      expect(effects).not.toContain('process');
    }
  });
});

/**
 * `actionContract.emissions` of the registry is the authority. The compiler (`autoEmits`), the
 * dispatch verifier and the oracle (`declaredEmissions`) each project it through a separate path.
 * The compiler and the oracle keep `{event, condition}`. The verifier keeps only the `always`
 * events. A projection fails here if it drops `condition` or makes a conditional edge required.
 */
describe('the emission vocabulary is shared by the registry, compiler, verifier and oracle', () => {
  const pair = (e: { readonly event: string; readonly condition: string }): string =>
    `${e.event}/${e.condition}`;

  /**
   * The test also asserts the denominator: at least 50 actions declare an emission, and both
   * conditions occur. Agreement over an empty or uniform corpus proves nothing about a projection.
   */
  it('EmissionProjection_RegistryCompilerVerifierOracle_Agree', () => {
    let declaring = 0;
    let withAlways = 0;
    let withConditional = 0;

    for (const { action, actionId } of realRegistryActions()) {
      const authority = contractEmissionsOf(action);
      const authorityPairs = new Set(authority.map(pair));
      const alwaysEvents = [
        ...new Set(authority.filter((e) => e.condition === 'always').map((e) => e.event)),
      ].sort();
      if (authority.length > 0) declaring += 1;
      if (alwaysEvents.length > 0) withAlways += 1;
      if (authority.some((e) => e.condition === 'conditional')) withConditional += 1;

      expect(new Set(derivePolicy(action).evidence.autoEmits.map(pair)), actionId).toEqual(
        authorityPairs,
      );

      expect(
        [
          ...unconditionalEmissions(verifierDeclaredEmissions(projectActionContract(action))),
        ].sort(),
        actionId,
      ).toEqual(alwaysEvents);

      expect(
        new Set(
          (realActionDeclaration(actionId, action).declaredEmissions ?? []).map(pair),
        ),
        actionId,
      ).toEqual(authorityPairs);
    }

    expect(declaring).toBeGreaterThanOrEqual(50);
    expect(withAlways).toBeGreaterThan(0);
    expect(withConditional).toBeGreaterThan(0);
  });

  /**
   * For an envelope subject, the oracle observes `() => envelope`, not the handler. Thus no append
   * belongs to the subject. Its declaration omits the emission set, and the axis then reports
   * `not-observed`. At least 50 of these actions declare emissions in the registry, so the
   * omission removes real edges.
   */
  it('EnvelopeObservationSubjects_WithholdTheEmissionSet', () => {
    const actions = realRegistryActions();
    const subjects = liveOutputSubjects();
    expect(subjects.length).toBe(actions.length);

    let declaredByTheRegistry = 0;
    for (const [index, subject] of subjects.entries()) {
      const entry = actions[index];
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      expect(subject.declaration.declaredEmissions, entry.actionId).toBeUndefined();
      if (registryDeclaredEmissions(entry.action).length > 0) declaredByTheRegistry += 1;
    }

    expect(declaredByTheRegistry).toBeGreaterThanOrEqual(50);
  });

  /**
   * `realHandlerSubjects` admits only read-only, local actions, and none of them declares an
   * `always` edge. An action with an `always` edge that joins the set fails here by name.
   */
  it('EmissionAxis_RealHandlerProbes_HaveNoUnconditionalEdgeToObserve', () => {
    const probed = new Set(realHandlers.subjects.map((s) => s.declaration.actionId));
    expect(probed.size).toBeGreaterThan(0);
    for (const { action, actionId } of realRegistryActions()) {
      if (!probed.has(actionId)) continue;
      expect(
        registryDeclaredEmissions(action).filter((e) => e.condition === 'always'),
        actionId,
      ).toEqual([]);
    }
  });
});

describe('DR-24 — real handlers are invoked through the real binding table', () => {
  /**
   * The oracle invokes at least 15 real actions. Each action that it cannot probe is in `notProbed`
   * with a reason, and the two lists together cover the registry. Each probed tool has a shipped
   * binding. The output axis observes a real returned value for each subject.
   */
  it('RealRegistryActionsAreObservedThroughTheShippedBindings', async () => {
    expect(realHandlers.subjects.length).toBeGreaterThanOrEqual(15);
    expect(realHandlers.notProbed.length).toBeGreaterThan(0);
    for (const entry of realHandlers.notProbed) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(
      realHandlers.subjects.length + realHandlers.notProbed.length,
    ).toBe(realRegistryActions().length);

    const boundTools = new Set(BINDING_TABLE.map((b) => b.tool));
    for (const subject of realHandlers.subjects) {
      const tool = subject.declaration.actionId.split('.')[0];
      expect(boundTools.has(tool ?? ''), `${subject.declaration.actionId}`).toBe(true);
    }

    const suite = await runOracleSuite(realHandlers.subjects);
    expect(
      suite.failures.map((f) => `${f.actionId}/${f.axis}: ${f.diagnostic}`),
    ).toEqual([]);

    const coverage = suite.coverage.find((c) => c.axis === 'malformed-output');
    expect(coverage?.observed).toBe(realHandlers.subjects.length);
    expect(coverage?.fail).toBe(0);
  }, 120_000);

  it('RealHandlerSubjectsProbeOnlyReadOnlyLocalActions', () => {
    const probed = new Set(realHandlers.subjects.map((s) => s.declaration.actionId));
    for (const { action, actionId } of realRegistryActions()) {
      if (!probed.has(actionId)) continue;
      expect(action.annotations.readOnly, actionId).toBe(true);
      expect(action.annotations.openWorld, actionId).toBe(false);
    }
  });
});

describe('DR-24 — "we did not look" is a distinct, non-passing outcome', () => {
  /**
   * The subject is the skipping case without its authorization surface, so the oracle cannot
   * withhold a principal. The verdict must be `not-observed`, and the report stays `ok`.
   */
  it('AuthorizationAxisIsNotObservedWithoutAProbeableSurface', async () => {
    const { subject } = realRegistryAuthorizationCase('skipping', stateDir, makeRealContext);
    const { authorizationSurface: _dropped, ...withoutSurface } = subject;
    void _dropped;

    const report = await runOracle(withoutSurface as OracleSubject);
    const verdict = verdictFor(report, 'missing-authorization');
    expect(verdict?.status).toBe('not-observed');
    expect(verdict?.status).not.toBe('pass');
    expect(verdict?.diagnostic).toContain('no authorization surface');
    expect(report.ok).toBe(true);
  }, 30_000);

  /**
   * A handler that refuses each caller also refuses the intruder.
   * That refusal is not evidence that the handler enforces a requirement.
   */
  it('AuthorizationAxisIsNotObservedWhenTheHandlerRefusesEveryCaller', async () => {
    const { subject } = realRegistryAuthorizationCase('enforcing', stateDir, makeRealContext);
    const refusesEveryone: OracleSubject = {
      ...subject,
      handler: (input, ctx) =>
        subject.handler(input, {
          ...ctx,
          caller: { subjectId: 'stripped', roles: [] },
        }),
    };

    const obs = await observeBehavior(refusesEveryone);
    expect(obs.authorizedRefused).toBe(true);
    expect(obs.unauthorizedRefused).toBe(true);

    const report = await runOracle(refusesEveryone);
    const verdict = verdictFor(report, 'missing-authorization');
    expect(verdict?.status).toBe('not-observed');
    expect(verdict?.diagnostic).toContain('AUTHORIZED probe was declined');
  }, 30_000);

  it('OpenRoleMarkerActionsReportNotObservedWithTheStatedReason', async () => {
    const openRoleSubject = liveOutputSubjects().find((s) =>
      s.declaration.requiredRoles.every((r) => r === OPEN_ROLE_MARKER),
    );
    expect(openRoleSubject).toBeDefined();
    if (openRoleSubject === undefined) return;

    const report = await runOracle(openRoleSubject);
    const verdict = verdictFor(report, 'missing-authorization');
    expect(verdict?.status).toBe('not-observed');
    expect(verdict?.diagnostic).toContain(OPEN_ROLE_MARKER);
  });

  /**
   * `ok: true` alone hides an axis that observed nothing. The census shows it.
   *
   * The key comparison with `ORACLE_AXES` cannot fail, because `axisCoverage()` builds its rows
   * from `ORACLE_AXES`. `tests/core/integration/suite-invariants/registry.ts` records that line as
   * a known defect. The counts beside it come from real reports.
   */
  it('AxisCoverageSeparatesNotObservedFromPassAcrossTheSuite', async () => {
    const suite = await runOracleSuite(liveOutputSubjects());
    expect(suite.ok).toBe(true);

    const byAxis = new Map(suite.coverage.map((c) => [c.axis, c]));
    expect([...byAxis.keys()].sort()).toEqual([...ORACLE_AXES].sort());
    for (const axis of ['missing-authorization', 'undeclared-effect', 'compatibility-break'] as const) {
      const coverage = byAxis.get(axis);
      expect(coverage?.pass, axis).toBe(0);
      expect(coverage?.observed, axis).toBe(0);
      expect(coverage?.notObserved, axis).toBe(suite.reports.length);
    }
    expect(byAxis.get('malformed-output')?.observed).toBe(suite.reports.length);
  }, 60_000);
});

describe('DR-24 — the controlled case is a REAL registration', () => {
  /**
   * `realRegistryAuthorizationCase` runs `validateAction`, so a declaration that the registry
   * rejects throws here. The name of the probe tool collides with no built-in tool.
   * `realActionDeclaration` derives the probe declaration on the same path as the built-in actions.
   */
  it('TheProbeActionSurvivesTheRegistryOwnRegistrationValidator', () => {
    const enforcing = realRegistryAuthorizationCase('enforcing', stateDir, makeRealContext);
    const { tool, action } = enforcing;
    expect(tool.actions).toEqual([action]);
    expect(action.outputSchema).toBeDefined();
    expect(action.annotations.safety).toBe('read-only');
    expect(TOOL_REGISTRY.some((t) => t.name === tool.name)).toBe(false);

    const actionId = `${tool.name}.${action.name}`;
    expect(realActionDeclaration(actionId, action)).toEqual(enforcing.subject.declaration);
    expect(enforcing.subject.declaration.requiredRoles).toEqual([...action.roles]);
  });
});

/**
 * The idempotency comparison masks per-call bookkeeping. The oracle honors a carrier only when
 * the observed values hold the shape that the carrier declares. Thus a mask cannot make a false
 * `pass`.
 */
describe('DR-24 — the volatility mask is auditable, not a hole', () => {
  function carrierSubject(
    outputs: readonly unknown[],
    carriers: OracleSubject['volatileCarriers'],
  ): OracleSubject {
    let call = 0;
    const base = correctBaselineSubject();
    return {
      ...base,
      declaration: { ...base.declaration, idempotent: true },
      handler: () => Promise.resolve(outputs[Math.min(call++, outputs.length - 1)]),
      ...(carriers !== undefined ? { volatileCarriers: carriers } : {}),
    };
  }

  /**
   * Without a mask, the `_perf` block reads as a divergence.
   * With its true shape declared, the oracle masks the block and names it in the diagnostic.
   */
  it('HonorsACarrierOnlyWhenTheObservedValuesHoldItsDeclaredShape', async () => {
    const diverging = [
      { data: { answer: 'stable' }, _perf: { ms: 1, bytes: 2, tokens: 3 } },
      { data: { answer: 'stable' }, _perf: { ms: 9, bytes: 2, tokens: 3 } },
    ];

    const unmasked = await runOracle(carrierSubject(diverging, undefined));
    expect(verdictFor(unmasked, 'incorrect-handler')?.status).toBe('fail');

    const masked = await runOracle(
      carrierSubject(diverging, [{ path: '_perf', kind: 'measurement-block' }]),
    );
    const maskedVerdict = verdictFor(masked, 'incorrect-handler');
    expect(verdictLine(maskedVerdict)).toContain('[pass]');
    expect(maskedVerdict?.diagnostic).toContain('carriers masked: [_perf]');
  });

  /**
   * The carrier declares the payload as a per-call timestamp. The oracle must refuse the mask and
   * keep the divergent values in the comparison.
   */
  it('RefusesAMaskWhoseDeclaredShapeTheObservedValuesDoNotHold', async () => {
    const diverging = [{ data: { answer: 'first' } }, { data: { answer: 'second' } }];
    const report = await runOracle(
      carrierSubject(diverging, [{ path: 'data', kind: 'generation-timestamp' }]),
    );
    const verdict = verdictFor(report, 'incorrect-handler');
    expect(verdict?.status, verdictLine(verdict)).toBe('fail');
    expect(verdict?.diagnostic).toContain('mask REFUSED');
    expect(verdict?.diagnostic).toContain('data');
    expect(verdict?.diagnostic).toContain('first');
    expect(verdict?.diagnostic).toContain('second');
  });

  it('MasksOnlyTheDeclaredPathAndLeavesTheRestOfThePayloadObserved', async () => {
    const diverging = [
      { data: { generatedAt: '2026-01-01T00:00:00.000Z', answer: 'first' } },
      { data: { generatedAt: '2026-01-01T00:00:01.000Z', answer: 'second' } },
    ];
    const report = await runOracle(
      carrierSubject(diverging, [{ path: 'data.generatedAt', kind: 'generation-timestamp' }]),
    );
    const verdict = verdictFor(report, 'incorrect-handler');
    expect(verdict?.status, verdictLine(verdict)).toBe('fail');
    expect(verdict?.diagnostic).toContain('carriers masked: [data.generatedAt]');
    expect(verdict?.diagnostic).toContain('first');
    expect(verdict?.diagnostic).toContain('second');
    expect(verdict?.diagnostic).not.toContain('2026-01-01T00:00:00.000Z');
  });

  /**
   * The real subjects share one carrier list, which describes the shipped envelope.
   * The oracle refuses no carrier on a real handler, and each masked path is in the list.
   */
  it('RealHandlerSubjectsDeclareTheCarriersTheShippedEnvelopeActuallyStamps', async () => {
    expect(realHandlers.subjects.length).toBeGreaterThan(0);
    const declared = new Set(
      realHandlers.subjects.flatMap((s) => (s.volatileCarriers ?? []).map((c) => c.path)),
    );
    for (const subject of realHandlers.subjects) {
      expect(new Set((subject.volatileCarriers ?? []).map((c) => c.path))).toEqual(declared);
    }
    for (const subject of realHandlers.subjects) {
      const obs = await observeBehavior(subject);
      expect(obs.refusedCarriers, subject.declaration.actionId).toEqual([]);
      for (const path of obs.maskedCarriers) expect(declared.has(path)).toBe(true);
    }
  }, 120_000);
});

/** The corpus member the emission claims are made against. */
const SHIPPED_APPENDER = 'exarchos_workflow.feedback';

function corpusProbe(actionId: string): EmissionProbe {
  const probe = emissionProbeCorpus().probes.find((entry) => entry.actionId === actionId);
  if (probe === undefined) {
    throw new Error(`'${actionId}' left the probe corpus — the emission claims lost their subject`);
  }
  return probe;
}

/** The event types the action's own contract says it appends on every branch. */
function unconditionalEvents(action: ToolAction): readonly string[] {
  return contractEmissionsOf(action)
    .filter((emission) => emission.condition === 'always')
    .map((emission) => emission.event);
}

/**
 * The emission evidence comes from the event store. `compositeHandlerAdapter` installs the append
 * observer around the call, so the axis reads the appends that the store confirmed durable.
 * The positive case is a shipped emitter from the probe corpus, dispatched through its real
 * binding into an isolated store. The negative control is a fixture handler with the declaration
 * of the same action. That handler appends nothing.
 */
describe('the emission axis reaches a verdict on a live subject', () => {
  /**
   * The store is idempotent. A second observation of the same input in the same store collapses
   * onto the first write, and the store reports no append. Each observation gets a new directory.
   *
   * The subject is a registered action behind a shipped binding, and its declaration is the
   * registry projection. Each observed emission carries the stream and sequence from the store.
   */
  it('OracleEmission_ShippedAppender_ProducesPassFromObservedStoreAppend', async () => {
    const evidenceDir = makeTempDir('oracle-shipped-appender-evidence-');
    const verdictDir = makeTempDir('oracle-shipped-appender-verdict-');
    try {
      const probe = corpusProbe(SHIPPED_APPENDER);
      const shipped = await shippedEmitterCase(probe, 'appending', evidenceDir, makeRealContext);

      expect(shipped.actionId).toBe(SHIPPED_APPENDER);
      expect(realRegistryActions().map((e) => e.actionId)).toContain(shipped.actionId);
      expect(BINDING_TABLE.map((b) => b.tool)).toContain(shipped.binding.tool);

      expect(shipped.subject.declaration.declaredEmissions).toEqual(
        registryDeclaredEmissions(shipped.action),
      );
      const required = unconditionalEvents(shipped.action);
      expect(required.length, `${SHIPPED_APPENDER} declares no unconditional edge`).toBeGreaterThan(
        0,
      );

      const obs = await observeBehavior(shipped.subject);
      expect(obs.performedEmissions.map((e) => e.eventType)).toEqual(
        expect.arrayContaining([...required]),
      );
      for (const emission of obs.performedEmissions) {
        expect(emission.evidence).toMatch(/^store append: .+#\d+$/);
      }
      expect(
        fs.readdirSync(evidenceDir).some((entry) => /\.db(-wal|-shm)?$/.test(entry)),
        `${SHIPPED_APPENDER} appended without materialising a store in ${evidenceDir}`,
      ).toBe(true);

      const fresh = await shippedEmitterCase(probe, 'appending', verdictDir, makeRealContext);
      const report = await runOracle(fresh.subject);
      expect(report.emissionVerdict.status, summarizeReport(report)).toBe('pass');
    } finally {
      rmrf(evidenceDir);
      rmrf(verdictDir);
    }
  }, 120_000);

  /**
   * The silent twin has the declaration of the shipped action and a different bound handler.
   * It appends nothing. The verdict runs against a store that the probe never touched, so an
   * idempotency collapse cannot explain the silence.
   */
  it('OracleEmission_SilentTwinWithSameDeclaration_ProducesFail', async () => {
    const probe = corpusProbe(SHIPPED_APPENDER);
    const appendingDir = makeTempDir('oracle-silent-twin-appending-');
    const evidenceDir = makeTempDir('oracle-silent-twin-evidence-');
    const verdictDir = makeTempDir('oracle-silent-twin-verdict-');
    try {
      const appending = await shippedEmitterCase(probe, 'appending', appendingDir, makeRealContext);
      const silent = await shippedEmitterCase(probe, 'silent', evidenceDir, makeRealContext);

      expect(silent.action).toBe(appending.action);
      expect(silent.subject.declaration.declaredEmissions).toEqual(
        registryDeclaredEmissions(appending.action),
      );
      expect(
        serializeGeneratedDescriptor(deriveGeneratedDescriptor(silent.subject.declaration)),
      ).toBe(
        serializeGeneratedDescriptor(deriveGeneratedDescriptor(appending.subject.declaration)),
      );

      expect(silent.binding.load).not.toBe(appending.binding.load);

      const obs = await observeBehavior(silent.subject);
      expect(obs.performedEmissions).toEqual([]);

      const fresh = await shippedEmitterCase(probe, 'silent', verdictDir, makeRealContext);
      const report = await runOracle(fresh.subject);
      expect(report.emissionVerdict.status, summarizeReport(report)).toBe('fail');
      for (const event of unconditionalEvents(appending.action)) {
        expect(report.emissionVerdict.diagnostic).toContain(event);
      }
      expect(report.ok, summarizeReport(report)).toBe(false);
    } finally {
      rmrf(appendingDir);
      rmrf(evidenceDir);
      rmrf(verdictDir);
    }
  }, 120_000);

  /**
   * The envelope subjects give the emission axis no verdict, and that vacuity fails the emission
   * suite. It fails nothing else: the three other unobserved axes stay at `observed: 0` with no
   * failure, and the inner suite stays `ok`. The vacuity verdict names an axis that is not in
   * `ORACLE_AXES`. One shipped emitter with a determinate verdict removes the vacuity.
   */
  it('OracleEmission_ZeroObservedSubjects_FailsForThisAxisOnly', async () => {
    const vacuous = await runEmissionOracleSuite(liveOutputSubjects());
    expect(vacuous.suite.reports.length).toBeGreaterThanOrEqual(100);
    expect(vacuous.coverage.observed).toBe(0);
    expect(vacuous.coverage.notObserved).toBe(vacuous.suite.reports.length);

    expect(vacuous.vacuity.status).toBe('fail');
    expect(vacuous.vacuity.axis).toBe(EMISSION_AXIS);
    expect(vacuous.vacuity.diagnostic).toContain('observed NOTHING');
    expect(vacuous.ok).toBe(false);

    expect(vacuous.suite.ok).toBe(true);
    expect(
      vacuous.suite.failures.map((f) => `${f.actionId}/${f.axis}: ${f.diagnostic}`),
    ).toEqual([]);
    const byAxis = new Map(vacuous.suite.coverage.map((c) => [c.axis, c]));
    for (const axis of [
      'missing-authorization',
      'undeclared-effect',
      'compatibility-break',
    ] as const) {
      expect(byAxis.get(axis)?.observed, axis).toBe(0);
      expect(byAxis.get(axis)?.notObserved, axis).toBe(vacuous.suite.reports.length);
      expect(byAxis.get(axis)?.fail, axis).toBe(0);
    }

    const unionAxes: readonly string[] = ORACLE_AXES;
    expect(unionAxes).not.toContain(vacuous.vacuity.axis);

    const determinateDir = makeTempDir('oracle-emission-determinate-');
    try {
      const determinate = await shippedEmitterCase(
        corpusProbe(SHIPPED_APPENDER),
        'appending',
        determinateDir,
        makeRealContext,
      );
      const withLiveSubject = await runEmissionOracleSuite([
        ...realHandlers.subjects,
        determinate.subject,
      ]);
      expect(withLiveSubject.coverage.observed).toBe(1);
      expect(withLiveSubject.coverage.pass).toBe(1);
      expect(withLiveSubject.coverage.notObserved).toBe(realHandlers.subjects.length);
      expect(withLiveSubject.vacuity.status).toBe('pass');
      expect(
        withLiveSubject.ok,
        withLiveSubject.suite.failures.map((f) => `${f.actionId}/${f.axis}`).join(', '),
      ).toBe(true);
    } finally {
      rmrf(determinateDir);
    }
  }, 180_000);

  /**
   * `runEmissionOracleSuite` selects `ALL_AXES`, so each subject has the emission axis selected.
   * No subject reaches a determinate verdict. The diagnostic must say that the axis observed
   * nothing, not that no report selected the axis.
   */
  it('RunEmissionOracleSuite_ZeroObserved_FailsDistinctly', async () => {
    const subjects = liveOutputSubjects();
    const vacuous = await runEmissionOracleSuite(subjects);
    expect(vacuous.vacuity.status).toBe('fail');
    expect(vacuous.vacuity.diagnostic).toContain('observed NOTHING');
    expect(vacuous.vacuity.diagnostic).not.toContain('never asked to look');
  });

  /**
   * A run with only the standard axes leaves `emissionVerdict` as `undefined` on each report.
   * That defect differs from "selected but observed nothing", so the two diagnostics must differ.
   * Zero reports fail with the message for zero selected subjects.
   */
  it('CheckEmissionAxisObserved_ZeroSelectedSubjects_FailsDistinctly', async () => {
    const subjects = [correctBaselineSubject()];
    const standardOnly = await runOracleSuite(subjects, { axes: ORACLE_AXES });
    expect(standardOnly.reports.every((r) => r.emissionVerdict === undefined)).toBe(true);

    const zeroSelected = checkEmissionAxisObserved(standardOnly.reports);
    expect(zeroSelected.status).toBe('fail');
    expect(zeroSelected.diagnostic).toContain('never asked to look');
    expect(zeroSelected.diagnostic).not.toContain('observed NOTHING');

    const noReports = checkEmissionAxisObserved([]);
    expect(noReports.status).toBe('fail');
    expect(noReports.diagnostic).toContain('never asked to look');

    const emissionSelected = await runOracleSuite(subjects, { axes: [EMISSION_AXIS] });
    const allNotObserved = checkEmissionAxisObserved(emissionSelected.reports);
    expect(allNotObserved.status).toBe('fail');
    expect(allNotObserved.diagnostic).toContain('observed NOTHING');
    expect(allNotObserved.diagnostic).not.toBe(zeroSelected.diagnostic);
  });
});

/**
 * `realHandlerSubjects` admits only `readOnly` actions, and an append is a mutation. The probe
 * corpus admits a mutating action when its mutation stays in a temporary state directory that the
 * caller owns. Three tests hold the corpus to that rule:
 * - Each member is schema-valid, runs offline to completion, and writes only in its own directory.
 * - A floor pins the count of members that can reach a determinate verdict.
 * - The probed set and the excluded set partition the population that declares emissions.
 *
 * The helper `envelopeSuccess` reads `success` from an envelope and does not check the full shape.
 */
describe('the shipped-emitter probe corpus', () => {
  function envelopeSuccess(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || !('success' in value)) return undefined;
    const { success } = value;
    return success;
  }

  /**
   * Each probe gets a new temporary directory, and a probe that appends must leave its store there.
   * Each run must return an envelope, because a member that throws is not a probe.
   * At least one probe must append. If none appends, the containment checks pass with no write.
   * After the full corpus, the repository root and `.exarchos` must hold no event store.
   */
  it('EmissionProbeCorpus_EveryEntryIsSchemaValidLocalAndIsolated', async () => {
    const corpus = emissionProbeCorpus();
    expect(corpus.probes.length).toBeGreaterThan(0);

    const byId = new Map(declaredEmittingActions().map((e) => [e.actionId, e.action]));
    const repoRoot = process.cwd();
    const repoStateDir = path.join(repoRoot, '.exarchos');
    const dbLike = (entry: string): boolean => /\.db(-wal|-shm)?$/.test(entry);
    const usedDirs = new Set<string>();
    let observedAppends = 0;

    for (const probe of corpus.probes) {
      const action = byId.get(probe.actionId);
      expect(action, probe.actionId).toBeDefined();
      if (action === undefined) continue;

      expect(action.annotations.openWorld, probe.actionId).toBe(false);

      expect(action.schema.safeParse(probe.input).success, probe.actionId).toBe(true);
      for (const step of probe.setup) {
        const stepAction = byId.get(step.actionId) ?? null;
        const stepSchema =
          stepAction ?? realRegistryActions().find((e) => e.actionId === step.actionId)?.action;
        expect(stepSchema, `${probe.actionId} setup ${step.actionId}`).toBeDefined();
        if (stepSchema === undefined || stepSchema === null) continue;
        expect(
          stepSchema.schema.safeParse(step.input).success,
          `${probe.actionId} setup ${step.actionId}`,
        ).toBe(true);
      }

      const probeDir = makeTempDir('oracle-emission-probe-');
      expect(probeDir.startsWith(os.tmpdir()), probeDir).toBe(true);

      expect(usedDirs.has(probeDir)).toBe(false);
      usedDirs.add(probeDir);
      try {
        const run = await runEmissionProbe(probe, probeDir, makeRealContext);
        expect(typeof envelopeSuccess(run.result), `${probe.actionId}: ${String(run.result)}`).toBe(
          'boolean',
        );
        if (run.appended.length > 0) {
          observedAppends += 1;
          expect(fs.readdirSync(probeDir).some(dbLike), probe.actionId).toBe(true);
        }
      } finally {
        rmrf(probeDir);
      }
      expect(fs.existsSync(probeDir), `${probe.actionId} left its temp dir behind`).toBe(false);
    }

    expect(observedAppends).toBeGreaterThan(0);

    expect(
      fs.readdirSync(repoStateDir).filter(dbLike),
      'a probe wrote an event store into the repository state dir',
    ).toEqual([]);
    expect(
      fs.readdirSync(repoRoot).filter(dbLike),
      'a probe wrote an event store into the repository root',
    ).toEqual([]);
  }, 300_000);

  /**
   * The determinate members come from the registry declaration, not from the corpus literal.
   * An emptied corpus must fail the floor, and so must a corpus with only conditional-edge members.
   */
  it('EmissionProbeCorpus_ZeroEntries_FailsTheFloor', () => {
    const corpus = emissionProbeCorpus();
    const verdict = checkEmissionProbeFloor(corpus);

    expect(verdict.ok, verdict.diagnostic).toBe(true);
    expect(verdict.determinate.length).toBeGreaterThanOrEqual(EMISSION_PROBE_DETERMINATE_FLOOR);
    expect(EMISSION_PROBE_DETERMINATE_FLOOR).toBeGreaterThan(0);
    for (const actionId of verdict.determinate) {
      const action = declaredEmittingActions().find((e) => e.actionId === actionId)?.action;
      expect(action, actionId).toBeDefined();
      if (action === undefined) continue;
      expect(
        contractEmissionsOf(action).some((e) => e.condition === 'always'),
        actionId,
      ).toBe(true);
    }

    const emptied = checkEmissionProbeFloor({ ...corpus, probes: [] });
    expect(emptied.ok).toBe(false);
    expect(emptied.determinate).toEqual([]);
    expect(emptied.diagnostic).toContain('below the floor');

    const conditionalOnly = corpus.probes.filter(
      (probe) => !verdict.determinate.includes(probe.actionId),
    );
    expect(conditionalOnly.length).toBeGreaterThan(0);
    expect(checkEmissionProbeFloor({ ...corpus, probes: conditionalOnly }).ok).toBe(false);
  });

  /**
   * Each declared emitter is probed or excluded, and none is both. No exclusion names an action
   * that declares no emission, and each exclusion carries a reason.
   * The `openWorld` exclusions equal the emitters that the registry annotates as `openWorld`.
   * The corpus is the smaller set: the excluded actions outnumber the probes.
   */
  it('EmissionProbeCorpus_ExcludedActions_ReportReasons', () => {
    const corpus = emissionProbeCorpus();

    expect(corpus.declaredEmitters.length).toBeGreaterThanOrEqual(50);
    expect(new Set(corpus.declaredEmitters).size).toBe(corpus.declaredEmitters.length);

    const probed = corpus.probes.map((probe) => probe.actionId);
    const excluded = corpus.excluded.map((entry) => entry.actionId);
    expect(corpus.unclassified, 'a declared emitter is neither probed nor excluded').toEqual([]);
    expect(corpus.stale, 'an exclusion names an action that declares no emission').toEqual([]);
    expect(
      corpus.doublyClassified,
      'a hand-authored exclusion names an action the corpus also probes',
    ).toEqual([]);
    expect(new Set(excluded).size).toBe(excluded.length);
    expect(probed.filter((id) => excluded.includes(id))).toEqual([]);
    expect([...probed, ...excluded].sort()).toEqual([...corpus.declaredEmitters].sort());

    for (const entry of corpus.excluded) {
      expect(entry.reason.trim().length, entry.actionId).toBeGreaterThan(0);
    }

    const openWorldEmitters = declaredEmittingActions()
      .filter((e) => e.action.annotations.openWorld)
      .map((e) => e.actionId)
      .sort();
    expect(openWorldEmitters.length).toBeGreaterThan(0);
    expect(
      corpus.excluded
        .filter((entry) => entry.reason === OPEN_WORLD_EXCLUSION)
        .map((entry) => entry.actionId)
        .sort(),
    ).toEqual(openWorldEmitters);

    expect(corpus.excluded.length).toBeGreaterThan(corpus.probes.length);
  });
});
