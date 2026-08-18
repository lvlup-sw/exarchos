// @oracle-sources: ../../../src/events/append-site-census.ts, ../../../src/events/registration-validate.ts
// Two INDEPENDENT authorities: the census supplies the appends and the areas they
// sit in, EFFECT_PROVIDERS in registration-validate supplies the provider-to-area
// vocabulary they are compared against. The audit module itself is NOT named — it
// is the subject under test, and the census is reachable from it. Neither baseline
// below is a suppression list.
/**
 * The provider-area audit, over the real tree.
 *
 * The two baselines below are MEASUREMENTS, not suppression lists. The audit
 * keeps reporting every entry on every run; this file only pins what the tree
 * looks like today so neither set can grow unnoticed. That distinction is why
 * they live here and not beside the policy: a disposition table in `src/` makes
 * findings disappear, and would then have to be unwound before the check could
 * be promoted to blocking — which is exactly where the emission-coupling
 * diagnostics are stuck.
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
 * Definite faults: the append lands inside an area owned by a provider other
 * than the one annotated, so exactly one of the two claims is false.
 *
 * SHRINK-ONLY. Both are worktree lifecycle events annotated
 * `exarchos_orchestrate` (`verbs/`) and appended by the saga compensation path
 * in `workflow/` — the area `exarchos_workflow` owns. No existing check reports
 * them: the tool-against-tool comparison cannot see an append site at all.
 */
const MEASURED_CONTRADICTIONS: readonly string[] = Object.freeze([
  'worktree.adopted -> workflow/compensation.ts (owned by exarchos_workflow)',
  'worktree.remove.executed -> workflow/compensation.ts (owned by exarchos_workflow)',
]);

/**
 * The structural gap: appends from areas NO provider owns, so no annotation
 * over the current vocabulary could be right.
 *
 * SHRINK-ONLY, and this is the number the emission model has to answer for.
 * Two kinds sit here now — the dispatch wrapper (`projections/telemetry/`) and
 * the process hooks (`lifecycle/`, `runtime/launcher/`) — plus one handler tree
 * with no provider (`review/`). The `tasks/` entries went when that append
 * module joined `verbs/`, and `stack/` followed it there for the same reason:
 * an area no provider owns is one whose appends no annotation can describe, and
 * the fix is to move the append under an area that has one, never to widen the
 * vocabulary until the row happens to typecheck.
 */
const MEASURED_UNGOVERNED: readonly string[] = Object.freeze([
  'gate.executed -> projections/telemetry/middleware.ts',
  'launch.executed -> runtime/launcher/liveness.ts',
  'launch.executing_started -> runtime/launcher/liveness.ts',
  'review.routed -> review/tools.ts',
  'subagent.tokens_used -> lifecycle/subagent-stop.ts',
  'tool.action_errored -> projections/telemetry/middleware.ts',
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
  it('ProviderArea_LiveTree_MatchesTheMeasuredBaselines', async () => {
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );

    // THE DENOMINATORS FIRST. A scan that read nothing produces an empty finding
    // set indistinguishable from a clean tree, so the population is asserted
    // before any verdict drawn from it.
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

  it('ProviderArea_AppendInAnotherProvidersArea_IsAContradiction', () => {
    // `exarchos_workflow` owns `workflow/`; the append is measured in `verbs/`,
    // which `exarchos_orchestrate` owns. Both cannot own it.
    const audit = auditProviderAreas(censusOf({ 'seeded.event': ['verbs/somewhere.ts'] }), {
      'seeded.event': capability('exarchos_workflow'),
    });

    expect(audit.ok).toBe(false);
    expect(audit.contradictions).toHaveLength(1);
    expect(audit.contradictions[0]?.owningProvider).toBe('exarchos_orchestrate');
    expect(audit.ungoverned).toEqual([]);

    // The same registration with the append INSIDE its own area is clean, so
    // the arm above is attributable to the area and not to the fixture.
    const inside = auditProviderAreas(censusOf({ 'seeded.event': ['workflow/somewhere.ts'] }), {
      'seeded.event': capability('exarchos_workflow'),
    });
    expect(inside.ok).toBe(true);
    expect(inside.contradictions).toEqual([]);
    expect(inside.measuredCount).toBe(1);
  });

  it('ProviderArea_AppendOutsideEveryArea_IsUngovernedNotAFault', () => {
    // A tool dispatches well beyond its own area, so an append in an
    // unclaimed tree is NOT evidence the annotation is wrong. It is the absence
    // of a claim, it must not fail the audit, and it must stay visible.
    const audit = auditProviderAreas(censusOf({ 'seeded.event': ['tasks/tools.ts'] }), {
      'seeded.event': capability('exarchos_orchestrate'),
    });

    expect(audit.contradictions).toEqual([]);
    expect(audit.ok, 'an ungoverned append must not read as a contradiction').toBe(true);
    expect(audit.ungoverned).toHaveLength(1);
    expect(audit.ungoverned[0]?.module).toBe('tasks/tools.ts');
  });

  it('ProviderArea_NoMeasuredSite_IsCountedNotReported', () => {
    // Absence is a different answer from contradiction.
    const active = auditProviderAreas(censusOf({}), {
      'seeded.event': capability('exarchos_workflow'),
    });
    expect(active.contradictions).toEqual([]);
    expect(active.measuredCount).toBe(0);
    expect(active.unmeasured).toEqual([
      { event: 'seeded.event', declaredProvider: 'exarchos_workflow' },
    ]);

    // A `planned` registration correctly has no emitter, so it is not even
    // counted as unmeasured — that would report the lifecycle working.
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
