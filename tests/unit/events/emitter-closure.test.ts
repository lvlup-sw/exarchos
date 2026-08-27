// @oracle-sources: ../../../src/events/append-site-census.ts, ../../../src/events/registration-validate.ts
// Two INDEPENDENT authorities: the census supplies the appends measured from the
// tree, registration-validate supplies the declared action edges. `module-emissions`
// is deliberately absent — it is reachable from registration-validate, so naming it
// would add a derived authority rather than a second opinion.
/**
 * Emitter closure: every append in the tree is explained, and every explanation
 * is live.
 *
 * The undeclared baseline is a MEASUREMENT, not a suppression list. The audit
 * reports every row on every run; this file pins today's shape so the set cannot
 * grow unnoticed and shrinks visibly as emitters are declared.
 *
 * It has now shrunk twice. First from 33 to 29, when `launch.executed` and
 * `stack.position-filled` got an action that declares them. Then from 29 to 14,
 * when the fifteen action-owned appends below were traced to the action whose
 * handler chain reaches them — three of which had positively reasoned that they
 * emitted nothing.
 *
 * What remains is the residue that is NOT an action's effect: the store and the
 * projections writing their own records, the dispatch protocol, a fixture
 * module, and two resolver caches.
 *
 * The phantom arm carries no baseline at all, deliberately. A stale row in the
 * non-action surface is never acceptable, so there is nothing to grandfather —
 * it fails the moment an append it names stops existing.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { scanAppendSites, type AppendSiteCensus } from '../../../src/events/append-site-census.js';
import {
  ACTION_APPEND_OWNERSHIP,
  auditActionOwnedAppends,
  auditEmitterClosure,
  reasonedAbstentions,
} from '../../../src/events/emitter-closure-audit.js';
import { MODULE_EMISSIONS } from '../../../src/events/module-emissions.js';
import { declaredEmissionEdges } from '../../../src/events/registration-validate.js';
import { EVIDENCE_DISCRIMINANT_CONSTANTS } from '../../../src/verbs/gates/gate-ownership-census.js';
import { scanEvidenceEmission } from '../../../tools/test-helpers/evidence-emission-scanner.js';

const SOURCE_ROOT = join(process.cwd(), 'src');

/**
 * Appends nothing declares yet, `event <- module`.
 *
 * SHRINK-ONLY. An entry leaves when the append is declared — on an action's
 * `autoEmits` if it is that action's effect, or in `MODULE_EMISSIONS` if a
 * wrapper, hook or interceptor performs it. Adding one is a deliberate act that
 * fails here first.
 *
 * They are not one problem. Most are ordinary handler appends whose action
 * simply never declared them (`verbs/vcs/*`, `verbs/team/*`, `verbs/merge/*`).
 * A few are store-internal or projection-internal (`task-store`, `freshness`,
 * `regression-detector`). Two are the dispatch protocol itself
 * (`elicitation-dispatch`). One — `task.assigned <- events/decide-fixtures.ts` —
 * is worth a second look, because a fixture module appending a product event is
 * either a test seam in the shipped tree or a misfiled helper.
 */
const UNDECLARED_BASELINE: readonly string[] = Object.freeze([
  'command.resolved <- config/test-runtime-resolver.ts',
  'dispatch.preflight <- verbs/team/dispatch-guard.ts',
  'elicitation.declined <- dispatch/elicitation-dispatch.ts',
  'elicitation.fulfilled <- dispatch/elicitation-dispatch.ts',
  'elicitation.requested <- dispatch/elicitation-dispatch.ts',
  'projection.degraded <- projections/freshness.ts',
  'projection.recovered <- projections/freshness.ts',
  'quality.regression <- projections/quality/regression-detector.ts',
  'task.assigned <- events/decide-fixtures.ts',
  'task.created <- projections/task-store/event-sourced-task-store.ts',
  'task.polled <- projections/task-store/event-sourced-task-store.ts',
  'workspace.resolved <- runtime/workspace/discovery.ts',
  'worktree.create.executed <- runtime/launcher/create-worktree.ts',
  'worktree.create.requested <- runtime/launcher/create-worktree.ts',
]);

function censusOf(
  modulesByEvent: Record<string, readonly string[]>,
  scannedModules: readonly string[] = [],
): AppendSiteCensus {
  return {
    modulesByEvent: new Map(Object.entries(modulesByEvent)),
    unresolved: [],
    scannedModules,
    scannedModuleCount: scannedModules.length,
  };
}

describe('emitter closure', () => {
  it('EmitterClosure_LiveTree_MatchesTheUndeclaredBaseline', async () => {
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );
    const closure = auditEmitterClosure(census, declaredEmissionEdges());

    // DENOMINATORS FIRST. An empty finding set from a scan that read nothing is
    // indistinguishable from a clean tree.
    expect(closure.measuredSiteCount, 'no append site was measured').toBeGreaterThan(60);
    expect(closure.explainedByAction, 'no site was explained by an action edge').toBeGreaterThan(25);

    expect(closure.undeclared.map((u) => `${u.event} <- ${u.module}`).sort()).toEqual(
      [...UNDECLARED_BASELINE].sort(),
    );
  }, 120_000);

  it('EmitterClosure_EveryModuleEmission_IsLiveInTheTree', async () => {
    // The no-stale-cover ratchet, and it carries NO exemption list. A row whose
    // append has gone reads as coverage while covering nothing, so the only
    // acceptable count is zero.
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );
    const closure = auditEmitterClosure(census, declaredEmissionEdges());

    expect(MODULE_EMISSIONS.length, 'the non-action surface is empty').toBeGreaterThan(0);
    expect(closure.phantoms, 'a declared module emitter no longer appends').toEqual([]);
    expect(
      closure.unverifiable,
      'a declared module emitter sits outside the scanned tree',
    ).toEqual([]);
    expect(closure.explainedByModule).toBe(MODULE_EMISSIONS.length);
  }, 120_000);

  it('EmitterClosure_ActionOwnedAppends_HaveRegistryEdges', async () => {
    // The attribution arm over the LIVE tree. Every append an action answers for
    // is measured in the module that performs it AND declared by that action.
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );
    const audit = auditActionOwnedAppends(census, declaredEmissionEdges());

    // DENOMINATORS FIRST, on both joined populations. An emptied ownership table
    // and an emptied abstention population each produce a clean verdict over
    // nothing.
    expect(ACTION_APPEND_OWNERSHIP.length, 'the ownership table is empty').toBeGreaterThanOrEqual(
      15,
    );
    expect(
      audit.confirmedOwnedAppends,
      'no ownership row was confirmed against the census',
    ).toBe(ACTION_APPEND_OWNERSHIP.length);
    expect(audit.abstainingActions, 'no action declares a reasoned abstention').toBeGreaterThan(50);

    expect(audit.stale, 'an ownership row outlived the append it names').toEqual([]);
    expect(
      audit.unbacked.map((u) => `${u.action} -> ${u.event}`),
      'an action owns an append it declares no edge for',
    ).toEqual([]);
    expect(
      audit.falseAbstentions.map((f) => `${f.action} -> ${f.event}`),
      'an action reasons it emits nothing while a module it reaches appends',
    ).toEqual([]);
  }, 120_000);

  it('EmitterClosure_FalseReasonedAbstention_IsReported', () => {
    // The kill probe for the arm the live test above can only ever pass. Put one
    // of the repaired abstentions back and the arm must NAME the action — an
    // anonymous undeclared row is exactly what this arm exists to replace.
    const census = censusOf(
      { 'dispatch.classified': ['verbs/review/classify-review-items.ts'] },
      ['verbs/review/classify-review-items.ts'],
    );
    const ownership = ACTION_APPEND_OWNERSHIP.filter(
      (row) => row.action === 'classify_review_items',
    );
    expect(ownership, 'the seeded row left the ownership table').toHaveLength(1);

    const audit = auditActionOwnedAppends(
      census,
      [],
      [{ action: 'classify_review_items', because: 'groups ActionItems in memory' }],
      ownership,
    );

    expect(audit.ok).toBe(false);
    expect(audit.confirmedOwnedAppends).toBe(1);
    expect(audit.falseAbstentions).toHaveLength(1);
    expect(audit.falseAbstentions[0]?.action).toBe('classify_review_items');
    expect(audit.falseAbstentions[0]?.event).toBe('dispatch.classified');
    expect(audit.falseAbstentions[0]?.because).toBe('groups ActionItems in memory');
    expect(audit.unbacked, 'a false abstention must not double-report as a bare omission').toEqual(
      [],
    );

    // An action that declared no abstention and no edge is the WEAKER finding,
    // reported under its own code so the two are distinguishable.
    const omitted = auditActionOwnedAppends(census, [], [], ownership);
    expect(omitted.falseAbstentions).toEqual([]);
    expect(omitted.unbacked).toHaveLength(1);
    expect(omitted.unbacked[0]?.action).toBe('classify_review_items');

    // And declaring the edge clears both.
    const repaired = auditActionOwnedAppends(
      census,
      [
        {
          event: 'dispatch.classified',
          action: 'classify_review_items',
          declaringTool: 'exarchos_orchestrate',
        },
      ],
      [{ action: 'classify_review_items', because: 'groups ActionItems in memory' }],
      ownership,
    );
    expect(repaired.ok).toBe(true);
    expect(repaired.confirmedOwnedAppends).toBe(1);
  });

  it('EmitterClosure_OwnershipRowWithNoAppend_IsStale', () => {
    // The no-stale-cover direction for the ownership table itself: the row names
    // a module the census DID scan and found no such append in.
    const audit = auditActionOwnedAppends(
      censusOf({}, ['verbs/review/classify-review-items.ts']),
      [],
      [],
      [
        {
          action: 'classify_review_items',
          module: 'verbs/review/classify-review-items.ts',
          event: 'dispatch.classified',
          wiring: 'seeded',
        },
      ],
    );

    expect(audit.ok).toBe(false);
    expect(audit.confirmedOwnedAppends).toBe(0);
    expect(audit.stale).toHaveLength(1);
    expect(audit.stale[0]?.reason).toBe('append-not-in-module');
    expect(audit.unbacked).toEqual([]);
  });

  it('EmitterClosure_LiveAbstentions_QuoteTheirReason', () => {
    // The abstention population feeds a message that quotes it. A blank reason
    // would make the finding unreadable while the arm still passed.
    const abstentions = reasonedAbstentions();
    expect(abstentions.length).toBeGreaterThan(50);
    expect(abstentions.filter((row) => row.because.trim().length === 0)).toEqual([]);
  });

  it('EmitterClosure_UnclaimedAppend_IsReported', () => {
    // The kill probe for the direction a declaration table can never find on
    // its own: the tree appends something nobody claims.
    const closure = auditEmitterClosure(
      censusOf({ 'seeded.event': ['somewhere/module.ts'] }, ['somewhere/module.ts']),
      [],
      [],
    );

    expect(closure.ok).toBe(false);
    expect(closure.undeclared).toHaveLength(1);
    expect(closure.undeclared[0]?.event).toBe('seeded.event');
    expect(closure.undeclared[0]?.module).toBe('somewhere/module.ts');

    // Declaring it on the non-action surface explains it, and nothing else changed.
    const declared = auditEmitterClosure(
      censusOf({ 'seeded.event': ['somewhere/module.ts'] }, ['somewhere/module.ts']),
      [],
      [
        {
          event: 'seeded.event',
          module: 'somewhere/module.ts',
          trigger: 'dispatch-wrapper',
          rationale: 'seeded',
        },
      ],
    );
    expect(declared.ok).toBe(true);
    expect(declared.explainedByModule).toBe(1);
  });

  it('EmitterClosure_ModuleEmissionWithNoAppend_IsAPhantom', () => {
    // The other direction: the row names a module the census DID scan and
    // found no such append in.
    const closure = auditEmitterClosure(censusOf({}, ['scanned/module.ts']), [], [
      {
        event: 'seeded.event',
        module: 'scanned/module.ts',
        trigger: 'process-hook',
        rationale: 'seeded',
      },
    ]);

    expect(closure.ok).toBe(false);
    expect(closure.phantoms).toHaveLength(1);
    expect(closure.phantoms[0]?.module).toBe('scanned/module.ts');
    expect(closure.unverifiable).toEqual([]);
  });

  it('EmitterClosure_ModuleOutsideTheScanRoot_IsUnverifiableNotPhantom', () => {
    // A row the census never looked at is unanswered, not refuted. Reporting it
    // as a phantom would blame a declaration for the scan's own boundary.
    const closure = auditEmitterClosure(censusOf({}, ['scanned/module.ts']), [], [
      {
        event: 'seeded.event',
        module: 'elsewhere/harness.ts',
        trigger: 'process-hook',
        rationale: 'seeded',
      },
    ]);

    expect(closure.phantoms).toEqual([]);
    expect(closure.unverifiable).toEqual([
      { event: 'seeded.event', module: 'elsewhere/harness.ts', reason: 'outside-scan-root' },
    ]);
  });
});
