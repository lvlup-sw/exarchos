import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const TEAM_PERFORMANCE_VIEW = 'team-performance';

// ─── View State ────────────────────────────────────────────────────────────

export interface TeammateMetrics {
  tasksCompleted: number;
  tasksFailed: number;
  avgDurationMs: number;
  totalDurationMs: number;
  moduleExpertise: string[];
  qualityGatePassRate: number;
}

export interface ModuleMetrics {
  avgTaskDurationMs: number;
  totalTasks: number;
  fixCycleRate: number;
  fixCycleCount: number;
}

interface TeamSizingState {
  avgTasksPerTeammate: number;
  dataPoints: number;
  /** Retained from last team.spawned for disbanded calculation. */
  lastSpawnTeamSize: number;
  lastSpawnTaskCount: number;
}

export interface TeamPerformanceViewState {
  teammates: Record<string, TeammateMetrics>;
  modules: Record<string, ModuleMetrics>;
  teamSizing: TeamSizingState;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Extract module name from a file path (first segment after src/). */
function extractModule(filePath: string): string | null {
  const match = filePath.match(/src\/([^/]+)/);
  return match ? match[1] : null;
}

/** Compute running average: newAvg = (oldAvg * (n-1) + newVal) / n */
function runningAverage(oldAvg: number, n: number, newVal: number): number {
  return (oldAvg * (n - 1) + newVal) / n;
}

/** Default teammate metrics for first encounter. */
function defaultTeammate(): TeammateMetrics {
  return {
    tasksCompleted: 0,
    tasksFailed: 0,
    avgDurationMs: 0,
    totalDurationMs: 0,
    moduleExpertise: [],
    qualityGatePassRate: 0,
  };
}

/** Default module metrics for first encounter. */
function defaultModule(): ModuleMetrics {
  return {
    avgTaskDurationMs: 0,
    totalTasks: 0,
    fixCycleRate: 0,
    fixCycleCount: 0,
  };
}

/** Get existing or default teammate entry. */
function getTeammate(
  teammates: Record<string, TeammateMetrics>,
  name: string,
): TeammateMetrics {
  return teammates[name] ?? defaultTeammate();
}

/** Extract unique module names from file paths. */
function extractModules(filesChanged: string[]): string[] {
  return [...new Set(
    filesChanged
      .map(extractModule)
      .filter((m): m is string => m !== null),
  )];
}

/** Calculate pass rate from completed and failed counts. */
function calcPassRate(completed: number, failed: number): number {
  const total = completed + failed;
  return total > 0 ? completed / total : 0;
}

// ─── Projection ────────────────────────────────────────────────────────────

export const teamPerformanceProjection: ViewProjection<TeamPerformanceViewState> = {
  init: () => ({
    teammates: {},
    modules: {},
    teamSizing: {
      avgTasksPerTeammate: 0,
      dataPoints: 0,
      lastSpawnTeamSize: 0,
      lastSpawnTaskCount: 0,
    },
  }),

  apply: (view, event) => {
    switch (event.type) {
      case 'team.task.completed': {
        const data = event.data as {
          teammateName?: string;
          durationMs?: number;
          filesChanged?: string[];
        } | undefined;

        const name = data?.teammateName;
        if (!name) return view;

        const durationMs = data?.durationMs ?? 0;
        const filesChanged = data?.filesChanged ?? [];

        // Update teammate metrics
        const prev = getTeammate(view.teammates, name);
        const newCompleted = prev.tasksCompleted + 1;
        const newModules = extractModules(filesChanged);

        const updatedTeammate: TeammateMetrics = {
          tasksCompleted: newCompleted,
          tasksFailed: prev.tasksFailed,
          avgDurationMs: runningAverage(prev.avgDurationMs, newCompleted, durationMs),
          totalDurationMs: prev.totalDurationMs + durationMs,
          moduleExpertise: [...new Set([...prev.moduleExpertise, ...newModules])],
          qualityGatePassRate: calcPassRate(newCompleted, prev.tasksFailed),
        };

        // Update module metrics
        const updatedModules = { ...view.modules };
        for (const mod of newModules) {
          const prevMod = updatedModules[mod] ?? defaultModule();
          const newTotal = prevMod.totalTasks + 1;
          updatedModules[mod] = {
            ...prevMod,
            avgTaskDurationMs: runningAverage(prevMod.avgTaskDurationMs, newTotal, durationMs),
            totalTasks: newTotal,
          };
        }

        return {
          ...view,
          teammates: { ...view.teammates, [name]: updatedTeammate },
          modules: updatedModules,
        };
      }

      case 'team.task.failed': {
        const data = event.data as { teammateName?: string } | undefined;
        const name = data?.teammateName;
        if (!name) return view;

        const prev = getTeammate(view.teammates, name);
        const newFailed = prev.tasksFailed + 1;

        return {
          ...view,
          teammates: {
            ...view.teammates,
            [name]: {
              ...prev,
              tasksFailed: newFailed,
              qualityGatePassRate: calcPassRate(prev.tasksCompleted, newFailed),
            },
          },
        };
      }

      case 'workflow.fix-cycle': {
        const data = event.data as { compoundStateId?: string } | undefined;
        const compoundStateId = data?.compoundStateId;
        if (!compoundStateId) return view;

        const moduleName = compoundStateId.split('-')[0];
        if (!moduleName) return view;

        const prevMod = view.modules[moduleName] ?? defaultModule();
        const newFixCount = prevMod.fixCycleCount + 1;
        const fixRate = prevMod.totalTasks > 0
          ? newFixCount / prevMod.totalTasks
          : newFixCount;

        return {
          ...view,
          modules: {
            ...view.modules,
            [moduleName]: { ...prevMod, fixCycleCount: newFixCount, fixCycleRate: fixRate },
          },
        };
      }

      case 'team.spawned': {
        const data = event.data as {
          teamSize?: number;
          taskCount?: number;
        } | undefined;

        return {
          ...view,
          teamSizing: {
            ...view.teamSizing,
            dataPoints: view.teamSizing.dataPoints + 1,
            lastSpawnTeamSize: data?.teamSize ?? 0,
            lastSpawnTaskCount: data?.taskCount ?? 0,
          },
        };
      }

      case 'team.disbanded': {
        const { lastSpawnTeamSize, lastSpawnTaskCount, dataPoints } = view.teamSizing;
        if (lastSpawnTeamSize === 0) return view;

        const tasksPerTeammate = lastSpawnTaskCount / lastSpawnTeamSize;
        const newAvg = dataPoints > 0
          ? runningAverage(view.teamSizing.avgTasksPerTeammate, dataPoints, tasksPerTeammate)
          : tasksPerTeammate;

        return {
          ...view,
          teamSizing: {
            ...view.teamSizing,
            avgTasksPerTeammate: newAvg,
          },
        };
      }

      default:
        return view;
    }
  },
};
