/**
 * Seeds the static-analysis verdict of one task as `check_static_analysis` records it.
 *
 * The seed runs the real gate runner with a stub provider. Thus the evidence record and the
 * runner-owned `gate.executed` row have the production shape, and the shape cannot drift.
 * The file is outside `src/`, because each emitter census reads a shipped append as a producer.
 */
import type { EventStore } from '../../src/events/store.js';
import { ladderRequirementId } from '../../src/verbs/gates/durable-gate-producer.js';
import { runGate } from '../../src/verbs/gates/gate-runner.js';
import { evidenceArtifactStore } from '../../src/workflow/admission/evidence-artifact.js';
import { createEvidenceSubject } from '../../src/workflow/admission/evidence-subject.js';
import { runAsTrustedCaller } from '../../tools/test-helpers/trusted-context.js';

/** The gate class that `task_complete` requires. */
const STATIC_ANALYSIS_GATE = 'static-analysis';

/** The phase attempt of a seeded verdict when the test names none. `task_complete` does not read it. */
const SEED_PHASE_ATTEMPT_ID = 'phase-attempt:static-analysis-seed';

/**
 * The state directory that the seed producer identity derives from. It is fixed, so two stores
 * seeded in one test hold the same producer, and no file is read or written there.
 */
const SEED_OPERATOR_STATE_DIR = '/exarchos/static-analysis-seed';

/** The commit of a seeded run that names no task. */
const SEED_COMMIT_ID = 'c'.repeat(40);

/**
 * One seeded verdict. The evidence artifact store is under `stateDir`.
 * With no `taskId`, the subject is a commit, as for a run of `check_static_analysis` with no `taskId`.
 */
export interface StaticAnalysisVerdictSeed {
  readonly streamId: string;
  readonly taskId?: string;
  readonly stateDir: string;
  readonly verdict?: 'pass' | 'fail';
  readonly phaseAttemptId?: string;
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
 * requested verdict. Each call has a new operation id, so each call appends a new evidence record
 * and a new runner row. Returns the evidence id. The function throws when the runner refuses.
 */
export async function seedStaticAnalysisVerdict(
  eventStore: Pick<EventStore, 'append' | 'query'>,
  seed: StaticAnalysisVerdictSeed,
): Promise<string> {
  const passed = (seed.verdict ?? 'pass') === 'pass';
  const result = await runAsTrustedCaller(SEED_OPERATOR_STATE_DIR, () =>
    runGate(
      {
        streamId: seed.streamId,
        gateClass: STATIC_ANALYSIS_GATE,
        phaseAttemptId: seed.phaseAttemptId ?? SEED_PHASE_ATTEMPT_ID,
        requirementId: ladderRequirementId(STATIC_ANALYSIS_GATE),
        subject: createEvidenceSubject(
          seed.taskId === undefined
            ? { kind: 'commit', commitId: SEED_COMMIT_ID }
            : { kind: 'task', taskId: seed.taskId },
          { gateClass: STATIC_ANALYSIS_GATE },
        ),
        providerInput: {
          featureId: seed.streamId,
          ...(seed.taskId === undefined ? {} : { taskId: seed.taskId }),
        },
      },
      {
        eventStore,
        artifactStore: evidenceArtifactStore(seed.stateDir),
        executeProvider: async () => ({ success: true, data: { passed } }),
      },
    ),
  );
  const evidenceId = firstEvidenceId(result.data);
  if (!result.success || evidenceId === undefined) {
    throw new Error(`static-analysis seed refused: ${JSON.stringify(result.error ?? result.data)}`);
  }
  return evidenceId;
}
