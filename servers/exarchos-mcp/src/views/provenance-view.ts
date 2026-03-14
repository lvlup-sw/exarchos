import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const PROVENANCE_VIEW = 'provenance';

// ─── Bounds ─────────────────────────────────────────────────────────────────

export const MAX_ORPHAN_TASKS = 200;

// ─── View State Interfaces ─────────────────────────────────────────────────

export interface RequirementStatus {
  readonly id: string;
  readonly status: 'covered' | 'uncovered';
  readonly tasks: readonly string[];
  readonly tests: readonly { name: string; file: string }[];
  readonly files: readonly string[];
  readonly acceptanceTests: readonly string[];
}

export interface ProvenanceViewState {
  readonly featureId: string;
  readonly requirements: readonly RequirementStatus[];
  readonly coverage: number;
  readonly acceptanceTestCoverage: number;
  readonly orphanTasks: readonly string[];
  /** Internal: set of completed task IDs for resolving acceptanceTestRef links. */
  readonly _completedTaskIds: readonly string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeCoverage(requirements: readonly RequirementStatus[]): number {
  if (requirements.length === 0) return 0;
  const covered = requirements.filter((r) => r.status === 'covered').length;
  return covered / requirements.length;
}

function computeAcceptanceTestCoverage(
  requirements: readonly RequirementStatus[],
  completedTaskIds: ReadonlySet<string>,
): number {
  if (requirements.length === 0) return 0;
  const withAcceptanceTests = requirements.filter((r) =>
    r.acceptanceTests.some((ref) => completedTaskIds.has(ref)),
  ).length;
  return withAcceptanceTests / requirements.length;
}

function upsertRequirement(
  requirements: readonly RequirementStatus[],
  reqId: string,
  taskId: string,
  tests: readonly { name: string; file: string }[],
  files: readonly string[],
  acceptanceTestRef?: string,
): RequirementStatus[] {
  const existing = requirements.find((r) => r.id === reqId);

  if (existing) {
    // Deduplicate tests by name+file key (includes intra-batch dedup)
    const seenTestKeys = new Set(existing.tests.map((t) => `${t.name}\0${t.file}`));
    const newTests: Array<{ name: string; file: string }> = [];
    for (const t of tests) {
      const key = `${t.name}\0${t.file}`;
      if (seenTestKeys.has(key)) continue;
      seenTestKeys.add(key);
      newTests.push(t);
    }

    // Deduplicate acceptance test refs
    const updatedAcceptanceTests = acceptanceTestRef && !existing.acceptanceTests.includes(acceptanceTestRef)
      ? [...existing.acceptanceTests, acceptanceTestRef]
      : [...existing.acceptanceTests];

    return requirements.map((r) =>
      r.id === reqId
        ? {
            ...r,
            tasks: [...new Set([...r.tasks, taskId])],
            files: [...new Set([...r.files, ...files])],
            tests: [...r.tests, ...newTests],
            acceptanceTests: updatedAcceptanceTests,
          }
        : r,
    );
  }

  return [
    ...requirements,
    {
      id: reqId,
      status: 'covered',
      tasks: [taskId],
      tests: [...tests],
      files: [...files],
      acceptanceTests: acceptanceTestRef ? [acceptanceTestRef] : [],
    },
  ];
}

// ─── Event Handlers ────────────────────────────────────────────────────────

function handleWorkflowStarted(
  state: ProvenanceViewState,
  event: WorkflowEvent,
): ProvenanceViewState {
  const data = event.data as { featureId?: string } | undefined;
  if (!data?.featureId) return state;

  return {
    ...state,
    featureId: data.featureId,
  };
}

function handleTaskCompleted(
  state: ProvenanceViewState,
  event: WorkflowEvent,
): ProvenanceViewState {
  const data = event.data as {
    taskId?: string;
    implements?: string[];
    tests?: { name: string; file: string }[];
    files?: string[];
    acceptanceTestRef?: string;
  } | undefined;

  if (!data?.taskId) return state;

  // Track this task as completed
  const completedTaskIds = state._completedTaskIds.includes(data.taskId)
    ? state._completedTaskIds
    : [...state._completedTaskIds, data.taskId];

  const implementsArr = data.implements ?? [];
  const testsArr = data.tests ?? [];
  const filesArr = data.files ?? [];
  const acceptanceTestRef = data.acceptanceTestRef;

  // No implements or empty implements → orphan task
  if (implementsArr.length === 0) {
    let updatedOrphans = [...state.orphanTasks, data.taskId];
    if (updatedOrphans.length > MAX_ORPHAN_TASKS) {
      updatedOrphans = updatedOrphans.slice(updatedOrphans.length - MAX_ORPHAN_TASKS);
    }
    return {
      ...state,
      _completedTaskIds: completedTaskIds,
      orphanTasks: updatedOrphans,
      acceptanceTestCoverage: computeAcceptanceTestCoverage(
        state.requirements,
        new Set(completedTaskIds),
      ),
    };
  }

  // Update requirements for each implemented requirement ID
  let updatedRequirements = [...state.requirements] as RequirementStatus[];
  for (const reqId of implementsArr) {
    updatedRequirements = upsertRequirement(
      updatedRequirements,
      reqId,
      data.taskId,
      testsArr,
      filesArr,
      acceptanceTestRef,
    );
  }

  const completedSet = new Set(completedTaskIds);

  return {
    ...state,
    _completedTaskIds: completedTaskIds,
    requirements: updatedRequirements,
    coverage: computeCoverage(updatedRequirements),
    acceptanceTestCoverage: computeAcceptanceTestCoverage(updatedRequirements, completedSet),
  };
}

// ─── Projection ────────────────────────────────────────────────────────────

export const provenanceProjection: ViewProjection<ProvenanceViewState> = {
  init(): ProvenanceViewState {
    return {
      featureId: '',
      requirements: [],
      coverage: 0,
      acceptanceTestCoverage: 0,
      orphanTasks: [],
      _completedTaskIds: [],
    };
  },

  apply(state: ProvenanceViewState, event: WorkflowEvent): ProvenanceViewState {
    switch (event.type) {
      case 'workflow.started':
        return handleWorkflowStarted(state, event);

      case 'task.completed':
        return handleTaskCompleted(state, event);

      default:
        return state;
    }
  },
};
