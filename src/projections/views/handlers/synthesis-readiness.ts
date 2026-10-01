import { toViewFailure } from '../../degraded-result.js';
import { EventStore } from '../../../events/store.js';
import type { ToolResult } from '../../../format.js';
import { SYNTHESIS_READINESS_VIEW, type SynthesisReadinessState } from '../synthesis-readiness-view.js';
import { getOrCreateMaterializer } from './materializer.js';
import { foldToTail } from '../../fold-at-tail.js';
import { readWorkflowStateJson } from './streams.js';

/**
 * Returns the `synthesis_readiness` view. The response omits `review.findingsBySeverity`
 * unless `detail` is true.
 *
 * The planner stamps reviews and tasks in `state.json`, and the projection reads only
 * events. So a review entry in `state.json` wins, which stops a stale `true` after a
 * re-stamp. When `state.json` has a task list, the task total and the completed count
 * come from it, because a task can complete without an event. A `null` test or typecheck
 * result means that nothing measured it, so its blocker says "not measured".
 */
export async function handleViewSynthesisReadiness(
  args: {
    workflowId?: string;
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

    const stateTasks = state?.['tasks'];
    const tasksTotal = Array.isArray(stateTasks) ? stateTasks.length : view.tasks.total;
    const tasksCompleted = Array.isArray(stateTasks)
      ? stateTasks.filter((t) => {
          if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
          const status = (t as Record<string, unknown>)['status'];
          return status === 'complete' || status === 'completed';
        }).length
      : view.tasks.completed;

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

    if (args.detail) {
      return { success: true, data };
    }
    const { findingsBySeverity: _findingsBySeverity, ...compactReview } = data.review;
    return { success: true, data: { ...data, review: compactReview } };
  } catch (err) {
    return toViewFailure(err, { tool: 'exarchos_view', action: 'synthesis_readiness' });
  }
}
