import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../../events/schemas.js';

export const SYNTHESIS_READINESS_VIEW = 'synthesis-readiness';

export interface SynthesisReadinessState {
  ready: boolean;
  blockers: string[];
  tasks: {
    total: number;
    completed: number;
    failed: number;
  };
  review: {
    reviewPassed: boolean;
    findingsBySeverity: Record<string, number>;
  };
  tests: {
    lastRunPassed: boolean | null;
    typecheckPassed: boolean | null;
    coveragePercent: number | null;
  };
  stack: {
    restacked: boolean;
    conflicts: boolean;
  };
}

/** Compute readiness and blockers from the current projected state. */
function computeReadiness(state: SynthesisReadinessState): {
  ready: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];

  if (state.tasks.total === 0) {
    blockers.push('no tasks tracked');
  } else if (state.tasks.completed !== state.tasks.total) {
    blockers.push(
      `tasks incomplete: ${state.tasks.completed}/${state.tasks.total} completed`,
    );
  }

  if (!state.review.reviewPassed) {
    blockers.push('review not passed');
  }

  if (state.tests.lastRunPassed !== true) {
    blockers.push('tests not passing');
  }

  if (state.tests.typecheckPassed !== true) {
    blockers.push('typecheck not passing');
  }

  if (state.stack.conflicts) {
    blockers.push('stack has unresolved conflicts');
  }

  const ready = blockers.length === 0;
  return { ready, blockers };
}

/**
 * Folds task, gate, review finding, test, typecheck, and restack events into the synthesis readiness view.
 * Each change recomputes `ready` and `blockers`. The `review` gate sets `reviewPassed`. The old
 * `spec-review` and `quality-review` gate names also set it, so historical events still project.
 */
export const synthesisReadinessProjection: ViewProjection<SynthesisReadinessState> = {
  init: () => ({
    ready: false,
    blockers: ['no tasks tracked'],
    tasks: { total: 0, completed: 0, failed: 0 },
    review: { reviewPassed: false, findingsBySeverity: {} },
    tests: { lastRunPassed: null, typecheckPassed: null, coveragePercent: null },
    stack: { restacked: false, conflicts: false },
  }),

  apply: (view, event) => {
    const eventType = event.type as string;
    let updated: SynthesisReadinessState;

    switch (eventType) {
      case 'task.assigned': {
        updated = {
          ...view,
          tasks: { ...view.tasks, total: view.tasks.total + 1 },
        };
        break;
      }

      case 'task.completed': {
        updated = {
          ...view,
          tasks: { ...view.tasks, completed: view.tasks.completed + 1 },
        };
        break;
      }

      case 'task.failed': {
        updated = {
          ...view,
          tasks: { ...view.tasks, failed: view.tasks.failed + 1 },
        };
        break;
      }

      case 'gate.executed': {
        const data = event.data as
          | { gateName?: string; passed?: boolean }
          | undefined;
        if (!data?.gateName) return view;

        if (
          data.gateName === 'review' ||
          data.gateName === 'spec-review' ||
          data.gateName === 'quality-review'
        ) {
          updated = {
            ...view,
            review: { ...view.review, reviewPassed: data.passed === true },
          };
        } else {
          return view;
        }
        break;
      }

      case 'review.finding': {
        const data = event.data as { severity?: string } | undefined;
        if (!data?.severity) return view;

        const currentCount = view.review.findingsBySeverity[data.severity] ?? 0;
        updated = {
          ...view,
          review: {
            ...view.review,
            findingsBySeverity: {
              ...view.review.findingsBySeverity,
              [data.severity]: currentCount + 1,
            },
          },
        };
        break;
      }

      case 'test.result': {
        const data = event.data as
          | { passed?: boolean; coveragePercent?: number }
          | undefined;

        updated = {
          ...view,
          tests: {
            ...view.tests,
            lastRunPassed: data?.passed ?? null,
            coveragePercent: data?.coveragePercent ?? view.tests.coveragePercent,
          },
        };
        break;
      }

      case 'typecheck.result': {
        const data = event.data as { passed?: boolean } | undefined;

        updated = {
          ...view,
          tests: {
            ...view.tests,
            typecheckPassed: data?.passed ?? null,
          },
        };
        break;
      }

      case 'stack.restacked': {
        const data = event.data as { conflicts?: boolean } | undefined;

        updated = {
          ...view,
          stack: {
            restacked: true,
            conflicts: data?.conflicts === true,
          },
        };
        break;
      }

      default:
        return view;
    }

    const { ready, blockers } = computeReadiness(updated);
    return { ...updated, ready, blockers };
  },
};
