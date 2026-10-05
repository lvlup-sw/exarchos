// @oracle-sources: ../../../src/events/append-site-census.ts, ../../../src/events/registration-validate.ts
// The two sources are independent. The census measures the appends in the tree, and
// `registration-validate` supplies the declared action edges. `module-emissions` is reachable
// from `registration-validate`, so it is a derived authority and not a second source.
//
// Emitter closure: an action edge or a `MODULE_EMISSIONS` row explains each append in the
// tree, and each explanation is live.
// - The undeclared arm holds at zero. `toEqual([])` also passes over a census that read
//   nothing, so each live test asserts its denominators first.
// - The unresolved arm pins the sites whose `.append()` discriminant the parser cannot reduce
//   to a string. That baseline only shrinks.
// - The module-emission arm has no baseline. A stale row fails immediately.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { scanAppendSites, type AppendSiteCensus } from '../../../src/events/append-site-census.js';
import {
  ACTION_APPEND_OWNERSHIP,
  UNRESOLVED_ACTION_EVENT_ALLOWANCE,
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
import { EnvelopeSchema } from '../../../src/contract/schemas/envelope.js';
import { none, type ActionContract } from '../../../src/registry/action-contract.js';
import type { ActionAnnotations, CompositeTool } from '../../../src/registry.js';
import { z } from 'zod';

const SOURCE_ROOT = join(process.cwd(), 'src');

/**
 * The count of unresolved append sites for each module. The parser cannot reduce the
 * discriminant of an unresolved site to a string. The key is the module and not `module:line`,
 * because an unrelated edit earlier in the file moves a line number.
 *
 * The baseline only shrinks. A count decreases when a rewrite makes a discriminant a string
 * literal or a known constant. A new unresolved site fails as a larger count or a new key.
 */
const UNRESOLVED_BASELINE: Readonly<Record<string, number>> = Object.freeze({
  'dispatch/core/onboarding/event-ctx.ts': 1,
  'events/store.ts': 2,
  'events/tools.ts': 1,
  'projections/task-store/event-sourced-task-store.ts': 1,
  'storage/sidecar-merger.ts': 1,
  'storage/sidecar-scheduler.ts': 1,
  'vcs/mutation-owner.ts': 2,
  'verbs/gates/mutation-adequacy.ts': 1,
  'verbs/team/prepare-delegation.ts': 1,
  'verbs/worktree/manager.ts': 1,
  'verbs/worktree/merge-serializer.ts': 1,
  'workflow/cancel.ts': 1,
});

/** Counts the unresolved append sites for each module in the live census. */
function unresolvedCountsByModule(
  unresolved: readonly { readonly module: string; readonly line: number }[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const site of unresolved) {
    counts[site.module] = (counts[site.module] ?? 0) + 1;
  }
  return Object.freeze(counts);
}

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

/**
 * A composite tool with one action, which declares a `none` emission with the reason `because`.
 * The fixtures prove that `reasonedAbstentions` and `auditActionOwnedAppends` key on the
 * qualified `tool.action`. A custom registry can hold one action name on two tools.
 */
function abstainingTool(toolName: string, actionName: string, because: string): CompositeTool {
  const contract: ActionContract = {
    requires: none('fixture declares no precondition'),
    ensures: none('fixture declares no postcondition'),
    needs: none('fixture declares no capabilities'),
    touches: { frame: 'single-machine', resources: none('fixture touches no durable resources') },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: none(because),
  };
  const annotations: ActionAnnotations = {
    safety: 'read-only',
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  };
  return {
    name: toolName,
    description: `fixture tool ${toolName}`,
    actions: [
      {
        name: actionName,
        description: `fixture action ${actionName}`,
        schema: z.object({}),
        phases: new Set<string>(),
        roles: new Set<string>(['any']),
        outputSchema: EnvelopeSchema(z.unknown()),
        annotations,
        actionContract: contract,
      },
    ],
  };
}

describe('emitter closure', () => {
  /**
   * The denominators come first, because an empty finding set from a scan that read nothing
   * looks like a clean tree. The floor on `explainedByModule` catches an emptied
   * `MODULE_EMISSIONS`.
   */
  it('EmitterClosure_LiveTree_HasNoUndeclaredAppends', async () => {
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );
    const closure = auditEmitterClosure(census, declaredEmissionEdges());

    expect(closure.measuredSiteCount, 'no append site was measured').toBeGreaterThan(75);
    expect(closure.explainedByAction, 'no site was explained by an action edge').toBeGreaterThan(50);
    expect(
      closure.explainedByModule,
      'no site was explained by the non-action surface',
    ).toBeGreaterThan(15);

    expect(closure.undeclared, 'an append site is undeclared').toEqual([]);

    expect(census.scannedModuleCount, 'no module was scanned').toBeGreaterThan(600);
    expect(
      unresolvedCountsByModule(census.unresolved),
      'the unresolved append census drifted from its pinned, shrink-only per-module baseline',
    ).toEqual(UNRESOLVED_BASELINE);
  }, 120_000);

  /**
   * No exemption list applies. A row whose append is gone reads as coverage and covers nothing,
   * so the only correct count is zero.
   */
  it('EmitterClosure_EveryModuleEmission_IsLiveInTheTree', async () => {
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

  /**
   * Each declared action event must resolve to a measured site or be in the pinned allowance.
   * The undeclared arm starts from measured sites, so it cannot see an event that nothing appends.
   * The audit must count each distinct event of the edges that it receives, and a floor of 50
   * catches a collapsed edge list.
   * The last assertion is a bijection: each allowance row covers exactly one declared, unresolved
   * event.
   */
  it('EmitterClosure_EveryActionEmission_IsLiveOrOnTheAllowance', async () => {
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );
    const edges = declaredEmissionEdges();
    const closure = auditEmitterClosure(census, edges);

    const distinctDeclaredEvents = new Set(edges.map((edge) => edge.event)).size;
    expect(closure.declaredActionEventCount, 'no action event was considered').toBe(
      distinctDeclaredEvents,
    );
    expect(closure.declaredActionEventCount, 'the declared population collapsed').toBeGreaterThan(
      50,
    );
    expect(UNRESOLVED_ACTION_EVENT_ALLOWANCE.length, 'the allowance is empty').toBeGreaterThan(0);

    expect(
      closure.phantomActionEmissions,
      'a declared action emission has no measured append site and no allowance cover',
    ).toEqual([]);
    expect(closure.staleAllowance, 'an allowance row no longer describes the tree').toEqual([]);

    expect(closure.unverifiableActionEmissions.map((row) => row.event)).toEqual(
      [...UNRESOLVED_ACTION_EVENT_ALLOWANCE].sort(),
    );
  }, 120_000);

  /**
   * Kill probe. The audit must name the event and the actions that declare it, and the closure
   * must fail.
   */
  it('EmitterClosure_ActionEmissionWithNoAppend_IsAPhantom', () => {
    const closure = auditEmitterClosure(
      censusOf({}, ['scanned/module.ts']),
      [{ event: 'seeded.event', action: 'seeded_action', declaringTool: 'exarchos_orchestrate' }],
      [],
      [],
    );

    expect(closure.ok).toBe(false);
    expect(closure.declaredActionEventCount).toBe(1);
    expect(closure.phantomActionEmissions).toHaveLength(1);
    expect(closure.phantomActionEmissions[0]?.event).toBe('seeded.event');
    expect(closure.phantomActionEmissions[0]?.declaredBy).toEqual([
      'exarchos_orchestrate.seeded_action',
    ]);
    expect(closure.unverifiableActionEmissions).toEqual([]);
  });

  /**
   * The census cannot read a discriminant that is a runtime value. An event in the allowance is
   * thus unanswered, not refuted.
   */
  it('EmitterClosure_AllowanceCoveredEvent_IsUnverifiableNotPhantom', () => {
    const closure = auditEmitterClosure(
      censusOf({}, ['scanned/module.ts']),
      [{ event: 'seeded.event', action: 'seeded_action', declaringTool: 'exarchos_orchestrate' }],
      [],
      ['seeded.event'],
    );

    expect(closure.ok).toBe(true);
    expect(closure.phantomActionEmissions).toEqual([]);
    expect(closure.unverifiableActionEmissions).toEqual([
      { event: 'seeded.event', reason: 'append-not-resolvable' },
    ]);
  });

  /**
   * When the append of an allowed event becomes resolvable, the allowance row is the fault.
   * A dead row hides the next real phantom.
   */
  it('EmitterClosure_AllowanceRowWhoseAppendResolved_IsStale', () => {
    const closure = auditEmitterClosure(
      censusOf({ 'seeded.event': ['scanned/module.ts'] }, ['scanned/module.ts']),
      [{ event: 'seeded.event', action: 'seeded_action', declaringTool: 'exarchos_orchestrate' }],
      [],
      ['seeded.event'],
    );

    expect(closure.ok).toBe(false);
    expect(closure.staleAllowance).toHaveLength(1);
    expect(closure.staleAllowance[0]?.reason).toBe('append-now-resolved');
    expect(closure.phantomActionEmissions).toEqual([]);
  });

  /** An allowance row for an event that no action declares protects nothing. */
  it('EmitterClosure_AllowanceRowWithNoEdge_IsStale', () => {
    const closure = auditEmitterClosure(censusOf({}, ['scanned/module.ts']), [], [], [
      'seeded.event',
    ]);

    expect(closure.ok).toBe(false);
    expect(closure.staleAllowance).toHaveLength(1);
    expect(closure.staleAllowance[0]?.reason).toBe('no-declaring-edge');
  });

  /**
   * The attribution arm over the live tree. The census must find each owned append in its module,
   * and the owning action must declare it.
   * The denominators come first: an empty ownership table or an empty abstention population gives
   * a clean verdict over nothing.
   */
  it('EmitterClosure_ActionOwnedAppends_HaveRegistryEdges', async () => {
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );
    const audit = auditActionOwnedAppends(census, declaredEmissionEdges());

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

  /**
   * Kill probe for the attribution arm. The audit must name the action, the event and the reason
   * of a seeded false abstention.
   * An action with no abstention and no edge is the weaker finding, and the audit reports it as
   * `unbacked`. A declared edge clears both findings.
   */
  it('EmitterClosure_FalseReasonedAbstention_IsReported', () => {
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
      [
        {
          action: 'classify_review_items',
          declaringTool: 'exarchos_orchestrate',
          because: 'groups ActionItems in memory',
        },
      ],
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

    const omitted = auditActionOwnedAppends(census, [], [], ownership);
    expect(omitted.falseAbstentions).toEqual([]);
    expect(omitted.unbacked).toHaveLength(1);
    expect(omitted.unbacked[0]?.action).toBe('classify_review_items');

    const repaired = auditActionOwnedAppends(
      census,
      [
        {
          event: 'dispatch.classified',
          action: 'classify_review_items',
          declaringTool: 'exarchos_orchestrate',
        },
      ],
      [
        {
          action: 'classify_review_items',
          declaringTool: 'exarchos_orchestrate',
          because: 'groups ActionItems in memory',
        },
      ],
      ownership,
    );
    expect(repaired.ok).toBe(true);
    expect(repaired.confirmedOwnedAppends).toBe(1);
  });

  /** The ownership row names a module that the census scanned, and that module has no such append. */
  it('EmitterClosure_OwnershipRowWithNoAppend_IsStale', () => {
    const audit = auditActionOwnedAppends(
      censusOf({}, ['verbs/review/classify-review-items.ts']),
      [],
      [],
      [
        {
          action: 'classify_review_items',
          declaringTool: 'exarchos_orchestrate',
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

  /** A finding message quotes the abstention reason, so a blank reason makes the finding unreadable. */
  it('EmitterClosure_LiveAbstentions_QuoteTheirReason', () => {
    const abstentions = reasonedAbstentions();
    expect(abstentions.length).toBeGreaterThan(50);
    expect(abstentions.filter((row) => row.because.trim().length === 0)).toEqual([]);
  });

  /**
   * The registry does not make action names unique across tools. With a key on the bare name, one
   * tool can overwrite the reason of another tool or take its finding.
   * Each tool here reaches a different module and event, so a collision on `shared_name` loses a
   * finding or puts a reason on the wrong tool.
   */
  it('EmitterClosure_SameNamedActionsOnDifferentTools_StayDistinct', () => {
    const registry: readonly CompositeTool[] = [
      abstainingTool('tool_a', 'shared_name', 'tool_a reasons no emission'),
      abstainingTool('tool_b', 'shared_name', 'tool_b reasons no emission'),
    ];
    const abstentions = reasonedAbstentions(registry);

    expect(abstentions).toHaveLength(2);
    const reasonByTool = new Map(abstentions.map((row) => [row.declaringTool, row.because]));
    expect(reasonByTool.get('tool_a')).toBe('tool_a reasons no emission');
    expect(reasonByTool.get('tool_b')).toBe('tool_b reasons no emission');

    const ownership = [
      {
        action: 'shared_name',
        declaringTool: 'tool_a',
        module: 'fixtures/tool-a.ts',
        event: 'tool.a.appended',
        wiring: 'seeded',
      },
      {
        action: 'shared_name',
        declaringTool: 'tool_b',
        module: 'fixtures/tool-b.ts',
        event: 'tool.b.appended',
        wiring: 'seeded',
      },
    ];
    const census = censusOf(
      { 'tool.a.appended': ['fixtures/tool-a.ts'], 'tool.b.appended': ['fixtures/tool-b.ts'] },
      ['fixtures/tool-a.ts', 'fixtures/tool-b.ts'],
    );

    const audit = auditActionOwnedAppends(census, [], abstentions, ownership);

    expect(audit.confirmedOwnedAppends).toBe(2);
    expect(audit.falseAbstentions).toHaveLength(2);
    const findingByTool = new Map(audit.falseAbstentions.map((f) => [f.declaringTool, f]));
    expect(findingByTool.get('tool_a')?.because).toBe('tool_a reasons no emission');
    expect(findingByTool.get('tool_a')?.event).toBe('tool.a.appended');
    expect(findingByTool.get('tool_b')?.because).toBe('tool_b reasons no emission');
    expect(findingByTool.get('tool_b')?.event).toBe('tool.b.appended');
  });

  /**
   * Kill probe for the direction that a declaration table cannot find: the tree appends an event
   * that nothing claims. A row on the non-action surface then explains the site.
   */
  it('EmitterClosure_UnclaimedAppend_IsReported', () => {
    const closure = auditEmitterClosure(
      censusOf({ 'seeded.event': ['somewhere/module.ts'] }, ['somewhere/module.ts']),
      [],
      [],
      [],
    );

    expect(closure.ok).toBe(false);
    expect(closure.undeclared).toHaveLength(1);
    expect(closure.undeclared[0]?.event).toBe('seeded.event');
    expect(closure.undeclared[0]?.module).toBe('somewhere/module.ts');

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
      [],
    );
    expect(declared.ok).toBe(true);
    expect(declared.explainedByModule).toBe(1);
  });

  /** The row names a module that the census scanned, and that module has no such append. */
  it('EmitterClosure_ModuleEmissionWithNoAppend_IsAPhantom', () => {
    const closure = auditEmitterClosure(
      censusOf({}, ['scanned/module.ts']),
      [],
      [
        {
          event: 'seeded.event',
          module: 'scanned/module.ts',
          trigger: 'process-hook',
          rationale: 'seeded',
        },
      ],
      [],
    );

    expect(closure.ok).toBe(false);
    expect(closure.phantoms).toHaveLength(1);
    expect(closure.phantoms[0]?.module).toBe('scanned/module.ts');
    expect(closure.unverifiable).toEqual([]);
  });

  /**
   * Two rows for one site leave `explainedByModule` one less than the row count.
   * Each arm that reports a named fault stays silent, so only the row-to-site count sees the
   * duplicate.
   */
  it('EmitterClosure_DuplicatedModuleEmission_BreaksTheRowToSiteCount', () => {
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
      [],
    );

    expect(closure.ok).toBe(true);
    expect(closure.undeclared).toEqual([]);
    expect(closure.phantoms).toEqual([]);
    expect(closure.unverifiable).toEqual([]);

    expect(closure.explainedByModule).toBe(1);
    expect(closure.explainedByModule).not.toBe(rows.length);
  });

  /**
   * An action already declares the event, so the action arm claims the site and the row explains
   * no site. The append exists, so the row is not a phantom. Only the row-to-site count sees it.
   */
  it('EmitterClosure_ModuleRowShadowingAnActionEdge_ExplainsNothing', () => {
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
      [],
    );

    expect(closure.ok).toBe(true);
    expect(closure.phantoms).toEqual([]);
    expect(closure.explainedByAction).toBe(1);
    expect(closure.explainedByModule).toBe(0);
    expect(closure.explainedByModule).not.toBe(rows.length);
  });

  /** A row for a module that the census did not scan is unanswered, not refuted. */
  it('EmitterClosure_ModuleOutsideTheScanRoot_IsUnverifiableNotPhantom', () => {
    const closure = auditEmitterClosure(
      censusOf({}, ['scanned/module.ts']),
      [],
      [
        {
          event: 'seeded.event',
          module: 'elsewhere/harness.ts',
          trigger: 'process-hook',
          rationale: 'seeded',
        },
      ],
      [],
    );

    expect(closure.phantoms).toEqual([]);
    expect(closure.unverifiable).toEqual([
      { event: 'seeded.event', module: 'elsewhere/harness.ts', reason: 'outside-scan-root' },
    ]);
  });
});
