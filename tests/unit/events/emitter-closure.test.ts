/**
 * Emitter closure: every append in the tree is explained, and every explanation
 * is live.
 *
 * The undeclared baseline is a MEASUREMENT, not a suppression list. The audit
 * reports all 33 on every run; this file pins today's shape so the set cannot
 * grow unnoticed and shrinks visibly as emitters are declared.
 *
 * The phantom arm carries no baseline at all, deliberately. A stale row in the
 * non-action surface is never acceptable, so there is nothing to grandfather —
 * it fails the moment an append it names stops existing.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { scanAppendSites, type AppendSiteCensus } from '../../../src/events/append-site-census.js';
import { auditEmitterClosure } from '../../../src/events/emitter-closure-audit.js';
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
  'branch.delete.executed <- workflow/compensation.ts',
  'branch.delete.requested <- workflow/compensation.ts',
  'command.resolved <- config/test-runtime-resolver.ts',
  'dispatch.classified <- verbs/review/classify-review-items.ts',
  'dispatch.preflight <- verbs/team/dispatch-guard.ts',
  'elicitation.declined <- dispatch/elicitation-dispatch.ts',
  'elicitation.fulfilled <- dispatch/elicitation-dispatch.ts',
  'elicitation.requested <- dispatch/elicitation-dispatch.ts',
  'export.executed <- projections/views/lifecycle/export.ts',
  'export.requested <- projections/views/lifecycle/export.ts',
  'issue.create.executed <- verbs/vcs/create-issue.ts',
  'issue.create.requested <- verbs/vcs/create-issue.ts',
  'launch.executed <- runtime/launcher/liveness.ts',
  'merge.executing_started <- verbs/merge/execute-merge.ts',
  'merge.retry_attempt <- verbs/merge/execute-merge.ts',
  'pr.comment.executed <- verbs/vcs/add-pr-comment.ts',
  'pr.create.executed <- verbs/vcs/create-pr.ts',
  'pr.create.requested <- verbs/vcs/create-pr.ts',
  'projection.degraded <- projections/freshness.ts',
  'projection.recovered <- projections/freshness.ts',
  'provider.parse-error <- verbs/vcs/assess-stack.ts',
  'provider.unknown-tier <- verbs/vcs/assess-stack.ts',
  'prune.diagnostics <- verbs/team/prune-stale-workflows.ts',
  'quality.regression <- projections/quality/regression-detector.ts',
  'stack.position-filled <- stack/tools.ts',
  'stash.detected <- verbs/team/dispatch-guard.ts',
  'task.assigned <- events/decide-fixtures.ts',
  'task.created <- projections/task-store/event-sourced-task-store.ts',
  'task.polled <- projections/task-store/event-sourced-task-store.ts',
  'workflow.plan-review-dispatched <- verbs/team/prepare-review.ts',
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
