/**
 * The provider-area audit: does a registration's `provider` name the area its
 * event is actually appended from?
 *
 * The baseline below is a MEASUREMENT, not a suppression list. The audit keeps
 * reporting every one of these on every run; this file only pins what the tree
 * looks like today so the set cannot grow unnoticed. That distinction is the
 * whole reason it lives here and not beside the policy: a disposition table in
 * `src/` would make the findings disappear, and the check would then have to be
 * unwound before it could ever be promoted to blocking — which is exactly the
 * position the emission-coupling diagnostics are stuck in.
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
 * Every provider-area mismatch in the tree today, `event → the areas it is
 * appended from`.
 *
 * SHRINK-ONLY. An entry leaves when the append moves into the declared area, or
 * when the annotation is corrected to name the area that actually appends.
 * Adding one is a deliberate act that fails here first.
 *
 * Four groups, and they do not have the same remedy:
 *   • `tasks/`, `stack/`, `runtime/`, `review/`, `lifecycle/` — appends from
 *     areas NO provider governs, so no annotation can be right.
 *   • `projections/telemetry/` — the dispatch wrapper, which is not an action
 *     and has no provider of its own.
 *   • `workflow/compensation.ts` on two worktree events — a governed area, but
 *     not the one the annotation names.
 *   • `gate.executed` — genuinely appended from two areas, which the
 *     tool-against-tool comparison cannot express at all.
 */
const MEASURED_MISMATCHES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'gate.executed': ['projections/telemetry/middleware.ts'],
  'launch.executed': ['runtime/launcher/liveness.ts'],
  'launch.executing_started': ['runtime/launcher/liveness.ts'],
  'review.routed': ['review/tools.ts'],
  'stack.position-filled': ['stack/tools.ts'],
  'subagent.tokens_used': ['lifecycle/subagent-stop.ts'],
  'task.claimed': ['tasks/tools.ts'],
  'task.completed': ['tasks/tools.ts'],
  'task.failed': ['tasks/tools.ts'],
  'tool.action_errored': ['projections/telemetry/middleware.ts'],
  'tool.completed': ['projections/telemetry/middleware.ts'],
  'tool.errored': ['projections/telemetry/middleware.ts'],
  'worktree.adopted': ['workflow/compensation.ts'],
  'worktree.remove.executed': ['workflow/compensation.ts'],
});

/** A census carrying exactly the sites a test supplies. */
function censusOf(modulesByEvent: Record<string, readonly string[]>): AppendSiteCensus {
  return {
    modulesByEvent: new Map(Object.entries(modulesByEvent)),
    unresolved: [],
    scannedModuleCount: 1,
  };
}

const capability = (provider: string, lifecycle: 'active' | 'planned' = 'active'): EventRegistration =>
  ({ lifecycle, tier: 'capability', provider, consumedBy: ['workflow-state@v1'] }) as EventRegistration;

describe('provider-area audit', () => {
  it('ProviderArea_LiveTree_MatchesTheMeasuredBaseline', async () => {
    const census = await scanAppendSites(
      SOURCE_ROOT,
      scanEvidenceEmission,
      EVIDENCE_DISCRIMINANT_CONSTANTS,
    );

    // THE DENOMINATORS FIRST. A scan that read nothing produces an empty
    // finding set that is indistinguishable from a clean tree, so the
    // population is asserted before any verdict drawn from it.
    expect(census.scannedModuleCount, 'the scan read no modules').toBeGreaterThan(500);
    expect(census.modulesByEvent.size, 'the scan resolved no append sites').toBeGreaterThan(50);

    const audit = auditProviderAreas(census);
    expect(audit.subjectCount, 'no capability registration was assessed').toBeGreaterThan(40);
    expect(audit.measuredCount, 'no subject had a measured append site').toBeGreaterThan(25);

    const found: Record<string, readonly string[]> = {};
    for (const d of audit.diagnostics) found[d.event] = d.foreignModules;
    expect(found).toEqual(MEASURED_MISMATCHES);
  }, 120_000);

  it('ProviderArea_AppendOutsideTheDeclaredArea_IsReported', () => {
    // The kill probe. `exarchos_workflow` is area `workflow/`; the append is
    // measured in `verbs/`, so the claim is false and must be named.
    const audit = auditProviderAreas(
      censusOf({ 'seeded.event': ['verbs/somewhere.ts'] }),
      { 'seeded.event': capability('exarchos_workflow') },
    );

    expect(audit.ok).toBe(false);
    expect(audit.diagnostics).toHaveLength(1);
    expect(audit.diagnostics[0]?.event).toBe('seeded.event');
    expect(audit.diagnostics[0]?.declaredArea).toBe('workflow/');
    expect(audit.diagnostics[0]?.foreignModules).toEqual(['verbs/somewhere.ts']);

    // ...and the same registration with the append INSIDE its area is clean,
    // so the arm above is attributable to the area and not to the fixture.
    const inside = auditProviderAreas(
      censusOf({ 'seeded.event': ['workflow/somewhere.ts'] }),
      { 'seeded.event': capability('exarchos_workflow') },
    );
    expect(inside.ok).toBe(true);
    expect(inside.measuredCount).toBe(1);
  });

  it('ProviderArea_NoMeasuredSite_IsCountedNotReported', () => {
    // Absence is a different answer from contradiction. An `active`
    // registration the census could not place is counted so it stays visible,
    // but it is NOT a mismatch: reporting it as one would put an unanswerable
    // finding under the same name as an actionable one.
    const active = auditProviderAreas(censusOf({}), {
      'seeded.event': capability('exarchos_workflow'),
    });
    expect(active.diagnostics).toEqual([]);
    expect(active.measuredCount).toBe(0);
    expect(active.unmeasured).toEqual([
      { event: 'seeded.event', declaredProvider: 'exarchos_workflow' },
    ]);

    // A `planned` registration correctly has no emitter at all, so it is not
    // even counted as unmeasured — that would report the lifecycle working.
    const planned = auditProviderAreas(censusOf({}), {
      'seeded.event': capability('exarchos_workflow', 'planned'),
    });
    expect(planned.unmeasured).toEqual([]);
    expect(planned.ok).toBe(true);
  });

  it('ProviderArea_UnresolvableProviderId_IsLeftToTheWeldGate', () => {
    // An id naming no provider is the weld gate's finding. Reporting it here
    // too would make an echo look like corroboration.
    const audit = auditProviderAreas(
      censusOf({ 'seeded.event': ['verbs/somewhere.ts'] }),
      { 'seeded.event': capability('exarchos_not_a_tool') },
    );
    expect(audit.diagnostics).toEqual([]);
    expect(audit.subjectCount).toBe(0);
  });
});
