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
// ── WHY THE EMISSION AXIS IS NOT IN `ORACLE_AXES`, AND WHAT COVERS IT ───────
//
// The emission axis is reported on `OracleReport.emissionVerdict` rather than
// as a sixth member of the closed `ORACLE_AXES` union, so `axisCoverage()` —
// which ranges over that union — does not produce a row for it. It IS
// selectable, through the broader `ALL_AXES` tuple that `RunOracleOptions.axes`
// draws from — `ORACLE_AXES` stays five-membered because `seededBreak` and the
// per-axis `it.each` tests below are keyed on exactly those five. That is still
// the exact shape of an axis going quietly uncovered by the closed union's own
// census, so it is answered here rather than left implicit.
//
// Two things cover it, and both are stronger than a census row would be:
//
//   1. `emissionAxisCoverage()` in the fixtures module IS the missing row, and
//   2. `checkEmissionAxisObserved()` gives that row a TOOTH — the axis
//      observing nothing across a run is itself a failure. No member of
//      `ORACLE_AXES` has that: three of the five sit at `observed: 0` across
//      the whole live surface and the suite still reports `ok`.
//
// `OracleReport.emissionVerdict` is `undefined` on a report where the axis was
// not selected — never a synthesized or stale verdict — and
// `emissionAxisCoverage()`/`checkEmissionAxisObserved()` narrow to only the
// reports where it ran via the `emissionWasSelected` type guard, so a
// standard-only run cannot enter the emission census by accident.
//
// @oracle-sources: ../../../../src/registry.ts, the values the shipped handlers actually return when invoked through the real implementation-binding table, the durable appends the event store confirms through its own async-scoped observation seam
// ────────────────────────────────────────────────────────────────────────────

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

// ─── One emission vocabulary across four surfaces ────────────────────────────
//
// The registry's per-action `actionContract.emissions` is the authority. The
// compiler's `EvidencePolicy.autoEmits`, the dispatch verifier's required set
// and the oracle's `declaredEmissions` are three projections of it, each
// reached by its own code path. The claim is that every projection is faithful
// to the authority IN ITS OWN ROLE — the compiler and the oracle carry both
// halves of `{event, condition}`, the verifier keeps only the `always` half —
// so a projection that drops `condition`, or that promotes a conditional edge
// into a required one, shows up here rather than downstream as a handler
// failing for taking a branch its contract permits.

describe('the emission vocabulary is shared by the registry, compiler, verifier and oracle', () => {
  const pair = (e: { readonly event: string; readonly condition: string }): string =>
    `${e.event}/${e.condition}`;

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

      // The COMPILER carries both halves, for every declared edge.
      expect(new Set(derivePolicy(action).evidence.autoEmits.map(pair)), actionId).toEqual(
        authorityPairs,
      );

      // The VERIFIER keeps exactly the `always` half — that set, and nothing
      // wider, is what a missing append is judged against at dispatch.
      expect(
        [
          ...unconditionalEmissions(verifierDeclaredEmissions(projectActionContract(action))),
        ].sort(),
        actionId,
      ).toEqual(alwaysEvents);

      // The ORACLE carries both halves too, so its axis can apply the same rule.
      expect(
        new Set(
          (realActionDeclaration(actionId, action).declaredEmissions ?? []).map(pair),
        ),
        actionId,
      ).toEqual(authorityPairs);
    }

    // The denominator, asserted rather than assumed. Agreement over an empty
    // corpus, or over one where every edge carries the same condition, would
    // hold for reasons that have nothing to do with the projections.
    expect(declaring).toBeGreaterThanOrEqual(50);
    expect(withAlways).toBeGreaterThan(0);
    expect(withConditional).toBeGreaterThan(0);
  });

  it('EnvelopeObservationSubjects_WithholdTheEmissionSet', () => {
    const actions = realRegistryActions();
    const subjects = liveOutputSubjects();
    expect(subjects.length).toBe(actions.length);

    let declaredByTheRegistry = 0;
    for (const [index, subject] of subjects.entries()) {
      const entry = actions[index];
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      // What is observed here is `() => envelope`, never the handler, so there
      // is no append to attribute to this subject. The set is withheld and the
      // axis reports `not-observed` — which is not a pass.
      expect(subject.declaration.declaredEmissions, entry.actionId).toBeUndefined();
      if (registryDeclaredEmissions(entry.action).length > 0) declaredByTheRegistry += 1;
    }

    // The withholding is doing real work rather than describing an empty set:
    // most of this corpus declares emissions on its contract.
    expect(declaredByTheRegistry).toBeGreaterThanOrEqual(50);
  });

  it('EmissionAxis_RealHandlerProbes_HaveNoUnconditionalEdgeToObserve', () => {
    // The oracle's recorder stands in for `eventStore.append`, and no shipped
    // handler calls it, so a real subject's appends are invisible to the axis.
    // Admission to `realHandlerSubjects` is read-only + local, and nothing in
    // that set declares an unconditional edge — which is why the axis reports
    // `not-observed` there instead of failing handlers it cannot watch. Pinned
    // so a future action landing in that set names this constraint rather than
    // reddening the real-handler suite for an unexplained reason.
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
// The evidence behind an emission verdict used to be a stand-in: the oracle put
// a recorder in scope and a fixture handler called it where a real one would
// call `eventStore.append`. Nothing shipped ever calls that recorder, so the one
// subject the axis could reach a verdict on was a fixture, and the verdict rested
// on a fixture's promise rather than on an append.
//
// It now comes from the EVENT STORE. `compositeHandlerAdapter` installs the
// events layer's async-scoped append observer around the invocation, so the axis
// reads what the store confirmed durable — past every rejection branch and past
// the idempotency cache-hit return.
//
// The positive claim below is therefore a SHIPPED emitter out of the probe
// corpus, dispatched through its real binding into an isolated store. The
// negative control is a fixture handler carrying that same shipped action's
// declaration and appending nothing — a fixture is legitimate on that side,
// because it is what proves the `pass` discriminates rather than defaults.

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

describe('the emission axis reaches a verdict on a live subject', () => {
  it('OracleEmission_ShippedAppender_ProducesPassFromObservedStoreAppend', async () => {
    // Two directories, because the store is idempotent: a second observation of
    // the same input against the same store collapses onto the first write, and
    // a collapse is deliberately NOT reported as an append. Each observation
    // therefore gets a store that has never seen this probe.
    const evidenceDir = makeTempDir('oracle-shipped-appender-evidence-');
    const verdictDir = makeTempDir('oracle-shipped-appender-verdict-');
    try {
      const probe = corpusProbe(SHIPPED_APPENDER);
      const shipped = await shippedEmitterCase(probe, 'appending', evidenceDir, makeRealContext);

      // The subject is a REGISTERED action reached through the shipped binding
      // table — not a fixture registration standing in for one.
      expect(shipped.actionId).toBe(SHIPPED_APPENDER);
      expect(realRegistryActions().map((e) => e.actionId)).toContain(shipped.actionId);
      expect(BINDING_TABLE.map((b) => b.tool)).toContain(shipped.binding.tool);

      // The declaration is the action's contract, read through the same
      // projection the registry itself exposes — no hand-copied edge list.
      expect(shipped.subject.declaration.declaredEmissions).toEqual(
        registryDeclaredEmissions(shipped.action),
      );
      const required = unconditionalEvents(shipped.action);
      expect(required.length, `${SHIPPED_APPENDER} declares no unconditional edge`).toBeGreaterThan(
        0,
      );

      // The evidence is the STORE's: every observed emission carries the stream
      // and sequence the store assigned when it confirmed the write durable.
      const obs = await observeBehavior(shipped.subject);
      expect(obs.performedEmissions.map((e) => e.eventType)).toEqual(
        expect.arrayContaining([...required]),
      );
      for (const emission of obs.performedEmissions) {
        expect(emission.evidence).toMatch(/^store append: .+#\d+$/);
      }
      // …and it landed in the isolated directory, so the append that produced
      // the verdict and the file it persisted to are the same isolation.
      expect(
        fs.readdirSync(evidenceDir).some((entry) => /\.db(-wal|-shm)?$/.test(entry)),
        `${SHIPPED_APPENDER} appended without materialising a store in ${evidenceDir}`,
      ).toBe(true);

      // DETERMINATE: `pass`, not the `not-observed` every subject reported while
      // the axis had no channel onto a shipped handler's appends.
      const fresh = await shippedEmitterCase(probe, 'appending', verdictDir, makeRealContext);
      const report = await runOracle(fresh.subject);
      expect(report.emissionVerdict.status, summarizeReport(report)).toBe('pass');
    } finally {
      rmrf(evidenceDir);
      rmrf(verdictDir);
    }
  }, 120_000);

  it('OracleEmission_SilentTwinWithSameDeclaration_ProducesFail', async () => {
    const probe = corpusProbe(SHIPPED_APPENDER);
    const appendingDir = makeTempDir('oracle-silent-twin-appending-');
    const evidenceDir = makeTempDir('oracle-silent-twin-evidence-');
    const verdictDir = makeTempDir('oracle-silent-twin-verdict-');
    try {
      const appending = await shippedEmitterCase(probe, 'appending', appendingDir, makeRealContext);
      const silent = await shippedEmitterCase(probe, 'silent', evidenceDir, makeRealContext);

      // Same declaration, both sides, and it is the SHIPPED action's: the twin
      // cannot drift onto an easier contract, because neither side authors one.
      expect(silent.action).toBe(appending.action);
      expect(silent.subject.declaration.declaredEmissions).toEqual(
        registryDeclaredEmissions(appending.action),
      );
      expect(
        serializeGeneratedDescriptor(deriveGeneratedDescriptor(silent.subject.declaration)),
      ).toBe(
        serializeGeneratedDescriptor(deriveGeneratedDescriptor(appending.subject.declaration)),
      );

      // The twin is the one thing that differs: a different bound handler.
      expect(silent.binding.load).not.toBe(appending.binding.load);

      // It appended nothing — the store confirmed no write during its probe.
      const obs = await observeBehavior(silent.subject);
      expect(obs.performedEmissions).toEqual([]);

      // The verdict is taken against a store this probe has never touched, so
      // the silence is the handler's and not an idempotency collapse onto an
      // earlier observation's write.
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

  it('OracleEmission_ZeroObservedSubjects_FailsForThisAxisOnly', async () => {
    // Nothing in the registry can declare an emission yet, so the whole live
    // envelope surface leaves the emission axis without a single verdict.
    const vacuous = await runEmissionOracleSuite(liveOutputSubjects());
    expect(vacuous.suite.reports.length).toBeGreaterThanOrEqual(100);
    expect(vacuous.coverage.observed).toBe(0);
    expect(vacuous.coverage.notObserved).toBe(vacuous.suite.reports.length);

    // ── HALF ONE: zero observed subjects is a FAILURE for the emission axis.
    //    Membership in `ORACLE_AXES` would not have bought this — a census row
    //    at `observed: 0` fails nothing, as the three axes below demonstrate.
    expect(vacuous.vacuity.status).toBe('fail');
    expect(vacuous.vacuity.axis).toBe(EMISSION_AXIS);
    expect(vacuous.vacuity.diagnostic).toContain('observed NOTHING');
    expect(vacuous.ok).toBe(false);

    // ── HALF TWO: and it reddens NOTHING else. The three axes that are all
    //    not-observed across this same run are exactly as green as before —
    //    the underlying suite still reports `ok` with no failing verdict, and
    //    their census rows still read `observed: 0` without that being a fault.
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

    // The tooth names one axis, and it is not one of the five the closed union
    // covers — which is the whole reason it can fire without touching them.
    const unionAxes: readonly string[] = ORACLE_AXES;
    expect(unionAxes).not.toContain(vacuous.vacuity.axis);

    // ── And it is satisfiable, not a standing red: ONE live subject whose
    //    emission axis is determinate keeps the run non-vacuous while every
    //    other subject still reports `not-observed`. That subject is a SHIPPED
    //    emitter, so what lifts the vacuity is a real durable append.
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

  it('RunEmissionOracleSuite_ZeroObserved_FailsDistinctly', async () => {
    // Every subject HAD the emission axis selected (the default `runOracleSuite`
    // call `runEmissionOracleSuite` makes selects `ALL_AXES`), yet none of them
    // reaches a determinate verdict — the "selected but silent" shape.
    const subjects = liveOutputSubjects();
    const vacuous = await runEmissionOracleSuite(subjects);
    expect(vacuous.vacuity.status).toBe('fail');
    expect(vacuous.vacuity.diagnostic).toContain('observed NOTHING');
    expect(vacuous.vacuity.diagnostic).not.toContain('never asked to look');
  });

  it('CheckEmissionAxisObserved_ZeroSelectedSubjects_FailsDistinctly', async () => {
    // A run that selects only the standard axes never asks the emission axis
    // to look at all — every report's `emissionVerdict` is `undefined`. This is
    // a DIFFERENT defect from "selected but observed nothing", and must carry a
    // distinct diagnostic so a caller can tell which repair is needed.
    const subjects = [correctBaselineSubject()];
    const standardOnly = await runOracleSuite(subjects, { axes: ORACLE_AXES });
    expect(standardOnly.reports.every((r) => r.emissionVerdict === undefined)).toBe(true);

    const zeroSelected = checkEmissionAxisObserved(standardOnly.reports);
    expect(zeroSelected.status).toBe('fail');
    expect(zeroSelected.diagnostic).toContain('never asked to look');
    expect(zeroSelected.diagnostic).not.toContain('observed NOTHING');

    // The degenerate case (no reports at all) fails with the same message —
    // "zero of zero" is still zero subjects that had the axis selected.
    const noReports = checkEmissionAxisObserved([]);
    expect(noReports.status).toBe('fail');
    expect(noReports.diagnostic).toContain('never asked to look');

    // And it is a genuinely distinct kill from the all-not-observed branch:
    // an emission-selected run that reaches no verdict fails with the OTHER
    // message.
    const emissionSelected = await runOracleSuite(subjects, { axes: [EMISSION_AXIS] });
    const allNotObserved = checkEmissionAxisObserved(emissionSelected.reports);
    expect(allNotObserved.status).toBe('fail');
    expect(allNotObserved.diagnostic).toContain('observed NOTHING');
    expect(allNotObserved.diagnostic).not.toBe(zeroSelected.diagnostic);
  });
});

// ─── The shipped-emitter probe corpus ────────────────────────────────────────
//
// The emission axis had exactly one subject it could reach a verdict on, and
// that subject was a FIXTURE action. Every shipped emitter was outside the
// probed population by construction: `realHandlerSubjects` admits only
// `readOnly` actions, and appending an event is a mutation.
//
// The corpus is the emitting population's own admission rule — a mutating
// action is admitted when its mutation is confined to a caller-owned temporary
// state directory. These three tests hold it to that:
//
//   1. every member is schema-valid, runs to completion offline, and writes
//      inside its own temp dir and nowhere else;
//   2. the determinate-capable count is pinned to a floor that a shrinking
//      corpus trips; and
//   3. the probed and excluded sets PARTITION the declared-emission
//      population, so a newly-declared emission cannot join it unclassified.

describe('the shipped-emitter probe corpus', () => {
  /** `success` off an envelope, without asserting the envelope's whole shape. */
  function envelopeSuccess(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || !('success' in value)) return undefined;
    const { success } = value;
    return success;
  }

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

      // Local and offline are the REGISTRY's own words, so a member that starts
      // reaching outside the machine trips this rather than the containment
      // check downstream.
      expect(action.annotations.openWorld, probe.actionId).toBe(false);

      // Schema-valid: the probe input and every prerequisite are validated
      // against the declared schema they will actually be dispatched through.
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

      // Isolated: a fresh temp dir per probe, never a fixed path — two runs on
      // the same machine must not be able to meet in one directory.
      const probeDir = makeTempDir('oracle-emission-probe-');
      expect(probeDir.startsWith(os.tmpdir()), probeDir).toBe(true);

      expect(usedDirs.has(probeDir)).toBe(false);
      usedDirs.add(probeDir);
      try {
        const run = await runEmissionProbe(probe, probeDir, makeRealContext);
        // It ran to completion and returned a runtime envelope — a member that
        // throws is not a probe, it is an unhandled path.
        expect(typeof envelopeSuccess(run.result), `${probe.actionId}: ${String(run.result)}`).toBe(
          'boolean',
        );
        // A probe that appended durably must have a store in its OWN directory:
        // the append and the file it landed in have to be the same isolation.
        // Probes that append nothing legitimately leave no store behind.
        if (run.appended.length > 0) {
          observedAppends += 1;
          expect(fs.readdirSync(probeDir).some(dbLike), probe.actionId).toBe(true);
        }
      } finally {
        rmrf(probeDir);
      }
      expect(fs.existsSync(probeDir), `${probe.actionId} left its temp dir behind`).toBe(false);
    }

    // The containment claim needs a denominator: a corpus in which nothing ever
    // appended would satisfy every check below by never writing at all.
    expect(observedAppends).toBeGreaterThan(0);

    // Containment: a probe that ran against the ambient state dir instead of
    // its own would materialise an event store in the repository. Checked after
    // the whole corpus, so ANY member escaping is caught.
    expect(
      fs.readdirSync(repoStateDir).filter(dbLike),
      'a probe wrote an event store into the repository state dir',
    ).toEqual([]);
    expect(
      fs.readdirSync(repoRoot).filter(dbLike),
      'a probe wrote an event store into the repository root',
    ).toEqual([]);
  }, 300_000);

  it('EmissionProbeCorpus_ZeroEntries_FailsTheFloor', () => {
    const corpus = emissionProbeCorpus();
    const verdict = checkEmissionProbeFloor(corpus);

    // The measured floor, and the members it counts are read from the REGISTRY
    // declaration rather than from the corpus literal.
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

    // The kill: an emptied corpus fails the same check, and says why. Without
    // this the floor would be an assertion no state of the world falsifies.
    const emptied = checkEmissionProbeFloor({ ...corpus, probes: [] });
    expect(emptied.ok).toBe(false);
    expect(emptied.determinate).toEqual([]);
    expect(emptied.diagnostic).toContain('below the floor');

    // And it is not a blanket refusal: a corpus holding only conditional-edge
    // members is equally short, which is what makes the count mean something.
    const conditionalOnly = corpus.probes.filter(
      (probe) => !verdict.determinate.includes(probe.actionId),
    );
    expect(conditionalOnly.length).toBeGreaterThan(0);
    expect(checkEmissionProbeFloor({ ...corpus, probes: conditionalOnly }).ok).toBe(false);
  });

  it('EmissionProbeCorpus_ExcludedActions_ReportReasons', () => {
    const corpus = emissionProbeCorpus();

    // The denominator, measured rather than assumed.
    expect(corpus.declaredEmitters.length).toBeGreaterThanOrEqual(50);
    expect(new Set(corpus.declaredEmitters).size).toBe(corpus.declaredEmitters.length);

    // The two sets PARTITION the population: every declared emitter is probed
    // or excluded, nothing is both, and no exclusion names an action that has
    // stopped declaring an emission.
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

    // Every exclusion carries a REASON — the point of reporting them at all.
    for (const entry of corpus.excluded) {
      expect(entry.reason.trim().length, entry.actionId).toBeGreaterThan(0);
    }

    // The `openWorld` exclusions are derived from the annotation, so they name
    // exactly the emitters the registry itself says leave the local system.
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

    // The corpus is a MODEST subset, and says so rather than implying it covers
    // the population: most declared emitters are excluded, with a reason each.
    expect(corpus.excluded.length).toBeGreaterThan(corpus.probes.length);
  });
});
