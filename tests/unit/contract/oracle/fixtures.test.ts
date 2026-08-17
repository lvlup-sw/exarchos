// ─── DR-24: the oracle observes REAL handlers, and absence is `not-observed` ──
//
// Before DR-24 the oracle ran against ~120 real actions with hard-coded
// `requiredRoles: []` / `declaredEffects: []`. Those empty arrays made three of
// its five axes structurally incapable of reporting anything about the shipped
// system — yet the run read green, because an axis that was never exercised
// reported `pass`.
//
// These tests pin the two halves of the fix:
//
//   1. the DECLARATION is derived from the REAL action registry, and real
//      handlers — resolved through the REAL implementation-binding table — are
//      the thing invoked; and
//   2. an axis the oracle did not exercise reports `not-observed`, which is a
//      DISTINCT, NON-PASSING outcome from "we looked and it was fine".
//
// The acceptance case is a REAL handler that skips authorization: registered
// into a real registry instance through the registry's own `validateAction`,
// bound through the real binding-table constructor, and driven through the real
// dispatch caller-authorization scope. The oracle must catch it.
//
// ── The two authorities this file compares (DR-30) ──────────────────────────
//
// AUTHORITY A — THE DECLARATIONS. `TOOL_REGISTRY` in `src/registry.ts` is
//   hand-authored data. Each action's `roles`, `annotations.readOnly`,
//   `annotations.openWorld` and `outputSchema` are written by a human and say
//   what the action PROMISES. `realActionDeclaration`, `registryRequiredRoles`
//   and `registryDeclaredEffects` read that and nothing else — which is the
//   whole point of DR-24, since the pre-DR-24 oracle read hard-coded empty
//   arrays instead.
//
// AUTHORITY B — THE OBSERVED BEHAVIOR. The values the shipped handlers
//   actually return, and the refusals they actually make, when they are
//   invoked for real through the implementation-binding table's `load()`.
//   Nothing on this side is computed from Authority A: the handler bodies
//   under `src/tools/**` never read the registry's role list — they either
//   consult the authorization boundary or they do not.
//
// They are therefore able to DISAGREE, and this file carries the
// demonstration rather than asserting the agreement on trust:
// `Oracle_RealHandlerSkipsAuthorization_IsCaught` registers a real action
// whose declaration requires a restrictive role and whose real handler never
// consults the authorization boundary. Authority A says "this caller may not";
// Authority B serves the caller anyway; the oracle reports `fail`. The
// enforcing twin in the same case shows the rule is discriminating, not
// blanket.
//
// HONESTY NOTE — ONE ASSERTION HERE IS NOT A TWO-AUTHORITY CLAIM.
// `AxisCoverageSeparatesNotObservedFromPassAcrossTheSuite` compares
// `[...byAxis.keys()]` against `ORACLE_AXES`, but `axisCoverage()` builds its
// rows with `ORACLE_AXES.map(...)`, so that single line is a census compared
// against its own generator and cannot fail. It is registered as a known
// defect (`dr24/axis-census-line-is-tautological` in
// `test/integration/suite-invariants/registry.ts`) so it carries an owner and
// an expiry instead of looking like evidence. The pass / observed /
// notObserved counts asserted beside it ARE measured from real reports.
//
// @oracle-sources: ../../../../src/registry.ts, the values the shipped handlers actually return when invoked through the real implementation-binding table, the appends those handlers actually record through the recorder the adapter carries into the invocation
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTempDir, rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import { BINDING_TABLE } from '../../../../src/contract/bindings/binding-table.js';
import {
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
  REAL_REGISTRY_EMISSION_ACTION,
  REAL_REGISTRY_EMISSION_EVENT,
  REAL_REGISTRY_EMISSION_TOOL,
  REAL_REGISTRY_PROBE_ACTION,
  REAL_REGISTRY_PROBE_ROLE,
  REAL_REGISTRY_PROBE_TOOL,
  TRUSTED_CALLER_REQUIRED,
  correctBaselineSubject,
  liveOutputSubjects,
  realActionDeclaration,
  realHandlerSubjects,
  realRegistryActions,
  realRegistryAuthorizationCase,
  realRegistryEmissionCase,
  registryDeclaredEffects,
  registryRequiredRoles,
  type DispatchContextFactory,
  type RealHandlerObservationSet,
} from '../../../../src/contract/oracle/fixtures.js';
import { EventStore } from '../../../../src/events/store.js';

let stateDir: string;
let realHandlers: RealHandlerObservationSet;

/**
 * The harness receives its DispatchContext from here rather than building one
 * itself: `new EventStore` is admitted by the composition-root census only in
 * the composition root, and test files are excluded — so constructing it here
 * keeps that guard honest instead of widening its allowlist for a harness.
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
  it('Oracle_RealHandlerSkipsAuthorization_IsCaught', async () => {
    const skipping = realRegistryAuthorizationCase('skipping', stateDir, makeRealContext);
    const enforcing = realRegistryAuthorizationCase('enforcing', stateDir, makeRealContext);

    // The role requirement is the REAL registered action's, not a fixture
    // literal: it comes off `ToolAction.roles` through the registry-derived
    // declaration, and it is RESTRICTIVE (not the open-role marker), so there
    // is something for the authorization axis to actually enforce.
    expect(skipping.action.roles.has(REAL_REGISTRY_PROBE_ROLE)).toBe(true);
    expect(skipping.subject.declaration.requiredRoles).toEqual(
      registryRequiredRoles(skipping.action),
    );
    expect(skipping.subject.declaration.requiredRoles).not.toEqual([]);
    expect(skipping.subject.declaration.requiredRoles).not.toContain(OPEN_ROLE_MARKER);

    // The handler under observation is reached through a REAL, non-serializable
    // implementation binding minted by the real binding-table constructor.
    expect(skipping.binding.tool).toBe(REAL_REGISTRY_PROBE_TOOL);
    expect(typeof skipping.binding.load).toBe('function');

    // ── The defect: a real handler that never consults the authorization
    //    boundary serves an unauthorized caller, and the oracle CATCHES it.
    const skippingReport = await runOracle(skipping.subject);
    const skippingVerdict = verdictFor(skippingReport, 'missing-authorization');
    expect(verdictLine(skippingVerdict)).toContain('[fail]');
    expect(skippingVerdict?.status).toBe('fail');
    expect(skippingReport.ok, summarizeReport(skippingReport)).toBe(false);
    // The diagnostic names the offending action and the unenforced requirement.
    expect(skippingVerdict?.actionId).toBe(
      `${REAL_REGISTRY_PROBE_TOOL}.${REAL_REGISTRY_PROBE_ACTION}`,
    );
    expect(skippingVerdict?.diagnostic).toContain(REAL_REGISTRY_PROBE_ROLE);
    expect(skippingVerdict?.diagnostic).toContain('NOT enforced');

    // ── The control: the SAME real registration, bound to a real handler that
    //    does consult the trusted-caller boundary, passes the same axis.
    const enforcingReport = await runOracle(enforcing.subject);
    const enforcingVerdict = verdictFor(enforcingReport, 'missing-authorization');
    expect(verdictLine(enforcingVerdict)).toContain('[pass]');
    expect(enforcingVerdict?.status).toBe('pass');
    expect(enforcingVerdict?.diagnostic).toContain('dispatch-authority');

    // The refusal is a REAL authorization-family refusal, produced by the real
    // fail-closed guard rather than by the oracle's adapter.
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

    // Independence (exit proof g), restated on a REAL registration: the two
    // declarations are byte-identical, so no generated artifact — and no
    // declaration-to-declaration drift guard — can tell the skipping handler
    // from the enforcing one. Only the behavioral observation can.
    expect(
      serializeGeneratedDescriptor(deriveGeneratedDescriptor(skipping.subject.declaration)),
    ).toBe(
      serializeGeneratedDescriptor(deriveGeneratedDescriptor(enforcing.subject.declaration)),
    );
  }, 60_000);

  it('Oracle_EffectAxisUnobserved_ReportsNotObservedNotPass', async () => {
    // Real handlers do not emit through the oracle's effect recorder, so no
    // effect evidence is collected for them. That must read `not-observed` —
    // an empty recorder cannot distinguish "performed nothing" from "was never
    // instrumented", and the latter must never present as a clean bill.
    expect(realHandlers.subjects.length).toBeGreaterThan(0);

    const realSuite = await runOracleSuite(realHandlers.subjects);
    for (const report of realSuite.reports) {
      const verdict = verdictFor(report, 'undeclared-effect');
      expect(verdict?.status, `${report.actionId}: ${verdictLine(verdict)}`).toBe('not-observed');
      expect(verdict?.diagnostic).toContain('NOT');
    }

    // Same for the canned live-envelope subjects: the effect axis reports
    // nothing observed rather than a vacuous pass across the whole surface.
    const liveSuite = await runOracleSuite(liveOutputSubjects());
    const liveEffectStatuses = new Set(
      liveSuite.reports.map((r) => verdictFor(r, 'undeclared-effect')?.status),
    );
    expect(liveEffectStatuses).toEqual(new Set(['not-observed']));

    // The census makes the vacuity legible instead of hiding it behind `ok`.
    const combined = axisCoverage([...realSuite.reports, ...liveSuite.reports]);
    const effectCoverage = combined.find((c) => c.axis === 'undeclared-effect');
    expect(effectCoverage?.pass).toBe(0);
    expect(effectCoverage?.observed).toBe(0);
    expect(effectCoverage?.notObserved).toBeGreaterThan(100);

    // And `not-observed` is NOT a blanket downgrade: a subject whose handler
    // DOES record its effects still reaches a real `pass` on the same axis.
    const instrumented = await runOracle(correctBaselineSubject());
    expect(verdictFor(instrumented, 'undeclared-effect')?.status).toBe('pass');
  }, 60_000);
});

describe('DR-24 — live declarations are registry-derived, not fixture literals', () => {
  it('EveryLiveSubjectCarriesTheRealRegistryRolesAndEffects', () => {
    const subjects = liveOutputSubjects();
    const actions = realRegistryActions();
    expect(subjects.length).toBe(actions.length);
    expect(subjects.length).toBeGreaterThanOrEqual(100);

    for (const [index, subject] of subjects.entries()) {
      const entry = actions[index];
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      // Byte-for-byte the registry's own declaration, reached through the
      // registry object — not a literal in the fixture module.
      expect(subject.declaration.requiredRoles).toEqual([...entry.action.roles].sort());
      expect(subject.declaration.declaredEffects).toEqual(
        registryDeclaredEffects(entry.action),
      );
      // The pre-DR-24 vacuity: both arrays were unconditionally empty.
      expect(subject.declaration.requiredRoles.length).toBeGreaterThan(0);
      expect(subject.declaration.declaredEffects.length).toBeGreaterThan(0);
    }

    // The registry really does declare a restrictive requirement somewhere —
    // otherwise "roles are populated" would be a distinction without content.
    const restrictive = subjects.filter(
      (s) => !s.declaration.requiredRoles.every((r) => r === OPEN_ROLE_MARKER),
    );
    expect(restrictive.length).toBeGreaterThan(0);
  });

  it('DeclaredEffectsFollowTheRegistryOpenWorldAnnotation', () => {
    for (const { action } of realRegistryActions()) {
      const effects = registryDeclaredEffects(action);
      expect(effects).toContain('filesystem');
      expect(effects.includes('network')).toBe(action.annotations.openWorld);
      // No annotation claims a subprocess, so `process` is never declared —
      // a handler observed spawning one is an undeclared effect.
      expect(effects).not.toContain('process');
    }
  });
});

describe('DR-24 — real handlers are invoked through the real binding table', () => {
  it('RealRegistryActionsAreObservedThroughTheShippedBindings', async () => {
    // A meaningful slice of the live surface is really invoked, not canned.
    expect(realHandlers.subjects.length).toBeGreaterThanOrEqual(15);
    // Everything the oracle could NOT probe is reported, with a reason, rather
    // than silently dropped.
    expect(realHandlers.notProbed.length).toBeGreaterThan(0);
    for (const entry of realHandlers.notProbed) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(
      realHandlers.subjects.length + realHandlers.notProbed.length,
    ).toBe(realRegistryActions().length);

    // Every probed subject resolves to a tool that has a real shipped binding.
    const boundTools = new Set(BINDING_TABLE.map((b) => b.tool));
    for (const subject of realHandlers.subjects) {
      const tool = subject.declaration.actionId.split('.')[0];
      expect(boundTools.has(tool ?? ''), `${subject.declaration.actionId}`).toBe(true);
    }

    // The real handlers honor their declared output + idempotency contracts.
    const suite = await runOracleSuite(realHandlers.subjects);
    expect(
      suite.failures.map((f) => `${f.actionId}/${f.axis}: ${f.diagnostic}`),
    ).toEqual([]);

    // The output axis is genuinely OBSERVED here (real returned values), which
    // is what distinguishes it from the three vacuous axes.
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
  it('AuthorizationAxisIsNotObservedWithoutAProbeableSurface', async () => {
    // Same real registration, same restrictive role, same skipping handler —
    // but with no authorization surface the oracle never withheld a principal.
    const { subject } = realRegistryAuthorizationCase('skipping', stateDir, makeRealContext);
    const { authorizationSurface: _dropped, ...withoutSurface } = subject;
    void _dropped;

    const report = await runOracle(withoutSurface as OracleSubject);
    const verdict = verdictFor(report, 'missing-authorization');
    expect(verdict?.status).toBe('not-observed');
    expect(verdict?.status).not.toBe('pass');
    expect(verdict?.diagnostic).toContain('no authorization surface');
    // Reporting the absence must not manufacture a green verdict elsewhere.
    expect(report.ok).toBe(true);
  }, 30_000);

  it('AuthorizationAxisIsNotObservedWhenTheHandlerRefusesEveryCaller', async () => {
    // A handler that declines EVERYONE refuses the intruder too — but that is a
    // blanket failure, not evidence that a requirement is enforced.
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

  it('AxisCoverageSeparatesNotObservedFromPassAcrossTheSuite', async () => {
    const suite = await runOracleSuite(liveOutputSubjects());
    expect(suite.ok).toBe(true);

    // `ok: true` on its own conceals vacuity; the census does not.
    const byAxis = new Map(suite.coverage.map((c) => [c.axis, c]));
    expect([...byAxis.keys()].sort()).toEqual([...ORACLE_AXES].sort());
    for (const axis of ['missing-authorization', 'undeclared-effect', 'compatibility-break'] as const) {
      const coverage = byAxis.get(axis);
      expect(coverage?.pass, axis).toBe(0);
      expect(coverage?.observed, axis).toBe(0);
      expect(coverage?.notObserved, axis).toBe(suite.reports.length);
    }
    // The output axis, by contrast, really did look at every subject.
    expect(byAxis.get('malformed-output')?.observed).toBe(suite.reports.length);
  }, 60_000);
});

describe('DR-24 — the controlled case is a REAL registration', () => {
  it('TheProbeActionSurvivesTheRegistryOwnRegistrationValidator', () => {
    // `realRegistryAuthorizationCase` runs `validateAction` — the same call
    // `registry.ts` makes over every built-in action at module load — so a
    // declaration that could not be registered for real throws here.
    const enforcing = realRegistryAuthorizationCase('enforcing', stateDir, makeRealContext);
    const { tool, action } = enforcing;
    expect(tool.actions).toEqual([action]);
    expect(action.outputSchema).toBeDefined();
    expect(action.annotations.safety).toBe('read-only');
    // It is a REAL registry instance shaped exactly like the shipped one, and
    // it does not collide with a built-in tool name.
    expect(TOOL_REGISTRY.some((t) => t.name === tool.name)).toBe(false);

    // The declaration the oracle observes is derived by the same
    // registry-derivation used for the built-ins — one code path, no
    // fixture-only shortcut that could quietly hand the oracle nicer roles or
    // effects than the registry actually declares.
    const actionId = `${tool.name}.${action.name}`;
    expect(realActionDeclaration(actionId, action)).toEqual(enforcing.subject.declaration);
    expect(enforcing.subject.declaration.requiredRoles).toEqual([...action.roles]);
  });
});

describe('DR-24 — the volatility mask is auditable, not a hole', () => {
  // Masking per-call bookkeeping out of the idempotency comparison is the one
  // place the oracle deliberately looks away. A mask that were taken on trust
  // would be a way to manufacture a `pass`, so the oracle honors a carrier only
  // against the shape it declares.

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

  it('HonorsACarrierOnlyWhenTheObservedValuesHoldItsDeclaredShape', async () => {
    const diverging = [
      { data: { answer: 'stable' }, _perf: { ms: 1, bytes: 2, tokens: 3 } },
      { data: { answer: 'stable' }, _perf: { ms: 9, bytes: 2, tokens: 3 } },
    ];

    // Unmasked, the per-call measurement block reads as a real divergence.
    const unmasked = await runOracle(carrierSubject(diverging, undefined));
    expect(verdictFor(unmasked, 'incorrect-handler')?.status).toBe('fail');

    // Declared with its true shape, the mask is honored and named.
    const masked = await runOracle(
      carrierSubject(diverging, [{ path: '_perf', kind: 'measurement-block' }]),
    );
    const maskedVerdict = verdictFor(masked, 'incorrect-handler');
    expect(verdictLine(maskedVerdict)).toContain('[pass]');
    expect(maskedVerdict?.diagnostic).toContain('carriers masked: [_perf]');
  });

  it('RefusesAMaskWhoseDeclaredShapeTheObservedValuesDoNotHold', async () => {
    // The payload itself, mis-declared as a per-call timestamp carrier. If the
    // mask were taken on trust this would erase a genuine behavioral
    // divergence and manufacture a `pass`.
    const diverging = [{ data: { answer: 'first' } }, { data: { answer: 'second' } }];
    const report = await runOracle(
      carrierSubject(diverging, [{ path: 'data', kind: 'generation-timestamp' }]),
    );
    const verdict = verdictFor(report, 'incorrect-handler');
    expect(verdict?.status, verdictLine(verdict)).toBe('fail');
    expect(verdict?.diagnostic).toContain('mask REFUSED');
    expect(verdict?.diagnostic).toContain('data');
    // The divergent values are still in the comparison.
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

  it('RealHandlerSubjectsDeclareTheCarriersTheShippedEnvelopeActuallyStamps', async () => {
    // The real subjects share ONE carrier list, so it is a statement about the
    // shipped envelope rather than a per-failure escape hatch — and every
    // carrier the oracle honored on a real handler really did hold its shape.
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

// ─── The emission axis on the LIVE path ──────────────────────────────────────
//
// The oracle mints an emission recorder per invocation and injects it on the
// observation context, but `compositeHandlerAdapter` is the boundary every real
// subject is reached through. Until the adapter carried the recorder across
// that boundary, it was injected and then dropped, and every real subject's
// emission axis reported `not-observed` for a reason that was an artifact of
// the harness rather than a fact about the handler.
//
// The pair below is the same construction the authorization case uses: a real
// action registered through the registry's own validator, bound by the real
// binding-table constructor, invoked through the adapter and the real dispatch
// scope. Only the handler body differs — one records its append where it
// commits, the other declares the append and never makes it — so the verdict
// is the HANDLER's and the two are indistinguishable to anything reading the
// declaration.

describe('the emission axis reaches a verdict on a live subject', () => {
  it('OracleEmission_LiveSubject_ProducesADeterminateVerdict', async () => {
    const appending = realRegistryEmissionCase('appending', stateDir, makeRealContext);
    const silent = realRegistryEmissionCase('silent', stateDir, makeRealContext);

    // The subject under observation is reached through a REAL, non-serializable
    // implementation binding — not a hand-built observation object.
    expect(appending.binding.tool).toBe(REAL_REGISTRY_EMISSION_TOOL);
    expect(typeof appending.binding.load).toBe('function');
    expect(appending.subject.declaration.actionId).toBe(
      `${REAL_REGISTRY_EMISSION_TOOL}.${REAL_REGISTRY_EMISSION_ACTION}`,
    );
    expect(appending.subject.declaration.declaredEmissions).toEqual([
      REAL_REGISTRY_EMISSION_EVENT,
    ]);

    // The recorder the seam minted really crossed the adapter: the observation
    // carries the append the handler itself recorded, evidence and all. Read
    // off `performedEmissions`, which is populated from the recorder — not from
    // the declaration, which would make the whole axis tautological.
    const obs = await observeBehavior(appending.subject);
    expect(obs.performedEmissions.map((e) => e.eventType)).toEqual([
      REAL_REGISTRY_EMISSION_EVENT,
    ]);
    expect(obs.performedEmissions[0]?.evidence).toContain(REAL_REGISTRY_EMISSION_ACTION);

    // DETERMINATE: `pass`, not the `not-observed` a live subject reports when
    // the axis is structurally unable to look.
    const appendingReport = await runOracle(appending.subject);
    expect(appendingReport.emissionVerdict.status, summarizeReport(appendingReport)).toBe('pass');
    expect(appendingReport.emissionVerdict.status).not.toBe('not-observed');
    expect(appendingReport.ok, summarizeReport(appendingReport)).toBe(true);

    // Determinate in the other direction too, which is what makes the `pass`
    // above discriminating rather than a default: the twin that declares the
    // same emission and never records it is caught.
    const silentReport = await runOracle(silent.subject);
    expect(silentReport.emissionVerdict.status, summarizeReport(silentReport)).toBe('fail');
    expect(silentReport.emissionVerdict.diagnostic).toContain(REAL_REGISTRY_EMISSION_EVENT);
    expect(silentReport.ok, summarizeReport(silentReport)).toBe(false);

    // Per-axis isolation: the emission axis is the only thing that moved, so
    // the probe is not reddening a neighbouring axis for a fixture-only reason.
    expect(silentReport.verdicts.filter((v) => v.status === 'fail')).toEqual([]);

    // Independence, on a REAL registration: the two declarations are
    // byte-identical, so no generated artifact — and no
    // declaration-to-declaration drift guard — can tell the appending handler
    // from the silent one. Only the behavioral observation can.
    expect(
      serializeGeneratedDescriptor(deriveGeneratedDescriptor(silent.subject.declaration)),
    ).toBe(
      serializeGeneratedDescriptor(deriveGeneratedDescriptor(appending.subject.declaration)),
    );
  }, 60_000);
});
