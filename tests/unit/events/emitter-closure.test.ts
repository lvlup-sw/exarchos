// @oracle-sources: ../../../src/events/append-site-census.ts, ../../../src/events/registration-validate.ts
// Two INDEPENDENT authorities: the census supplies the appends measured from the
// tree, registration-validate supplies the declared action edges. `module-emissions`
// is deliberately absent — it is reachable from registration-validate, so naming it
// would add a derived authority rather than a second opinion.
/**
 * Emitter closure: every append in the tree is explained, and every explanation
 * is live.
 *
 * Two arms measure the tree against two declared populations and pin what
 * they find:
 *
 * - The undeclared arm holds at zero. Every append site is explained by
 *   either an action edge (`registration-validate`) or the non-action surface
 *   (`MODULE_EMISSIONS`) — there is no third bucket. A zero baseline is the
 *   most fragile assertion this file makes: `toEqual([])` passes just as
 *   happily over a census that read nothing, so the denominators (measured
 *   site count, action-explained count, module-explained count) are asserted
 *   first and are not decoration.
 * - The unresolved arm holds a pinned, non-empty, shrink-only baseline: sites
 *   whose `.append()` discriminant is a runtime value the parser cannot
 *   reduce to a string. These cannot mechanically resolve today, so an empty
 *   set here would be dishonest rather than clean. It shrinks only when a
 *   site becomes resolvable, and a new unresolved site fails the comparison
 *   the moment it appears.
 *
 * The module-emission arm below (`EmitterClosure_EveryModuleEmission_IsLiveInTheTree`)
 * carries no baseline at all, deliberately. A stale row in the non-action
 * surface is never acceptable, so there is nothing to grandfather — it fails
 * the moment an append it names stops existing.
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
import {
  MODULE_EMISSIONS,
  type ModuleEmission,
} from '../../../src/events/module-emissions.js';
import { declaredEmissionEdges } from '../../../src/events/registration-validate.js';
import { EVIDENCE_DISCRIMINANT_CONSTANTS } from '../../../src/verbs/gates/gate-ownership-census.js';
import { scanEvidenceEmission } from '../../../tools/test-helpers/evidence-emission-scanner.js';

const SOURCE_ROOT = join(process.cwd(), 'src');

/**
 * Append sites whose discriminant does not reduce to a string, `module:line`.
 *
 * SHRINK-ONLY. An entry leaves when its site is rewritten so the parser can
 * read the discriminant as a string literal or a known constant. Adding one
 * is a deliberate act that fails here first.
 */
const UNRESOLVED_BASELINE: readonly string[] = Object.freeze([
  'dispatch/core/onboarding/event-ctx.ts:49',
  'events/store.ts:406',
  'events/store.ts:530',
  'events/tools.ts:493',
  'projections/task-store/event-sourced-task-store.ts:817',
  'storage/sidecar-merger.ts:126',
  'storage/sidecar-scheduler.ts:203',
  'vcs/mutation-owner.ts:457',
  'vcs/mutation-owner.ts:589',
  'verbs/gates/mutation-adequacy.ts:1447',
  'verbs/team/prepare-delegation.ts:883',
  'verbs/worktree/manager.ts:1385',
  'verbs/worktree/merge-serializer.ts:204',
  'workflow/cancel.ts:300',
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
  it('EmitterClosure_LiveTree_HasNoUndeclaredAppends', async () => {
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );
    const closure = auditEmitterClosure(census, declaredEmissionEdges());

    // DENOMINATORS FIRST. An empty finding set from a scan that read nothing is
    // indistinguishable from a clean tree.
    expect(closure.measuredSiteCount, 'no append site was measured').toBeGreaterThan(75);
    expect(closure.explainedByAction, 'no site was explained by an action edge').toBeGreaterThan(50);
    // The classification arm carries the work now that the undeclared set is
    // empty. Without this floor an emptied MODULE_EMISSIONS would read as a
    // clean tree.
    expect(
      closure.explainedByModule,
      'no site was explained by the non-action surface',
    ).toBeGreaterThan(15);

    expect(closure.undeclared, 'an append site is undeclared').toEqual([]);

    // The unresolved arm: its own denominator first, then the pinned set.
    expect(census.scannedModuleCount, 'no module was scanned').toBeGreaterThan(600);
    expect(
      census.unresolved.map((u) => `${u.module}:${u.line}`).sort(),
      'the unresolved append census drifted from its pinned, shrink-only baseline',
    ).toEqual([...UNRESOLVED_BASELINE].sort());
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

  it('EmitterClosure_DuplicatedModuleEmission_BreaksTheRowToSiteCount', () => {
    // `explainedByModule === MODULE_EMISSIONS.length` is the only thing standing
    // between the surface and a row that explains nothing. It catches this case
    // incidentally, which is another way of saying nobody would notice if it
    // stopped: the arithmetic is one site per row, so two rows for one site
    // leaves the count one short while every other arm reports clean.
    const rows: readonly ModuleEmission[] = [
      {
        event: 'seeded.event',
        module: 'scanned/module.ts',
        trigger: 'process-hook',
        rationale: 'seeded',
      },
      {
        event: 'seeded.event',
        module: 'scanned/module.ts',
        trigger: 'store-internal',
        rationale: 'seeded twice',
      },
    ];
    const closure = auditEmitterClosure(
      censusOf({ 'seeded.event': ['scanned/module.ts'] }, ['scanned/module.ts']),
      [],
      rows,
    );

    // Everything that reports a NAMED fault stays silent — this is the point.
    expect(closure.ok).toBe(true);
    expect(closure.undeclared).toEqual([]);
    expect(closure.phantoms).toEqual([]);
    expect(closure.unverifiable).toEqual([]);

    // The count is what disagrees.
    expect(closure.explainedByModule).toBe(1);
    expect(closure.explainedByModule).not.toBe(rows.length);
  });

  it('EmitterClosure_ModuleRowShadowingAnActionEdge_ExplainsNothing', () => {
    // The other way a row can be dead cover: an action already declares the
    // event, so the action arm claims the site first and the row explains no
    // site at all. It is not a phantom — the append IS there — so only the
    // row-to-site count can see it.
    const rows: readonly ModuleEmission[] = [
      {
        event: 'seeded.event',
        module: 'scanned/module.ts',
        trigger: 'read-path-publisher',
        rationale: 'seeded',
      },
    ];
    const closure = auditEmitterClosure(
      censusOf({ 'seeded.event': ['scanned/module.ts'] }, ['scanned/module.ts']),
      [{ event: 'seeded.event', action: 'seeded_action', declaringTool: 'exarchos_orchestrate' }],
      rows,
    );

    expect(closure.ok).toBe(true);
    expect(closure.phantoms).toEqual([]);
    expect(closure.explainedByAction).toBe(1);
    expect(closure.explainedByModule).toBe(0);
    expect(closure.explainedByModule).not.toBe(rows.length);
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
