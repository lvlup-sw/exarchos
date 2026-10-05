// @oracle-sources: ../../../src/events/append-site-census.ts, ../../../src/events/registration-validate.ts
/**
 * Runs the provider-area audit over the real tree and over seeded censuses.
 *
 * The two oracles are independent. The census supplies each append and its area, and
 * `EFFECT_PROVIDERS` supplies the provider-to-area vocabulary. The audit module is the subject of
 * the test, so the oracle line does not name it.
 *
 * The two baselines are measurements, not suppression lists. The audit reports each entry on each
 * run, and this file pins the current tree so that neither set can grow unnoticed.
 * A disposition table in `src/` hides findings, so the baselines stay in this file.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { scanAppendSites, type AppendSiteCensus } from '../../../src/events/append-site-census.js';
import { auditProviderAreas } from '../../../src/events/provider-area-audit.js';
import { EVIDENCE_DISCRIMINANT_CONSTANTS } from '../../../src/verbs/gates/gate-ownership-census.js';
import type { EventRegistration } from '../../../src/events/event-registration.js';
import { scanEvidenceEmission } from '../../../tools/test-helpers/evidence-emission-scanner.js';

const SOURCE_ROOT = join(process.cwd(), 'src');

/**
 * The definite faults. Each append is inside the area of a provider that the annotation does not
 * name, so one of the two claims is false.
 *
 * The list must only shrink. Both events are worktree lifecycle events with the provider
 * `exarchos_orchestrate` (`verbs/`). The saga compensation path in `workflow/` appends them, and
 * `exarchos_workflow` owns that area.
 */
const MEASURED_CONTRADICTIONS: readonly string[] = Object.freeze([
  'worktree.adopted -> workflow/compensation.ts (owned by exarchos_workflow)',
  'worktree.remove.executed -> workflow/compensation.ts (owned by exarchos_workflow)',
]);

/**
 * The structural gap. Each append is in an area that no provider owns, so no annotation over the
 * current vocabulary is correct.
 *
 * The list must only shrink. The entries are the dispatch wrapper (`projections/telemetry/`), the
 * process hooks (`lifecycle/`, `runtime/launcher/`) and one handler tree (`review/`). To remove an
 * entry, move the append into an area that a provider owns. Do not widen the vocabulary.
 */
const MEASURED_UNGOVERNED: readonly string[] = Object.freeze([
  'launch.executed -> runtime/launcher/liveness.ts',
  'launch.executing_started -> runtime/launcher/liveness.ts',
  'review.routed -> review/tools.ts',
  'subagent.tokens_used -> lifecycle/subagent-stop.ts',
  'tool.action_errored -> projections/telemetry/middleware.ts',
  'tool.budget_exceeded -> projections/telemetry/middleware.ts',
  'tool.completed -> projections/telemetry/middleware.ts',
  'tool.errored -> projections/telemetry/middleware.ts',
]);

/** A census carrying exactly the sites a test supplies. */
function censusOf(modulesByEvent: Record<string, readonly string[]>): AppendSiteCensus {
  return {
    modulesByEvent: new Map(Object.entries(modulesByEvent)),
    unresolved: [],
    scannedModuleCount: 1,
  };
}

const capability = (
  provider: string,
  lifecycle: 'active' | 'planned' = 'active',
): EventRegistration =>
  ({ lifecycle, tier: 'capability', provider, consumedBy: ['workflow-state@v1'] }) as EventRegistration;

describe('provider-area audit', () => {
  /**
   * The test asserts the population counts before the findings.
   * A scan that reads nothing gives an empty finding set, which looks the same as a clean tree.
   */
  it('ProviderArea_LiveTree_MatchesTheMeasuredBaselines', async () => {
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );

    expect(census.scannedModuleCount, 'the scan read no modules').toBeGreaterThan(500);
    expect(census.modulesByEvent.size, 'the scan resolved no append sites').toBeGreaterThan(50);

    const audit = auditProviderAreas(census);
    expect(audit.subjectCount, 'no capability registration was assessed').toBeGreaterThan(40);
    expect(audit.measuredCount, 'no subject had a measured append site').toBeGreaterThan(25);

    expect(
      audit.contradictions
        .map((d) => `${d.event} -> ${d.module} (owned by ${d.owningProvider})`)
        .sort(),
    ).toEqual([...MEASURED_CONTRADICTIONS].sort());

    expect(audit.ungoverned.map((d) => `${d.event} -> ${d.module}`).sort()).toEqual(
      [...MEASURED_UNGOVERNED].sort(),
    );
  }, 120_000);

  /**
   * `exarchos_workflow` owns `workflow/`, and the seeded append is in `verbs/`, which
   * `exarchos_orchestrate` owns. The same registration with the append in `workflow/` is clean,
   * so the area causes the finding and the fixture does not.
   */
  it('ProviderArea_AppendInAnotherProvidersArea_IsAContradiction', () => {
    const audit = auditProviderAreas(censusOf({ 'seeded.event': ['verbs/somewhere.ts'] }), {
      'seeded.event': capability('exarchos_workflow'),
    });

    expect(audit.ok).toBe(false);
    expect(audit.contradictions).toHaveLength(1);
    expect(audit.contradictions[0]?.owningProvider).toBe('exarchos_orchestrate');
    expect(audit.ungoverned).toEqual([]);

    const inside = auditProviderAreas(censusOf({ 'seeded.event': ['workflow/somewhere.ts'] }), {
      'seeded.event': capability('exarchos_workflow'),
    });
    expect(inside.ok).toBe(true);
    expect(inside.contradictions).toEqual([]);
    expect(inside.measuredCount).toBe(1);
  });

  /**
   * A tool calls modules outside its area, so an append in an area that no provider owns does not
   * show a wrong annotation. The append must not fail the audit, but the audit must report it.
   */
  it('ProviderArea_AppendOutsideEveryArea_IsUngovernedNotAFault', () => {
    const audit = auditProviderAreas(censusOf({ 'seeded.event': ['tasks/tools.ts'] }), {
      'seeded.event': capability('exarchos_orchestrate'),
    });

    expect(audit.contradictions).toEqual([]);
    expect(audit.ok, 'an ungoverned append must not read as a contradiction').toBe(true);
    expect(audit.ungoverned).toHaveLength(1);
    expect(audit.ungoverned[0]?.module).toBe('tasks/tools.ts');
  });

  /**
   * The audit lists an `active` registration with no measured site as unmeasured, not as a
   * contradiction. It does not list a `planned` registration, which has no emitter by design.
   */
  it('ProviderArea_NoMeasuredSite_IsCountedNotReported', () => {
    const active = auditProviderAreas(censusOf({}), {
      'seeded.event': capability('exarchos_workflow'),
    });
    expect(active.contradictions).toEqual([]);
    expect(active.measuredCount).toBe(0);
    expect(active.unmeasured).toEqual([
      { event: 'seeded.event', declaredProvider: 'exarchos_workflow' },
    ]);

    const planned = auditProviderAreas(censusOf({}), {
      'seeded.event': capability('exarchos_workflow', 'planned'),
    });
    expect(planned.unmeasured).toEqual([]);
  });

  it('ProviderArea_UnresolvableProviderId_IsLeftToTheWeldGate', () => {
    const audit = auditProviderAreas(censusOf({ 'seeded.event': ['verbs/somewhere.ts'] }), {
      'seeded.event': capability('exarchos_not_a_tool'),
    });
    expect(audit.contradictions).toEqual([]);
    expect(audit.subjectCount).toBe(0);
  });
});
