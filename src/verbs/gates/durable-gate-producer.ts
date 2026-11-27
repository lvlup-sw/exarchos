import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import {
  AdmissionEvidenceRecordedData,
  type AdmissionEvidenceRecorded,
  type EventType,
} from '../../events/schemas.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { evidenceArtifactStore } from '../../workflow/admission/evidence-artifact.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import type { EvidenceSubjectV1 } from '../../workflow/admission/types.js';
import { observeCurrentCheckout, type ProfiledGateArgs } from './gate-utils.js';
import { canonicalPath, observationalReader, processObservationalGitPath, type TreeObservation } from '../../utils/git-tree.js';
import { listObservedWorktrees, locateObservational } from '../../utils/git-observer.js';
import { resolveActivePhaseAttemptId } from '../tasks/active-phase-attempt.js';
import { resolveWorkflowState } from '../resolve-state.js';
import {
  closedListingCleanTree, HostedAdequacyPending, runGateWithEvidence, type GateRunTree,
} from './gate-runner.js';

export interface DurableGateScope {
  readonly coordinate?: ProfiledGateArgs['coordinate'];
  readonly gateClass:
    | 'static-analysis'
    | 'integration-suite'
    | 'contract-drift'
    | 'mock-boundary';
  readonly featureId: string;
  readonly taskId?: string;
  readonly branch?: string;
  readonly baseRef?: string;
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly eventStore: EventStore;
  /**
   * True when the run scans no directory, as a skip that the handler decides before any scan.
   * The producer then observes no directory, and the runner row names no tree.
   */
  readonly unscanned?: boolean;
}

/** The fields of a gate scope that select the evidence subject of a run. */
export type GateSubjectScope = Pick<
  DurableGateScope,
  'gateClass' | 'featureId' | 'taskId' | 'branch' | 'baseRef' | 'repoRoot'
>;

/**
 * The requirement id under which a ladder gate records its evidence.
 * It is exported so that a reader of a cited gate class, such as settlement, uses the same spelling as the producer.
 */
export function ladderRequirementId(gateClass: string): string {
  return `verification-ladder:${gateClass}`;
}

/** The event that records one evidence fact. */
const EVIDENCE_RECORDED_TYPE = 'admission.evidence-recorded' satisfies EventType;

/**
 * The gate evidence records of a list of stream rows, keyed by evidence id, in the order of the rows.
 * `rows` can hold rows of any type. A later row with the same evidence id replaces the earlier record.
 * A row that fails the evidence schema, or that is not a gate record, is not in the map.
 */
export function gateEvidenceRecordsOf(
  rows: readonly { readonly type: string; readonly data?: unknown }[],
): ReadonlyMap<string, AdmissionEvidenceRecorded> {
  const records = new Map<string, AdmissionEvidenceRecorded>();
  for (const row of rows) {
    if (row.type !== EVIDENCE_RECORDED_TYPE) continue;
    const parsed = AdmissionEvidenceRecordedData.safeParse(row.data);
    if (!parsed.success || parsed.data.evidence.kind !== 'gate') continue;
    records.set(parsed.data.evidence.evidenceId, parsed.data);
  }
  return records;
}

/**
 * The gate evidence records of one stream, keyed by evidence id, in the stream order of their rows.
 * A row that fails the evidence schema, or that is not a gate record, is not in the map.
 * Settlement and `task_complete` read gate evidence through this function, so the two readers parse the rows in one way.
 * The function selects nothing. Superseded and failing records stay in the map, and each reader applies its own rule.
 */
export async function readGateEvidenceRecords(
  eventStore: Pick<EventStore, 'query'>,
  streamId: string,
): Promise<ReadonlyMap<string, AdmissionEvidenceRecorded>> {
  return gateEvidenceRecordsOf(await eventStore.query(streamId, { type: EVIDENCE_RECORDED_TYPE }));
}

function scopeError(code: string, message: string): ToolResult {
  return { success: false, error: { code, message } };
}

/**
 * Uses the same resolver as the phase-gate adapter in `gate-runner`.
 * A workflow with no phase-attempt stamp thus gets a derived attempt id, not an error.
 */
async function activePhaseAttemptId(
  featureId: string,
  eventStore: EventStore,
): Promise<string | ToolResult> {
  const resolved = await resolveWorkflowState({ featureId, eventStore });
  if ('error' in resolved) return resolved.error;
  return resolveActivePhaseAttemptId(featureId, resolved.state);
}

function fallbackArtifactId(scope: GateSubjectScope, phaseAttemptId: string): string {
  const digest = createHash('sha256')
    .update(
      [
        scope.featureId,
        scope.gateClass,
        phaseAttemptId,
        scope.repoRoot,
      ].join('\0'),
      'utf8',
    )
    .digest('hex');
  return `gate-target:${digest}`;
}

/**
 * Selects the immutable proof target. A run with a `taskId` binds to a task subject.
 * Other runs bind to `observedHead`, the head commit that the producer observed once through the constrained reader.
 * With no observed head, they bind to an artifact target. The function reads no Git.
 * Mutable workflow state is not a commit, so the producer never uses it as one.
 *
 * The task_complete reader and the static-analysis seed of the tests also derive a subject here.
 */
export function selectSubject(
  scope: GateSubjectScope,
  phaseAttemptId: string,
  observedHead?: string,
): EvidenceSubjectV1 {
  const target = {
    gateClass: scope.gateClass,
    ...(scope.branch ? { branch: scope.branch } : {}),
    ...(scope.baseRef ? { diffBase: scope.baseRef } : {}),
  };
  if (scope.taskId) {
    return createEvidenceSubject(
      { kind: 'task', taskId: scope.taskId },
      target,
    );
  }

  if (observedHead !== undefined && observedHead.length > 0) {
    return createEvidenceSubject({ kind: 'commit', commitId: observedHead }, target);
  }
  return createEvidenceSubject(
    {
      kind: 'artifact',
      artifactId: fallbackArtifactId(scope, phaseAttemptId),
    },
    target,
  );
}

/**
 * The tree stamp of one git observation of a directory.
 * A git work tree gives its canonical root and its HEAD commit. A directory outside git gives its canonical path with no head.
 * A path that does not exist keeps its lexical form. An unobservable directory gives no stamp.
 * `task_complete` stamps the tree that a completion names with this rule, so it compares two stamps of one form.
 */
export function treeStampOf(observed: TreeObservation): GateRunTree | undefined {
  switch (observed.kind) {
    case 'tree':
      return {
        worktree: observed.toplevel,
        ...(observed.head === undefined ? {} : { head: observed.head }),
      };
    case 'no-work-tree':
      return { worktree: observed.path };
    case 'unobservable':
      return undefined;
  }
}

/**
 * The tree stamp of a gate run in `repoRoot`, from one constrained observation of that directory, by the rule of {@link treeStampOf}.
 * When the constrained reader cannot observe the directory, the run stamps no tree.
 * The static-analysis seed of the tests stamps its tree here too, so a seeded row names a tree as a real run does.
 */
export async function scannedTree(repoRoot: string): Promise<GateRunTree | undefined> {
  return treeStampOf(await constrainedTreeObservation(repoRoot));
}

/**
 * One constrained observation of the directory of a gate run, with the process-wide Git path. It runs no status and no checkout filter.
 * A directory that no checkout holds gives its canonical path. A registered branch checkout gives its canonical root, and an unborn branch gives no head.
 * A detached, unregistered or refused checkout is unobservable, so it gives no stamp and no head.
 */
async function constrainedTreeObservation(repoRoot: string): Promise<TreeObservation> {
  const observation = await locateObservational(repoRoot, observationalReader());
  if (observation.kind === 'absent') return { kind: 'no-work-tree', path: canonicalPath(repoRoot) };
  if (observation.kind === 'unreadable') return { kind: 'unobservable', cause: observation.reason };
  const { located } = observation;
  try {
    const matching = [];
    for (const record of await listObservedWorktrees(located)) {
      if (await realpath(record.path).catch(() => undefined) === located.checkout) matching.push(record);
    }
    const record = matching[0];
    if (matching.length !== 1 || record === undefined || record.bare || record.prunable || record.detached || record.branch === undefined) {
      return { kind: 'unobservable', cause: 'The checkout is not one registered branch checkout.' };
    }
    return {
      kind: 'tree',
      toplevel: canonicalPath(located.checkout),
      repository: canonicalPath(located.repository),
      branch: record.branch,
      ...(record.head === undefined ? {} : { head: record.head }),
    };
  } catch (error) {
    return { kind: 'unobservable', cause: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Canonical audit/shadow producer boundary for the migrated ladder handlers.
 * The provider carrier is returned byte-for-byte except for additive evidence
 * references, and no success carrier escapes before the durable append.
 * The run observes `repoRoot` once before the gate runs. That one observation gives the commit subject of a run with no `taskId` and the tree of the runner row.
 * A scope that marks the run `unscanned` stamps no tree, and it observes the directory only for the subject of a run with no `taskId`.
 * A coordinate run with a `taskId` observes only the selected checkout.
 *
 * On every route, a phase attempt that changed during the provider leaves the run pending, and no evidence is recorded.
 */
export async function runDurableGateProducer(
  scope: DurableGateScope,
  executeProvider: (phaseAttemptId: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  const context = getDispatchContext();
  if (context?.authorization === undefined) {
    return scopeError(
      'TRUSTED_CALLER_REQUIRED',
      'runGate requires trusted dispatch caller identity.',
    );
  }

  const activeAttempt = await activePhaseAttemptId(
    scope.featureId,
    scope.eventStore,
  );
  if (typeof activeAttempt !== 'string') return activeAttempt;

  const observeScanned = !scope.taskId || (scope.coordinate === undefined && scope.unscanned !== true);
  const observed = observeScanned ? await constrainedTreeObservation(scope.repoRoot) : undefined;
  let subject: EvidenceSubjectV1;
  try {
    subject = selectSubject(scope, activeAttempt, observed?.kind === 'tree' ? observed.head : undefined);
  } catch (error) {
    return scopeError(
      'INVALID_GATE_SCOPE',
      error instanceof Error ? error.message : String(error),
    );
  }

  const selected = scope.coordinate === undefined ? undefined : await observeSelectedCheckout(scope.repoRoot, scope.coordinate);
  if (scope.coordinate !== undefined && selected === undefined) {
    return scopeError('TASK_COORDINATE_REFUSED', 'The selected checkout is unavailable, changed or dirty.');
  }
  const tree = selected ?? (scope.unscanned === true || observed === undefined ? undefined : treeStampOf(observed));
  return runGateWithEvidence(
    {
      streamId: scope.featureId,
      gateClass: scope.gateClass,
      phaseAttemptId: activeAttempt,
      requirementId: ladderRequirementId(scope.gateClass),
      subject,
      providerInput: {
        featureId: scope.featureId,
        ...(scope.taskId ? { taskId: scope.taskId } : {}),
        ...(scope.branch ? { branch: scope.branch } : {}),
        ...(scope.baseRef ? { baseRef: scope.baseRef } : {}),
      },
      ...(tree === undefined ? {} : { tree }),
    },
    {
      eventStore: scope.eventStore,
      artifactStore: evidenceArtifactStore(scope.stateDir),
      executeProvider: async () => {
        const result = await executeProvider(activeAttempt);
        if (await activePhaseAttemptId(scope.featureId, scope.eventStore) !== activeAttempt) {
          throw new HostedAdequacyPending('The active phase attempt changed during the gate run.');
        }
        if (scope.coordinate !== undefined && await observeSelectedCheckout(scope.repoRoot, scope.coordinate) === undefined) {
          return scopeError('TASK_COORDINATE_REFUSED', 'The provider changed the selected checkout.');
        }
        return result;
      },
    },
  );
}

/**
 * Observes the selected clean checkout through one constrained observer with the process-wide Git path. It runs no status and no checkout filter.
 * The common dir must equal the coordinate repository, the root must equal the canonical `repoRoot`, and the head must equal the observed coordinate head.
 * That head must hold the coordinate base. Then the closed listing clean-tree check runs against that head.
 * A detached checkout, a failed read, a failed listing, an unsupported entry or a tree beyond the bounds gives no tree.
 */
export async function observeSelectedCheckout(repoRoot: string, coordinate: NonNullable<ProfiledGateArgs['coordinate']>): Promise<GateRunTree | undefined> {
  const gitPath = processObservationalGitPath();
  if (gitPath === undefined) return undefined;
  const observed = await observeCurrentCheckout(gitPath, repoRoot);
  if (observed.kind === 'refused') return undefined;
  const { observer, checkout } = observed;
  const worktree = canonicalPath(checkout.checkout);
  if (canonicalPath(checkout.repository) !== coordinate.repository || checkout.head !== coordinate.observedHeadCommit
    || worktree !== canonicalPath(repoRoot)) return undefined;
  try {
    await observer.reads.ancestry(checkout.gitDir, checkout.checkout, coordinate.diffBaseCommit, checkout.head);
  } catch {
    return undefined;
  }
  return await closedListingCleanTree(observer.reads, checkout.gitDir, checkout.checkout, checkout.head)
    ? { worktree, head: checkout.head } : undefined;
}
