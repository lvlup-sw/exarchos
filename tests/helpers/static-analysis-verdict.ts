/**
 * Seeds the static-analysis verdict of one task as `check_static_analysis` records it.
 *
 * The seed runs the real gate runner with a provider that returns a fixed run outcome.
 * It takes the subject from `selectSubject` over the scope of the handler, and the carrier from the mapping of the handler.
 * Thus a seeded record has the subject and the carrier that a real run writes for the same task, branch and base.
 * The file is outside `src/`, because each emitter census reads a shipped append as a producer.
 */
import { deriveLocalOperatorIdentity, snapshotCallerAuthorization } from '../../src/dispatch/caller-identity.js';
import { mintDispatchContext, runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import type { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { ladderRequirementId, selectSubject } from '../../src/verbs/gates/durable-gate-producer.js';
import { runGate } from '../../src/verbs/gates/gate-runner.js';
import { staticAnalysisCarrier, staticAnalysisSubjectScope } from '../../src/verbs/gates/static-analysis.js';
import type { StaticAnalysisResult } from '../../src/verbs/pure/static-analysis.js';
import { evidenceArtifactStore } from '../../src/workflow/admission/evidence-artifact.js';
import { isolatedSync } from '../../tools/test-helpers/spawn.js';

/** The gate class that `task_complete` requires. */
const STATIC_ANALYSIS_GATE = 'static-analysis';

/**
 * The phase attempt of a seeded verdict when the test names none.
 * `task_complete` reads only the records of the phase attempt of the latest record of the task.
 */
const SEED_PHASE_ATTEMPT_ID = 'phase-attempt:static-analysis-seed';

/**
 * The state directory that the seed producer identity derives from. It is fixed, so two stores
 * seeded in one test hold the same producer, and no file is read or written there.
 */
const SEED_OPERATOR_STATE_DIR = '/exarchos/static-analysis-seed';

/** A run outcome in the shape of `runStaticAnalysis`. The seed fills the counts and the report that the test leaves out. */
export type StaticAnalysisSeedOutcome = Pick<StaticAnalysisResult, 'status'> & Partial<StaticAnalysisResult>;

/**
 * One seeded verdict. The evidence artifact store is under `stateDir`.
 * `verdict` is a short form of a passing or failing `outcome`. Give one of the two, or neither for a pass.
 *
 * The subject derives from `taskId`, `branch` and `baseBranch` as the handler derives it, with the base `main` by default.
 * With no `taskId`, the subject is the commit at `repoRoot`, or an artifact when `repoRoot` holds no commit.
 * `phaseAttemptId` sets the phase attempt of the run. A run supersedes only an earlier run of its own phase attempt.
 * `operationId` runs the seed under a fixed dispatch operation, as a retry of one dispatch does.
 * `earlierBuildCarrier` gives the carrier of an earlier build, which set no skip `discriminant` and no skip `reason`.
 */
export interface StaticAnalysisVerdictSeed {
  readonly streamId: string;
  readonly taskId?: string;
  readonly stateDir: string;
  readonly verdict?: 'pass' | 'fail';
  readonly outcome?: StaticAnalysisSeedOutcome;
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly repoRoot?: string;
  readonly phaseAttemptId?: string;
  readonly operationId?: string;
  readonly earlierBuildCarrier?: boolean;
}

/** The full run outcome of a seed, with a counted check for the status and a short report. */
function seedOutcome(seed: StaticAnalysisVerdictSeed): StaticAnalysisResult {
  if (seed.verdict !== undefined && seed.outcome !== undefined) {
    throw new Error('static-analysis seed: give verdict or outcome, not both');
  }
  const outcome: StaticAnalysisSeedOutcome = seed.outcome ?? { status: seed.verdict ?? 'pass' };
  return {
    passCount: outcome.status === 'pass' ? 1 : 0,
    failCount: outcome.status === 'fail' ? 1 : 0,
    skipCount: outcome.status === 'skip' ? 1 : 0,
    output: `## Static Analysis Report\n\n**Result: ${outcome.status.toUpperCase()}** (seeded)`,
    ...outcome,
  };
}

/** The carrier of an earlier build. It drops the skip `discriminant` and the skip `reason`, which that build did not set. */
function earlierBuildCarrier(carrier: ToolResult): ToolResult {
  const data = carrier.data;
  if (typeof data !== 'object' || data === null) return carrier;
  const kept = Object.entries(data).filter(([key]) => key !== 'discriminant' && key !== 'reason');
  return { ...carrier, data: Object.fromEntries(kept) };
}

/** The evidence id in the carrier of the runner, or undefined when the carrier holds none. */
function firstEvidenceId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const references: unknown = Reflect.get(data, 'evidenceReferences');
  if (!Array.isArray(references)) return undefined;
  const first: unknown = references[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const evidenceId: unknown = Reflect.get(first, 'evidenceId');
  return typeof evidenceId === 'string' ? evidenceId : undefined;
}

/**
 * Runs the gate runner for the static-analysis gate of the task, with a provider that gives the
 * carrier of the seeded outcome. Each call without `operationId` has a new operation id, so each
 * call appends a new evidence record and a new runner row. A record supersedes the active record of
 * the same subject and phase attempt, as in production. Returns the evidence id. The function throws
 * when the runner refuses or fails to persist.
 */
export async function seedStaticAnalysisVerdict(
  eventStore: Pick<EventStore, 'append' | 'query'>,
  seed: StaticAnalysisVerdictSeed,
): Promise<string> {
  const current = staticAnalysisCarrier(seedOutcome(seed));
  const carrier = seed.earlierBuildCarrier === true ? earlierBuildCarrier(current) : current;
  const phaseAttemptId = seed.phaseAttemptId ?? SEED_PHASE_ATTEMPT_ID;
  const scope = staticAnalysisSubjectScope(
    {
      featureId: seed.streamId,
      ...(seed.taskId === undefined ? {} : { taskId: seed.taskId }),
      ...(seed.branch === undefined ? {} : { branch: seed.branch }),
      ...(seed.baseBranch === undefined ? {} : { baseBranch: seed.baseBranch }),
    },
    seed.repoRoot ?? seed.stateDir,
  );
  const authorization = snapshotCallerAuthorization(
    deriveLocalOperatorIdentity(SEED_OPERATOR_STATE_DIR),
    undefined,
  );
  const minted = mintDispatchContext(undefined, authorization);
  const context = seed.operationId === undefined ? minted : { ...minted, operationId: seed.operationId };
  const subject = await isolatedSync(() => selectSubject(scope, phaseAttemptId));
  const result = await runWithDispatchContext(context, () =>
    runGate(
      {
        streamId: seed.streamId,
        gateClass: STATIC_ANALYSIS_GATE,
        phaseAttemptId,
        requirementId: ladderRequirementId(STATIC_ANALYSIS_GATE),
        subject,
        providerInput: {
          featureId: seed.streamId,
          ...(seed.taskId === undefined ? {} : { taskId: seed.taskId }),
          ...(seed.branch === undefined ? {} : { branch: seed.branch }),
          baseRef: scope.baseRef,
        },
      },
      {
        eventStore,
        artifactStore: evidenceArtifactStore(seed.stateDir),
        executeProvider: async () => carrier,
      },
    ),
  );
  const evidenceId = firstEvidenceId(result.data);
  if (!result.success || evidenceId === undefined) {
    throw new Error(`static-analysis seed refused: ${JSON.stringify(result.error ?? result.data)}`);
  }
  return evidenceId;
}
