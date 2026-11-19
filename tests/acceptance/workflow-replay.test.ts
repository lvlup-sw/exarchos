/**
 * The replay of one settled feature stream into a fresh store keeps its rows, its fold and its settlement facts.
 *
 * A walk through the real dispatcher makes the stream once, with the shipped defaults. The test copies the stream with
 * the test-only replay helper into a bare event store on a scratch directory. It compares the rows, the idempotency claims,
 * the bundles and the folds of the two stores. It compares the fold and the settlement facts of the copy with what the walk did.
 *
 * This is a row-fidelity check of the fold, not a re-judgement. The record holds no observed tree and no gate run.
 * Two cases make a comparison fail on purpose, so neither comparison passes on equal empty inputs.
 * The guard-input shadow compares each transition of the walk, and the case reads its counts around the walk.
 *
 * @oracle-sources: ../helpers/replay/settled-feature-walk.ts, the settlement facts that the test builds from the receipts of the walk alone
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkRunBundleIntegrity } from '../../src/events/bundle/integrity.js';
import { ExecutionSettledData, WorkflowPreparedData, type WorkflowEvent } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import { guardInputShadowCounts, type GuardInputShadowCounts } from '../../src/projections/guard-input/shadow.js';
import { canonicalPath, normalizedPath } from '../../src/utils/git-tree.js';
import { resolveWorkflowState, type ResolveResult } from '../../src/verbs/resolve-state.js';
import { SETTLEMENT_OUTCOME_RULES } from '../../src/verbs/settle/adjudicate.js';
import { decodeSettlementBundle, type SettlementBundleV1 } from '../../src/verbs/settle/settlement-bundle.js';
import { settlementFactsOf, type SettlementFacts } from '../../src/verbs/settle/settlement-reads.js';
import { defaultProcessCapabilityIds } from '../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import {
  walkRepository,
  walkSettledFeature,
  type SettledFeatureWalk,
  type WalkSettlement,
} from '../helpers/replay/settled-feature-walk.js';
import { copyWorkflowStream, type CopiedStream } from '../helpers/replay/workflow-replay.js';

/** The walk runs three static-analysis segments in real git worktrees, so the hook sets its own timeout. */
const WALK_TIMEOUT_MS = 120_000;

/** The three facts that the test compares. The test pins `cited` empty, and it compares no cited fact. */
type ComparedFacts = Pick<SettlementFacts, 'completed' | 'completedTrees' | 'revisions'>;

/** One difference between two lists of facts: the receipt in walk order from 1, the field and the task. */
interface FactDifference {
  readonly receipt: number;
  readonly field: 'completed' | 'completedTrees' | 'revisions';
  readonly task: string;
}

/** The facts of a receipt that one side does not hold. */
const NO_FACTS: ComparedFacts = { completed: new Set(), completedTrees: new Map(), revisions: new Map() };

/** Each resource that the hook makes, so the teardown can release it in reverse order. */
const cleanup: (() => Promise<void> | void)[] = [];

let walk: SettledFeatureWalk;
let source: EventStore;
let target: EventStore;
let copied: CopiedStream;
let sourceRows: WorkflowEvent[];
let targetRows: WorkflowEvent[];
let walkStateDir: string;
let shadowCountsOfTheWalk: GuardInputShadowCounts;

beforeAll(async () => {
  const stateDir = makeTempDir('workflow-replay-source-');
  walkStateDir = stateDir;
  cleanup.push(() => rmrfAsync(stateDir));
  const targetDir = makeTempDir('workflow-replay-target-');
  cleanup.push(() => rmrfAsync(targetDir));
  const repository = await walkRepository();
  cleanup.push(() => rmrfAsync(repository.root));

  const shadowBefore = guardInputShadowCounts();
  walk = await walkSettledFeature(stateDir, repository);
  const shadowAfter = guardInputShadowCounts();
  shadowCountsOfTheWalk = {
    compared: shadowAfter.compared - shadowBefore.compared,
    disagreeing: shadowAfter.disagreeing - shadowBefore.disagreeing,
    failed: shadowAfter.failed - shadowBefore.failed,
  };
  source = walk.context.eventStore;
  cleanup.push(() => {
    source.close();
    walk.context.storage?.close();
  });
  target = new EventStore(targetDir);
  await target.initialize();
  cleanup.push(() => target.close());

  copied = await copyWorkflowStream(source, target, walk.streamId);
  sourceRows = await source.query(walk.streamId);
  targetRows = await target.query(walk.streamId);
}, WALK_TIMEOUT_MS);

afterAll(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Each field of a row except its event id, which the appender of each store assigns. */
function withoutEventId(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (key !== 'eventId') fields[key] = value;
  return fields;
}

/** Whether a row is the emissions gate row that the telemetry wrapper appends. */
function isEmissionRow(row: WorkflowEvent): boolean {
  return row.type === 'gate.executed' && row.data?.gateName === 'event-emissions';
}

/** The state of a fold. A fold that throws returns an error and no state, so it fails here. */
function stateOf(result: ResolveResult): Record<string, unknown> {
  if ('error' in result) throw new Error(`the fold returned no state: ${result.error.error?.message ?? 'no message'}`);
  return result.state;
}

/** The status of one task in a folded state. */
function taskStatus(state: Readonly<Record<string, unknown>>, taskId: string): unknown {
  const tasks: readonly unknown[] = Array.isArray(state.tasks) ? state.tasks : [];
  const entry = tasks.find((task) => isRecord(task) && task.id === taskId);
  return isRecord(entry) ? entry.status : undefined;
}

/** The worktree path that the walk claimed for a task. */
function claimedTree(taskId: string): string {
  const tree = walk.claimedTrees.get(taskId);
  if (tree === undefined) throw new Error(`the walk claimed no tree for ${taskId}`);
  return tree;
}

/** The settlement bundle of one receipt: the bundle that its `execution.settled` row names, read from one store. */
async function settlementBundleOf(store: EventStore, rows: readonly WorkflowEvent[], settlement: WalkSettlement): Promise<SettlementBundleV1> {
  const record = rows.find((row) => row.type === 'execution.settled' && row.sequence === settlement.tailSequence);
  if (record === undefined) throw new Error(`no settlement record ends at sequence ${settlement.tailSequence}`);
  const ref = ExecutionSettledData.parse(record.data).bundleRefs[0];
  if (ref === undefined) throw new Error(`the settlement record at sequence ${record.sequence} names no bundle`);
  return decodeSettlementBundle(await store.bundleStore.resolve(ref.digest));
}

/**
 * The facts that the copy folds for each receipt. The rows end at the tail of the receipt. The pin is the copied
 * prepared record of the capsule of the receipt. The cited evidence is the evidence of the claims of its bundle.
 */
async function copiedFactsOf(): Promise<SettlementFacts[]> {
  const facts: SettlementFacts[] = [];
  for (const settlement of walk.settlements) {
    const pinned = targetRows.find(
      (row) => row.type === 'workflow.prepared' && WorkflowPreparedData.parse(row.data).capsuleVersion === settlement.capsuleVersion,
    );
    if (pinned === undefined) throw new Error(`the copy holds no prepared record of capsule v${settlement.capsuleVersion}`);
    const bundle = await settlementBundleOf(target, targetRows, settlement);
    const cited = bundle.claims.flatMap((claim) => claim.evidence.map(({ kind, ref }) => ({ kind, ref })));
    const rows = targetRows.filter((row) => row.sequence <= settlement.tailSequence);
    facts.push(settlementFactsOf(rows, { pinnedSequence: pinned.sequence, cited }));
  }
  return facts;
}

/**
 * The facts of each receipt, built from the walk alone. `completed` is the union of the accepted tasks of each receipt
 * up to this one whose outcome verifies. `revisions` maps each task of the deviation to the next design version of a
 * revision of the same capsule.
 */
function expectedFactsOf(): ComparedFacts[] {
  return walk.settlements.map((settlement, index) => {
    const upTo = walk.settlements.slice(0, index + 1);
    const completed = new Set(upTo.filter((s) => SETTLEMENT_OUTCOME_RULES[s.outcome].verifies).flatMap((s) => s.acceptedTasks));
    const completedTrees = new Map(
      [...completed].map((taskId): [string, string] => [taskId, normalizedPath(canonicalPath(claimedTree(taskId)))]),
    );
    const revisions = new Map<string, number>();
    for (const earlier of upTo) {
      if (earlier.capsuleVersion !== settlement.capsuleVersion || earlier.designRevision === undefined) continue;
      for (const taskId of walk.deviationTasks) revisions.set(taskId, earlier.designRevision.nextDesignVersion);
    }
    return { completed, completedTrees, revisions };
  });
}

/** The count of entries of each compared field over every receipt. */
function entryCounts(facts: readonly ComparedFacts[]): Record<FactDifference['field'], number> {
  const counts = { completed: 0, completedTrees: 0, revisions: 0 };
  for (const fact of facts) {
    counts.completed += fact.completed.size;
    counts.completedTrees += fact.completedTrees.size;
    counts.revisions += fact.revisions.size;
  }
  return counts;
}

/** The tasks that either of two maps or sets holds, sorted. */
function tasksOf(left: Iterable<string>, right: Iterable<string>): string[] {
  return [...new Set([...left, ...right])].sort();
}

/** Each task that one side holds and the other does not, and each task whose value differs, for each receipt and field. */
function factsDiff(actual: readonly ComparedFacts[], expected: readonly ComparedFacts[]): FactDifference[] {
  const differences: FactDifference[] = [];
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    const left = actual[index] ?? NO_FACTS;
    const right = expected[index] ?? NO_FACTS;
    const receipt = index + 1;
    for (const task of tasksOf(left.completed, right.completed)) {
      if (left.completed.has(task) !== right.completed.has(task)) differences.push({ receipt, field: 'completed', task });
    }
    for (const task of tasksOf(left.completedTrees.keys(), right.completedTrees.keys())) {
      if (left.completedTrees.get(task) !== right.completedTrees.get(task)) differences.push({ receipt, field: 'completedTrees', task });
    }
    for (const task of tasksOf(left.revisions.keys(), right.revisions.keys())) {
      if (left.revisions.get(task) !== right.revisions.get(task)) differences.push({ receipt, field: 'revisions', task });
    }
  }
  return differences;
}

/** The facts with one receipt changed. */
function withReceipt(facts: readonly ComparedFacts[], receipt: number, change: (fact: ComparedFacts) => ComparedFacts): ComparedFacts[] {
  return facts.map((fact, index) => (index === receipt - 1 ? change(fact) : fact));
}

/** The custody sweep of one store over the walk stream alone. The source store also holds the telemetry stream. */
function sweep(store: EventStore): ReturnType<typeof checkRunBundleIntegrity> {
  return checkRunBundleIntegrity({ listStreams: () => [walk.streamId], query: (streamId) => store.query(streamId) }, store.bundleStore);
}

describe('WorkflowReplay', () => {
  /** The denominator of the copy: the walk leaves each ledger kind, three settlements and the first one held. */
  it('WorkflowReplay_TheSettledStream_HoldsEachLedgerKind', () => {
    const types = sourceRows.map((row) => row.type);
    for (const type of ['workflow.started', 'state.patched', 'workflow.transition', 'deviation.proposed', 'deviation.decided']) {
      expect(types, type).toContain(type);
    }
    for (const type of ['design.revised', 'capsule.recompiled', 'task.completed', 'gate.executed']) expect(types, type).toContain(type);
    expect(types.filter((type) => type === 'workflow.prepared')).toHaveLength(2);
    const outcomes = sourceRows
      .filter((row) => row.type === 'execution.settled')
      .map((row) => ExecutionSettledData.parse(row.data).outcome);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toBe('deviation-pending');
  });

  /**
   * The guard-input shadow compares two of the three transitions of the walk, and the fold and the document agree on each one.
   * The settle of the walk moves the phase to the target of the last transition, so that call is idempotent and the shadow skips it.
   */
  it('WorkflowReplay_TheWalk_ComparesEachTransitionAndRecordsNoDisagreement', () => {
    expect(walk.transitions).toHaveLength(3);
    expect(shadowCountsOfTheWalk).toEqual({ compared: 2, disagreeing: 0, failed: 0 });
    expect(existsSync(path.join(walkStateDir, 'guard-input-diagnostics'))).toBe(false);
  });

  /** The composition root keeps the state document in the `workflow_state` row, and the walk leaves no file form of it. */
  it('WorkflowReplay_TheWalk_KeepsTheStateDocumentInTheWorkflowStateRow', () => {
    const storage = walk.context.storage;
    expect(storage).toBeDefined();
    expect(storage?.getState(walk.streamId) ?? null).not.toBeNull();
    expect(walk.stateDocumentFiles).toEqual([]);
  });

  /** The walk calls as an MCP session and keeps the capability grant of the composition root. */
  it('WorkflowReplay_TheWalk_CallsAsAnMcpSessionWithTheDefaultGrant', () => {
    expect(walk.context.callerIdentity?.kind).toBe('mcp-session');
    const granted = [...(walk.context.capabilityResolver?.list() ?? [])].sort();
    expect(granted.length).toBeGreaterThan(0);
    expect(granted).toEqual([...defaultProcessCapabilityIds()].sort());
  });

  /** Each target row deep-equals its source row with the event id removed, in the same sequence. */
  it('WorkflowReplay_TheCopy_HoldsTheSameRowsInTheSameSequences', () => {
    expect(sourceRows.length).toBeGreaterThan(0);
    expect(targetRows.length).toBeGreaterThan(0);
    expect(copied.rows.map((row) => row.sequence)).toEqual(sourceRows.map((row) => row.sequence));
    expect(targetRows.map(withoutEventId)).toEqual(sourceRows.map(withoutEventId));
  });

  /** A copy through the unkeyed append keeps each row equal and writes no claim, so this case reads each claim directly. */
  it('WorkflowReplay_EachKeyOfTheWalk_HasTheSameIdempotencyClaimInBothStores', () => {
    const keys = [...new Set(sourceRows.flatMap((row) => (row.idempotencyKey === undefined ? [] : [row.idempotencyKey])))];
    expect(keys.length).toBeGreaterThan(0);
    const sourceBackend = source.getAppender().ensureSqliteBackendSync();
    const targetBackend = target.getAppender().getSqliteBackend();
    const unmatched = keys.filter((key) => {
      const original = sourceBackend.lookupIdempotencyClaim(walk.streamId, key);
      const copy = targetBackend?.lookupIdempotencyClaim(walk.streamId, key);
      return original === undefined || copy === undefined || JSON.stringify(copy.sequences) !== JSON.stringify(original.sequences);
    });
    expect(unmatched).toEqual([]);
  });

  /** The walk waits for the late writer, so the stream that the copy reads holds each emission row and no later row. */
  it('WorkflowReplay_TheWalk_ReturnsAfterTheEmissionRowOfEachCall', async () => {
    expect(walk.emissionCalls).toBeGreaterThan(0);
    const rows = await source.query(walk.streamId);
    expect(rows.filter(isEmissionRow)).toHaveLength(walk.emissionCalls);
    expect(rows[rows.length - 1]?.sequence).toBe(walk.finalTail);
  });

  /** A fold that throws returns no state, so each side must return a state before any comparison of folds. */
  it('WorkflowReplay_BothFolds_ReturnAState', async () => {
    const fromSource = await resolveWorkflowState({ featureId: walk.streamId, eventStore: source });
    const fromTarget = await resolveWorkflowState({ featureId: walk.streamId, eventStore: target });
    expect('state' in fromSource).toBe(true);
    expect('state' in fromTarget).toBe(true);
  });

  /** Equal rows give equal folds. The replay acceptance names the projection, so the case stays as a twin of the row case. */
  it('WorkflowReplay_TheCopy_FoldsToTheSameProjection', async () => {
    const fromSource = stateOf(await resolveWorkflowState({ featureId: walk.streamId, eventStore: source }));
    const fromTarget = stateOf(await resolveWorkflowState({ featureId: walk.streamId, eventStore: target }));
    expect(fromTarget).toEqual(fromSource);
  });

  /** The fold of the copy ends in the target of the last transition, and each task that a verifying receipt accepted is complete. */
  it('WorkflowReplay_TheCopy_FoldsToThePhaseAndTasksThatTheWalkSaw', async () => {
    const state = stateOf(await resolveWorkflowState({ featureId: walk.streamId, eventStore: target }));
    expect(walk.transitions).toEqual(['plan-review', 'delegate', 'review']);
    expect(state.phase).toBe(walk.transitions[walk.transitions.length - 1]);
    const verified = walk.settlements.filter((s) => SETTLEMENT_OUTCOME_RULES[s.outcome].verifies).flatMap((s) => s.acceptedTasks);
    expect([...verified].sort()).toEqual([...walk.tasks].sort());
    expect(verified.map((taskId) => [taskId, taskStatus(state, taskId)])).toEqual(verified.map((taskId) => [taskId, 'complete']));
  });

  /** The expected facts hold 11 entries only when the held receipt adds none, so the counts fail on a rule without that skip. */
  it('WorkflowReplay_TheFactsOfTheWalk_HoldElevenEntriesOverThreeReceipts', () => {
    const [first, second] = walk.tasks;
    const held = walk.settlements[0];
    expect(held?.outcome).toBe('deviation-pending');
    expect(held?.acceptedTasks).toEqual([first, second]);
    const expected = expectedFactsOf();
    expect(expected).toHaveLength(3);
    expect(entryCounts(expected)).toEqual({ completed: 5, completedTrees: 5, revisions: 1 });
    expect(entryCounts(expected.slice(0, 1))).toEqual({ completed: 0, completedTrees: 0, revisions: 0 });
    expect(walk.preparations.map((preparation) => preparation.designVersion)).toEqual(['design-v1', 'design-v2']);
  });

  /** The facts that the copy folds for each receipt equal the facts that the walk made, over the 11 expected entries. */
  it('WorkflowReplay_TheSettlementFactsOfTheCopy_EqualTheFactsOfTheWalk', async () => {
    const expected = expectedFactsOf();
    expect(entryCounts(expected)).toEqual({ completed: 5, completedTrees: 5, revisions: 1 });
    expect(factsDiff(await copiedFactsOf(), expected)).toEqual([]);
  });

  /** Each seeded change of the folded facts gives one difference, and the two stores still hold equal rows. */
  it('WorkflowReplay_ASeededFactDivergence_IsFoundWhileTheRowsStayEqual', async () => {
    const [first, , third] = walk.tasks;
    const actual = await copiedFactsOf();
    const expected = expectedFactsOf();
    expect(factsDiff(actual, expected)).toEqual([]);
    const seeds: { readonly seeded: ComparedFacts[]; readonly difference: FactDifference }[] = [
      {
        seeded: withReceipt(actual, 3, (fact) => ({ ...fact, completed: new Set([...fact.completed].filter((task) => task !== third)) })),
        difference: { receipt: 3, field: 'completed', task: third },
      },
      {
        seeded: withReceipt(actual, 3, (fact) => {
          const trees = new Map(fact.completedTrees);
          trees.set(first, normalizedPath(`${claimedTree(first)}-elsewhere`));
          return { ...fact, completedTrees: trees };
        }),
        difference: { receipt: 3, field: 'completedTrees', task: first },
      },
      {
        seeded: withReceipt(actual, 2, (fact) => {
          const revisions = new Map(fact.revisions);
          revisions.delete(third);
          return { ...fact, revisions };
        }),
        difference: { receipt: 2, field: 'revisions', task: third },
      },
    ];
    for (const { seeded, difference } of seeds) expect(factsDiff(seeded, expected), difference.field).toEqual([difference]);
    const sourceNow = await source.query(walk.streamId);
    const targetNow = await target.query(walk.streamId);
    expect(targetNow.length).toBeGreaterThan(0);
    expect(targetNow.map(withoutEventId)).toEqual(sourceNow.map(withoutEventId));
  });

  /** Each claim of the walk cites no evidence, so `cited` is empty. A later walk that cites evidence fails here. */
  it('WorkflowReplay_NoClaimOfTheWalk_CitesEvidence', async () => {
    let claims = 0;
    for (const settlement of walk.settlements) {
      const bundle = await settlementBundleOf(target, targetRows, settlement);
      claims += bundle.claims.length;
      expect(bundle.claims.flatMap((claim) => claim.evidence)).toEqual([]);
    }
    expect(claims).toBeGreaterThan(0);
    const facts = await copiedFactsOf();
    expect(facts).toHaveLength(walk.settlements.length);
    expect(facts.map((fact) => fact.cited.size)).toEqual(walk.settlements.map(() => 0));
  });

  /** The sweep over the walk stream finds each bundle in each store, with the same count of references. */
  it('WorkflowReplay_TheCopiedBundles_PassTheCustodySweepWithTheSameCount', async () => {
    const original = await sweep(source);
    const copy = await sweep(target);
    expect(original.ok).toBe(true);
    expect(copy.ok).toBe(true);
    const counted = (result: Awaited<ReturnType<typeof sweep>>): number => ('referenceCount' in result ? result.referenceCount : -1);
    expect(counted(original)).toBeGreaterThan(0);
    expect(counted(copy)).toBe(counted(original));
    expect(copied.digests.length).toBeGreaterThan(0);
  });

  /** Each settlement bundle decodes from the fresh store and equals the bundle of the source. */
  it('WorkflowReplay_EachSettlementBundle_DecodesFromTheFreshStore', async () => {
    expect(walk.settlements).toHaveLength(3);
    for (const settlement of walk.settlements) {
      const copy = await settlementBundleOf(target, targetRows, settlement);
      expect(copy).toEqual(await settlementBundleOf(source, sourceRows, settlement));
    }
  });

  /** A copy that ends before the last transition folds to `delegate`, so the projection comparison can fail. */
  it('WorkflowReplay_APrefixWithoutTheLastTransition_FoldsToAnotherPhase', async () => {
    const transitions = sourceRows.filter((row) => row.type === 'workflow.transition');
    const last = transitions[transitions.length - 1];
    if (last === undefined) throw new Error('the walk stream holds no transition row');
    const prefixDir = makeTempDir('workflow-replay-prefix-');
    const prefix = new EventStore(prefixDir);
    try {
      await prefix.initialize();
      const bound = last.sequence - 1;
      const partial = await copyWorkflowStream(source, prefix, walk.streamId, { throughSequence: bound });
      expect(partial.rows.length).toBe(bound);
      expect(stateOf(await resolveWorkflowState({ featureId: walk.streamId, eventStore: prefix })).phase).toBe('delegate');
      expect(stateOf(await resolveWorkflowState({ featureId: walk.streamId, eventStore: source })).phase).toBe('review');
    } finally {
      prefix.close();
      await rmrfAsync(prefixDir);
    }
  });

  /** The helper copies no operation claim, so a retry in the fresh store settles again. The case pins that reason. */
  it('WorkflowReplay_TheFreshStore_HoldsNoOperationClaim', () => {
    expect(walk.settlements).toHaveLength(3);
    const sourceBackend = source.getAppender().ensureSqliteBackendSync();
    const targetBackend = target.getAppender().ensureSqliteBackendSync();
    for (const settlement of walk.settlements) {
      expect(sourceBackend.lookupOperationClaim(settlement.operationId), settlement.batchId).toBeDefined();
      expect(targetBackend.lookupOperationClaim(settlement.operationId), settlement.batchId).toBeUndefined();
    }
  });
});
