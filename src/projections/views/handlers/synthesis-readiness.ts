import { toViewFailure } from '../../degraded-result.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { SYNTHESIS_READINESS_VIEW, type SynthesisReadinessState } from '../synthesis-readiness-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';
import { readWorkflowStateJson } from './streams.js';

// ─── View Synthesis Readiness Handler ────────────────────────────────────────

export async function handleViewSynthesisReadiness(
  args: {
    workflowId?: string;
    // DR-8 (Task 024) — compact-by-default drops the review's per-severity
    // findings breakdown; `detail: true` restores it.
    detail?: boolean;
  },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  try {
    const store = eventStore;
    const materializer = getOrCreateMaterializer(stateDir);
    const streamId = args.workflowId ?? 'default';

    const { view } = await foldToTail<SynthesisReadinessState>(store, materializer, streamId, SYNTHESIS_READINESS_VIEW);

    // Fix 2 (#1184) — review status is plan-state stamped via `workflow set`
    // (state.reviews); the synthesis-readiness projection only watches
    // `gate.executed`, so reviews recorded directly into state.json never
    // surface as passed. state.json is the planner's source of truth — when
    // an entry exists there, prefer it; otherwise fall back to the projection.
    // This avoids a stale projection-derived `true` sticking after the
    // planner re-stamps a review back to a non-passed status.
    const state = await readWorkflowStateJson(stateDir, streamId);
    const reviews = (state?.['reviews'] as Record<string, unknown> | undefined) ?? {};
    const reviewStatus = (
      key: string,
    ): { present: boolean; passed: boolean } => {
      const r = reviews[key];
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        return { present: false, passed: false };
      }
      return {
        present: true,
        passed: (r as Record<string, unknown>)['status'] === 'passed',
      };
    };
    const review = reviewStatus('review');
    const reviewPassed = review.present ? review.passed : view.review.reviewPassed;

    // Fix 2 (#1184) — task counts: the projection counts events; state.json
    // is the planner's stamp. Both `total` AND `completed` need the
    // state.json fallback — projection-derived completed count is
    // event-driven, so in the missing-event flows this PR is fixing it
    // would underreport (state.tasks shows complete but no task.completed
    // event ever fired). CR review 4178067854.
    const stateTasks = state?.['tasks'];
    const tasksTotal = Array.isArray(stateTasks) ? stateTasks.length : view.tasks.total;
    const tasksCompleted = Array.isArray(stateTasks)
      ? stateTasks.filter((t) => {
          if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
          const status = (t as Record<string, unknown>)['status'];
          return status === 'complete' || status === 'completed';
        }).length
      : view.tasks.completed;

    // Fix 2 (T2.6) — distinguish null (not measured) from false (failed) when
    // generating blocker text. The projection's tests.* fields initialize to
    // null; only `test.result` / `typecheck.result` events flip them to a
    // boolean. Saying "tests not passing" when no test ever ran is misleading.
    const blockers: string[] = [];
    if (tasksTotal === 0) {
      blockers.push('no tasks tracked');
    } else if (tasksCompleted !== tasksTotal) {
      blockers.push(
        `tasks incomplete: ${tasksCompleted}/${tasksTotal} completed`,
      );
    }
    if (!reviewPassed) blockers.push('review not passed');
    if (view.tests.lastRunPassed === null) {
      blockers.push('tests not measured');
    } else if (view.tests.lastRunPassed !== true) {
      blockers.push('tests not passing');
    }
    if (view.tests.typecheckPassed === null) {
      blockers.push('typecheck not measured');
    } else if (view.tests.typecheckPassed !== true) {
      blockers.push('typecheck not passing');
    }
    if (view.stack.conflicts) blockers.push('stack has unresolved conflicts');

    const ready = blockers.length === 0;
    const data: SynthesisReadinessState = {
      ...view,
      ready,
      blockers,
      tasks: { ...view.tasks, total: tasksTotal, completed: tasksCompleted },
      review: { ...view.review, reviewPassed },
    };

    // DR-8 (Task 024) compact-by-default — drop the review's per-severity
    // findings breakdown; the `reviewPassed` headline + `blockers` stay.
    // `detail: true` restores `findingsBySeverity`.
    if (args.detail) {
      return { success: true, data };
    }
    const { findingsBySeverity: _findingsBySeverity, ...compactReview } = data.review;
    return { success: true, data: { ...data, review: compactReview } };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'synthesis_readiness' });
  }
}
