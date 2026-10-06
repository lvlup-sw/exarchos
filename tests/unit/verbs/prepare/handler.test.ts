// `prepare` end to end, against a real event store and a real content-addressed
// bundle store in a temporary directory.
//
// No test of the pure compiler can check these facts. The record references bytes in custody,
// and those bytes read back as the capsule that the receipt returned. A retry gets its answer
// from the durable claim. Each refusal leaves the store unchanged.
//
// The continuation cases need a design revision on the stream. Each row comes from a real decision
// round of `settle`, because `settle` is the one writer of that row.
//
// @oracle-sources: ../../../../src/verbs/prepare/handler.ts, the prepared bundle read back out of the content-addressed store and re-digested rather than compared with the in-process capsule

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { resolveConfig, type ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import { capsuleDigest, contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import {
  ExarchosCapsuleV1Schema,
  type ExarchosCapsuleV1,
} from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { estimateOutputTokens } from '../../../../src/dispatch/core/economy.js';
import { enforceResponseEconomy } from '../../../../src/dispatch/core/response-economy.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import type { BundleRefV1 } from '../../../../src/events/bundle/digest-references.js';
import type { RunBundleStore } from '../../../../src/events/bundle/run-bundle-store.js';
import {
  CapsuleRecompiledData,
  DesignRevisedData,
  WorkflowPreparedData,
  type CapsuleRecompiled,
  type DesignRevised,
} from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { productionExecuteDeps } from '../../../../src/verbs/execute/executor.js';
import type { CatalogInvariant } from '../../../../src/verbs/prepare/bind-authority.js';
import { PREPARE_COMPILER_VERSION } from '../../../../src/verbs/prepare/compile-capsule.js';
import { PREPARE_ECONOMY_BUDGET_TOKENS } from '../../../../src/verbs/prepare/economy.js';
import { handlePrepare, planeExecutionCapabilities } from '../../../../src/verbs/prepare/handler.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import { commitPreparedCapsule, findPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { PREPARE_REFUSAL_CODES, type PreparedCapsuleReceipt } from '../../../../src/verbs/prepare/types.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import {
  decodeSettlementBundle,
  encodeSettlementBundle,
  type SettlementBundleV1,
} from '../../../../src/verbs/settle/settlement-bundle.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { initStateFile } from '../../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-prepare-unit';
const COMPILED_AT = '2026-09-12T00:00:00.000Z';
/** The capabilities of a runtime that can settle what it dispatches. The execution profile is a subset of them. */
const FIT_CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'subagent:spawn'];

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-unit-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

function correlation(capabilities: readonly string[] = FIT_CAPABILITIES): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'prepare-fixture' });
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(identity, createInMemoryResolver(capabilities)),
  );
}

async function prepare(
  raw: Record<string, unknown>,
  catalog: readonly CatalogInvariant[] = [],
  capabilities: readonly string[] = FIT_CAPABILITIES,
  projectConfig?: ResolvedProjectConfig,
): Promise<ToolResult> {
  const ctx = { ...wiring(), ...(projectConfig !== undefined ? { projectConfig } : {}) };
  return runWithDispatchContext(correlation(capabilities), () =>
    handlePrepare(raw, stateDir, ctx, { catalogInvariants: () => catalog, now: () => COMPILED_AT }),
  );
}

function receiptOf(result: ToolResult): PreparedCapsuleReceipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!result.success) throw new Error('unreachable');
  return result.data as unknown as PreparedCapsuleReceipt;
}

interface SeedTask {
  readonly id: string;
  readonly status: string;
  readonly blockedBy?: readonly string[];
}

/** The integration branch the seeded workflow's tasks fork from. */
const INTEGRATION_BRANCH = 'feature/prepare-unit';

/** The artifacts that the seeded workflow records when a case names none. */
const SEEDED_ARTIFACTS: Readonly<Record<string, unknown>> = { design: 'docs/specs/prepare-unit.md' };

/** A plan in the form of the workflow state. */
function planEntries(tasks: readonly SeedTask[]): Record<string, unknown>[] {
  return tasks.map((t) => ({ id: t.id, title: `title of ${t.id}`, status: t.status, blockedBy: t.blockedBy ?? [] }));
}

/** A feature workflow standing in `delegate` with the given plan and, unless told otherwise, an integration branch. */
async function seedDelegatingFeature(
  tasks: readonly SeedTask[],
  streamId = STREAM,
  integrationBranch: string | null = INTEGRATION_BRANCH,
  artifacts: Readonly<Record<string, unknown>> = SEEDED_ARTIFACTS,
): Promise<void> {
  await store.append(streamId, { type: 'workflow.started', data: { featureId: streamId, workflowType: 'feature' } });
  await store.append(streamId, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await store.append(streamId, {
    type: 'state.patched',
    data: {
      patch: {
        ...Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [`artifacts.${key}`, value])),
        ...(integrationBranch !== null ? { 'synthesis.integrationBranch': integrationBranch } : {}),
        tasks: planEntries(tasks),
      },
    },
  });
}

/** Puts another plan in place of the plan of a seeded stream, as a plan revision does. */
async function replan(tasks: readonly SeedTask[], streamId = STREAM): Promise<void> {
  await store.append(streamId, { type: 'state.patched', data: { patch: { tasks: planEntries(tasks) } } });
}

async function preparedRows(streamId = STREAM): Promise<Record<string, unknown>[]> {
  const events = await store.query(streamId);
  return events.filter((e) => e.type === 'workflow.prepared').map((e) => e.data as Record<string, unknown>);
}

async function bundleBlobCount(): Promise<number> {
  const root = store.bundleStore.root;
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else count += 1;
    }
  };
  await walk(root);
  return count;
}

const PLAN: readonly SeedTask[] = [
  { id: 'T-1', status: 'complete' },
  { id: 'T-2', status: 'pending', blockedBy: ['T-1'] },
  { id: 'T-3', status: 'pending' },
  { id: 'T-4', status: 'pending', blockedBy: ['T-3'] },
];

const SPEC_PATH = 'docs/specs/prepare-unit-spec.md';
const DESIGN_PATH = 'docs/designs/prepare-unit-design.md';
const PLAN_PATH = 'docs/plans/prepare-unit-plan.md';
/** The longest value, in characters, that prepare takes as a design reference. */
const REFERENCE_BOUND = 512;

interface DesignBinding {
  readonly rationale: readonly string[];
  readonly designRecordDigests: readonly string[];
}

/** What a compiled capsule binds as its design of record: each rationale statement, and the digest of each `design-record` source. */
function designBinding(receipt: PreparedCapsuleReceipt): DesignBinding {
  return {
    rationale: receipt.capsule.knowledge.rationale.map((entry) => entry.statement),
    designRecordDigests: receipt.capsule.provenance.sources
      .filter((source) => source.sourceId === 'design-record')
      .map((source) => source.digest),
  };
}

/** The binding of a capsule whose design of record is the given reference. */
function bindingOf(designRef: string): DesignBinding {
  return {
    rationale: [`The design of record is ${designRef}.`],
    designRecordDigests: [contentDigest(designRef)],
  };
}

/** The binding of a capsule that has no design of record. */
const NO_BINDING: DesignBinding = { rationale: [], designRecordDigests: [] };

/** Seeds one workflow with the given artifacts, prepares it, and returns what its capsule binds. */
async function bindingFor(artifacts: Readonly<Record<string, unknown>>, streamId = STREAM): Promise<DesignBinding> {
  await seedDelegatingFeature(PLAN, streamId, INTEGRATION_BRANCH, artifacts);
  return designBinding(receiptOf(await prepare({ featureId: streamId })));
}

/** The compiler name that the build before the design version counter stamped. */
const EARLIER_COMPILER_VERSION = 'exarchos-prepare-1';

/**
 * The design version id that the earlier compiler stamped for a design reference.
 * It is the prefix, then the first sixteen hex digits of the digest of the reference.
 */
function earlierDesignVersionId(designRef: string | null): string {
  return `design-${contentDigest(designRef).slice(0, 16)}`;
}

/**
 * Prepares the seeded stream through the seam, as a compiler of the given name.
 * Each other dependency is the one that `prepare` passes.
 */
async function prepareAsCompiler(compilerVersion: string): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handlePrepare({ featureId: STREAM }, stateDir, wiring(), {
      catalogInvariants: () => [],
      now: () => COMPILED_AT,
      compilerVersion,
    }),
  );
}

/**
 * Records one prepare through the seam under the given compiler name.
 * Then it prepares again as production does, with no name.
 * The two replay cases call it, so they differ only in the name that they pass.
 */
async function recordedThenPrepared(
  compilerVersion: string,
): Promise<{ readonly recorded: PreparedCapsuleReceipt; readonly prepared: PreparedCapsuleReceipt }> {
  await seedDelegatingFeature(PLAN);
  const recorded = receiptOf(await prepareAsCompiler(compilerVersion));
  const prepared = receiptOf(await prepare({ featureId: STREAM }));
  return { recorded, prepared };
}

/** One `settle` call for the seeded stream, with the collaborators that the composite passes. */
async function settle(raw: Record<string, unknown>): Promise<SettlementReceipt> {
  const result = await runWithDispatchContext(correlation(), () =>
    handleSettle({ featureId: STREAM, ...raw }, stateDir, wiring(), {
      execute: productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'),
    }),
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!result.success) throw new Error('unreachable');
  return result.data as unknown as SettlementReceipt;
}

/** The design revision rows of the seeded stream, each parsed through the row schema. */
async function revisionRows(): Promise<DesignRevised[]> {
  const events = await store.query(STREAM);
  return events.filter((e) => e.type === 'design.revised').map((e) => DesignRevisedData.parse(e.data));
}

/** The recompile rows of a stream, each parsed through the row schema. */
async function recompileRows(streamId = STREAM): Promise<CapsuleRecompiled[]> {
  const events = await store.query(streamId);
  return events.filter((e) => e.type === 'capsule.recompiled').map((e) => CapsuleRecompiledData.parse(e.data));
}

/** The number of rows on a stream. A case reads it before a call, to find the rows that the call appended. */
async function rowCount(streamId = STREAM): Promise<number> {
  return (await store.query(streamId)).length;
}

/** The rows that a stream holds after its first `count` rows, in commit order. */
async function rowsAfter(count: number, streamId = STREAM): Promise<Awaited<ReturnType<EventStore['query']>>> {
  return (await store.query(streamId)).slice(count);
}

/** The ids of the tasks that a stream announced, in commit order. */
async function announcedTasks(streamId = STREAM): Promise<string[]> {
  const events = await store.query(streamId);
  return events
    .filter((e) => e.type === 'task.assigned')
    .map((e) => String((e.data as { taskId?: unknown } | undefined)?.taskId));
}

/**
 * A bundle store that moves the stream before each commit. The row lands after the handler reads
 * the stream tail and before the record commits, which is where a concurrent append lands.
 */
function racingBundleStore(): RunBundleStore {
  const real = store.bundleStore;
  const racing: RunBundleStore = Object.create(real);
  racing.putThenReference = async (artifactId, bytes, commit) => {
    await store.append(STREAM, { type: 'state.patched', data: { patch: { 'artifacts.notes': 'moved' } } });
    return real.putThenReference(artifactId, bytes, commit);
  };
  return racing;
}

/** One `prepare` call for the seeded stream whose commit loses the race for the stream tail. */
async function prepareThroughARace(): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handlePrepare({ featureId: STREAM }, stateDir, wiring(), {
      bundleStore: racingBundleStore(),
      catalogInvariants: () => [],
      now: () => COMPILED_AT,
    }),
  );
}

/**
 * The plan of the continuation cases. The first capsule holds the two ready tasks. A revision can
 * name each of the last three tasks, because they are unfinished and outside that batch.
 */
const CONTINUATION_PLAN: readonly SeedTask[] = [
  { id: 'task-done', status: 'complete' },
  { id: 'task-ready', status: 'pending', blockedBy: ['task-done'] },
  { id: 'task-open', status: 'pending' },
  { id: 'task-named', status: 'pending', blockedBy: ['task-ready'] },
  { id: 'task-after', status: 'pending', blockedBy: ['task-named'] },
  { id: 'task-apart', status: 'pending', blockedBy: ['task-open'] },
];

/** A copy of a plan in which the named tasks are complete. */
function completing(plan: readonly SeedTask[], ...taskIds: readonly string[]): SeedTask[] {
  return plan.map((task) => (taskIds.includes(task.id) ? { ...task, status: 'complete' } : task));
}

/**
 * Records one design revision through a real decision round of `settle` on a prepared capsule.
 * The batch claims each task of the capsule and is held with two deviations. The decision accepts
 * the material one, which names the affected tasks, and rejects the other.
 * So the round records the revision, rejects the batch with nothing run, and leaves the plan as it was.
 */
async function revise(
  prepared: PreparedCapsuleReceipt,
  batchId: string,
  affectedTasks: readonly string[],
): Promise<DesignRevised> {
  const batch = { capsuleVersion: prepared.capsuleVersion, batchId };
  const held = await settle({
    ...batch,
    claims: prepared.capsule.graph.tasks.map((task) => ({
      taskId: task.taskId,
      fields: { worktreePath: '/nonexistent-prepare-worktree' },
      evidence: [],
    })),
    deviations: [
      {
        deviationKind: 'invalidated-assumption',
        statement: 'the store was not SQLite',
        ...(affectedTasks.length > 0 ? { affectedTasks } : {}),
      },
      { deviationKind: 'missing-context', statement: 'the capsule did not name the port' },
    ],
  });
  expect(held.outcome).toBe('deviation-pending');
  const before = (await revisionRows()).length;

  const decided = await settle({
    ...batch,
    decisions: (held.pendingDeviations ?? []).map((pending) => ({
      deviationId: pending.deviationId,
      decision: pending.deviationKind === 'invalidated-assumption' ? 'accepted' : 'rejected',
      actor: 'human:reviewer',
      rationale: 'the assumption was wrong, and the capsule did name the port',
    })),
  });
  expect(decided.outcome).toBe('rejected');
  expect(decided.verification).toEqual([]);

  const rows = await revisionRows();
  expect(rows).toHaveLength(before + 1);
  const row = rows.at(-1);
  if (row === undefined) throw new Error(`the decision of '${batchId}' committed no revision`);
  expect(row.affectedTasks).toEqual([...new Set(affectedTasks)].sort());
  expect(row.bundleRefs).toEqual(decided.bundleRefs);
  return row;
}

interface Continuation {
  /** The receipt of the prepare before the revisions. */
  readonly first: PreparedCapsuleReceipt;
  /** The receipt of the prepare after them. */
  readonly next: PreparedCapsuleReceipt;
  /** The rows that the prepare after the revisions appended, in commit order. */
  readonly appended: Awaited<ReturnType<EventStore['query']>>;
}

/**
 * Seeds the continuation plan and prepares it. Then it records one revision for each list of
 * affected tasks, each on the first capsule, and prepares again.
 */
async function continuationAfter(...revisions: readonly (readonly string[])[]): Promise<Continuation> {
  await seedDelegatingFeature(CONTINUATION_PLAN);
  const first = receiptOf(await prepare({ featureId: STREAM }));
  expect(first.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-ready', 'task-open']);
  for (const [index, affectedTasks] of revisions.entries()) {
    await revise(first, `batch-revising-${index}`, affectedTasks);
  }
  const before = await rowCount();
  const next = receiptOf(await prepare({ featureId: STREAM }));
  return { first, next, appended: await rowsAfter(before) };
}

/** The statement that binds the design reference of the seeded workflow. */
const DESIGN_OF_RECORD = 'The design of record is docs/specs/prepare-unit.md.';

/** The actor of each decision that a staged round makes, unless a deviation names another. */
const REVIEWER = 'human:reviewer';

/** The statement that a capsule binds for one accepted change. The texts hold no character that JSON escapes. */
function acceptedStatement(
  designVersion: number,
  statement: string,
  proposedChange?: string,
  actor: string = REVIEWER,
): string {
  return (
    `Design version ${designVersion} holds an accepted change. Decided by "${actor}". ` +
    (proposedChange !== undefined ? `Proposed change: "${proposedChange}". ` : '') +
    `Deviation: "${statement}".`
  );
}

/** One deviation of a staged round, and the decision that the round makes on it. */
interface StagedDeviation {
  readonly deviationKind: 'invalidated-assumption' | 'missing-context';
  readonly statement: string;
  readonly decision: 'accepted' | 'rejected';
  readonly affectedTasks?: readonly string[];
  readonly proposedChange?: string;
  readonly actor?: string;
}

interface StagedRound {
  /** The receipt of the round that submitted the batch. */
  readonly held: SettlementReceipt;
  /** The receipt of the decision round. */
  readonly decided: SettlementReceipt;
  /** The revision row that the decision round committed. */
  readonly row: DesignRevised;
  /** The id that the held receipt gave to the deviation with the given statement. */
  readonly idOf: (statement: string) => string;
}

/**
 * Records one decision round of `settle` on a prepared capsule, with the given deviations and decisions.
 * The batch claims each task of the capsule. The statements of one round are distinct.
 * The round also holds one deviation for missing context, and it rejects that one.
 * So the round rejects the batch with nothing run, and it leaves the plan as it was.
 * The staged decisions accept one material deviation or more, so the round commits one revision row.
 */
async function decide(
  prepared: PreparedCapsuleReceipt,
  batchId: string,
  deviations: readonly StagedDeviation[],
): Promise<StagedRound> {
  const staged: readonly StagedDeviation[] = [
    ...deviations,
    { deviationKind: 'missing-context', statement: `${batchId} did not name the port`, decision: 'rejected' },
  ];
  const batch = { capsuleVersion: prepared.capsuleVersion, batchId };
  const held = await settle({
    ...batch,
    claims: prepared.capsule.graph.tasks.map((task) => ({
      taskId: task.taskId,
      fields: { worktreePath: '/nonexistent-prepare-worktree' },
      evidence: [],
    })),
    deviations: staged.map(({ deviationKind, statement, affectedTasks, proposedChange }) => ({
      deviationKind,
      statement,
      ...(affectedTasks !== undefined ? { affectedTasks } : {}),
      ...(proposedChange !== undefined ? { proposedChange } : {}),
    })),
  });
  expect(held.outcome).toBe('deviation-pending');
  const pending = held.pendingDeviations ?? [];
  expect(pending).toHaveLength(staged.length);
  const before = (await revisionRows()).length;

  const decided = await settle({
    ...batch,
    decisions: pending.map((proposal) => {
      const deviation = staged.find((candidate) => candidate.statement === proposal.statement);
      if (deviation === undefined) throw new Error(`no staged deviation states ${proposal.statement}`);
      return {
        deviationId: proposal.deviationId,
        decision: deviation.decision,
        actor: deviation.actor ?? REVIEWER,
        rationale: `the staged round of '${batchId}' decided it`,
      };
    }),
  });
  expect(decided.outcome).toBe('rejected');
  expect(decided.verification).toEqual([]);

  const rows = await revisionRows();
  expect(rows).toHaveLength(before + 1);
  const row = rows.at(-1);
  if (row === undefined) throw new Error(`the decision of '${batchId}' committed no revision`);
  expect(row.bundleRefs).toEqual(decided.bundleRefs);
  const idOf = (statement: string): string => {
    const proposal = pending.find((candidate) => candidate.statement === statement);
    if (proposal === undefined) throw new Error(`the held receipt names no deviation that states ${statement}`);
    return proposal.deviationId;
  };
  return { held, decided, row, idOf };
}

/** The digest of the settlement bundle that a revision row names. */
function bundleDigestOf(row: DesignRevised): BundleRefV1['digest'] {
  const ref = row.bundleRefs[0];
  if (ref === undefined) throw new Error('the revision row names no bundle');
  return ref.digest;
}

/** The file of one blob in the bundle store of the test. */
function blobPath(digest: BundleRefV1['digest']): string {
  return path.join(store.bundleStore.root, digest.algorithm, digest.value.slice(0, 2), digest.value.slice(2));
}

/** One `prepare` call for the seeded stream through the given bundle store. */
async function prepareThrough(bundleStore: RunBundleStore): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handlePrepare({ featureId: STREAM }, stateDir, wiring(), {
      bundleStore,
      catalogInvariants: () => [],
      now: () => COMPILED_AT,
    }),
  );
}

interface CountingBundleStore {
  readonly bundles: RunBundleStore;
  /** The digest value of each blob that a caller read through `bundles`, in read order. */
  readonly read: string[];
}

/** A bundle store that records each read of a blob. It passes each call to the store of the test. */
function countingBundleStore(): CountingBundleStore {
  const real = store.bundleStore;
  const read: string[] = [];
  const bundles: RunBundleStore = Object.create(real);
  bundles.resolve = async (digest, signal) => {
    read.push(digest.value);
    return real.resolve(digest, signal);
  };
  bundles.has = async (digest, signal) => {
    read.push(digest.value);
    return real.has(digest, signal);
  };
  return { bundles, read };
}

/**
 * A bundle store that answers the read of one digest with the bytes of another blob in custody.
 * The real store hashes each blob that it reads, so only this seam can give a bundle that its row does not match.
 */
function bundleStoreAnswering(asked: BundleRefV1['digest'], answer: BundleRefV1['digest']): RunBundleStore {
  const real = store.bundleStore;
  const bundles: RunBundleStore = Object.create(real);
  bundles.resolve = async (digest, signal) => real.resolve(digest.value === asked.value ? answer : digest, signal);
  return bundles;
}

/**
 * Puts an edited copy of the settlement bundle of a revision in custody, and returns its digest.
 * The copy passes the bundle schema, so a prepare that reads it decodes it as it decodes the real one.
 */
async function editedBundleOf(
  row: DesignRevised,
  edit: (bundle: SettlementBundleV1) => SettlementBundleV1,
): Promise<BundleRefV1['digest']> {
  const real = decodeSettlementBundle(await store.bundleStore.resolve(bundleDigestOf(row)));
  return store.bundleStore.put(encodeSettlementBundle(edit(real)));
}

/** One accepted material deviation of a staged round, which names the given tasks as affected. */
function acceptedMaterial(statement: string, affectedTasks?: readonly string[]): StagedDeviation {
  return {
    deviationKind: 'invalidated-assumption',
    statement,
    decision: 'accepted',
    ...(affectedTasks !== undefined ? { affectedTasks } : {}),
  };
}

/** The statement that counts the accepted changes that a capsule does not state. */
function leftOutStatement(count: number): string {
  return (
    `${count} more accepted design change(s) are not stated in this capsule. ` +
    'The design.revised rows of the workflow stream name each one.'
  );
}

/** A bundle store that fails each read with the given fault, as a store on a broken disk does. */
function failingBundleStore(fault: string): RunBundleStore {
  const bundles: RunBundleStore = Object.create(store.bundleStore);
  bundles.resolve = async () => {
    throw new Error(fault);
  };
  return bundles;
}

describe('prepare — the compilation endpoint', () => {
  /** The test reads the bundle back out of custody and digests it again. The record pins bytes that decode to the capsule that the caller got. */
  it('Prepare_ADelegatingFeature_RecordsOneCapsuleWhoseBytesAreInCustody', async () => {
    await seedDelegatingFeature(PLAN);
    const receipt = receiptOf(await prepare({ featureId: STREAM }));

    expect(receipt.capsuleVersion).toBe(1);
    expect(receipt.workflowId).toBe(STREAM);
    expect(receipt.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['T-2', 'T-3']);
    expect(receipt.capsule.graph.dependencies).toEqual([]);
    expect(receipt.capsuleDigest).toBe(capsuleDigest(receipt.capsule));
    expect(receipt.definitionVersion).toBe(lowerBuiltInDefinition('feature')?.definitionVersion);

    const rows = await preparedRows();
    expect(rows).toHaveLength(1);
    const record = WorkflowPreparedData.parse(rows[0]);
    expect(record.capsuleDigest).toBe(receipt.capsuleDigest);
    expect(record.taskCount).toBe(2);

    const found = await findPreparedCapsule(wiring(), STREAM, 1);
    expect(found.found).toBe(true);
    if (found.found) {
      expect(found.capsule).toEqual(receipt.capsule);
      expect(capsuleDigest(found.capsule)).toBe(record.capsuleDigest);
    }
  });

  it('Prepare_ARetryWithUnchangedInputs_ReturnsTheRecordedCapsuleAndAppendsNothing', async () => {
    await seedDelegatingFeature(PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const blobs = await bundleBlobCount();
    expect(blobs).toBe(1);

    const retried = receiptOf(await prepare({ featureId: STREAM }));
    expect(retried).toEqual(first);
    expect(await preparedRows()).toHaveLength(1);
    expect(await bundleBlobCount()).toBe(blobs);
  });

  it('Prepare_ChangedInputs_CompileTheNextVersion', async () => {
    await seedDelegatingFeature(PLAN);
    receiptOf(await prepare({ featureId: STREAM }));
    await store.append(STREAM, { type: 'state.patched', data: { patch: { 'tasks[1].status': 'complete' } } });

    const next = receiptOf(await prepare({ featureId: STREAM }));
    expect(next.capsuleVersion).toBe(2);
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['T-3']);
    expect(await preparedRows()).toHaveLength(2);
  });

  it('Prepare_TheReadyFrontier_IsCompiledOneWaveAtATime', async () => {
    await seedDelegatingFeature(PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    expect(first.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['T-2', 'T-3']);
    expect(first.capsule.settlementContract.requiredResults).toEqual(['T-2', 'T-3']);

    await store.append(STREAM, {
      type: 'state.patched',
      data: { patch: { 'tasks[1].status': 'complete', 'tasks[2].status': 'complete' } },
    });
    const second = receiptOf(await prepare({ featureId: STREAM }));
    expect(second.capsuleVersion).toBe(2);
    expect(second.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['T-4']);
  });

  it('Prepare_EveryTask_CarriesTheIntegrationBranchAsItsBase', async () => {
    await seedDelegatingFeature(PLAN);
    const receipt = receiptOf(await prepare({ featureId: STREAM }));
    expect(receipt.capsule.settlementContract.taskVerification).toEqual({
      'T-2': { riskTier: 'medium', boundaryTouching: false, baseRef: INTEGRATION_BRANCH },
      'T-3': { riskTier: 'medium', boundaryTouching: false, baseRef: INTEGRATION_BRANCH },
    });
  });

  it('Prepare_TheSameInputsUnderAnotherBase_CompileTheNextVersion', async () => {
    await seedDelegatingFeature(PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    await store.append(STREAM, { type: 'state.patched', data: { patch: { 'artifacts.notes': 'unrelated' } } });
    expect(receiptOf(await prepare({ featureId: STREAM }))).toEqual(first);

    await store.append(STREAM, {
      type: 'state.patched',
      data: { patch: { 'synthesis.integrationBranch': 'feature/elsewhere' } },
    });

    const moved = receiptOf(await prepare({ featureId: STREAM }));
    expect(moved.capsuleVersion).toBe(2);
    expect(moved.operationId).not.toBe(first.operationId);
    expect(moved.capsule.settlementContract.taskVerification?.['T-2']?.baseRef).toBe('feature/elsewhere');
    expect(moved.capsule.graph.tasks).toEqual(first.capsule.graph.tasks);
    expect(await preparedRows()).toHaveLength(2);
  });

  /**
   * The compilation appends one `task.assigned` for each compiled task before the prepared record, in the same commit.
   * So the event contract of the delegate phase does not depend on a model call. The receipt tail is the sequence of the record, and a retry announces nothing more.
   */
  it('Prepare_ACompiledBatch_AnnouncesItsTasksInTheSameCommit', async () => {
    await seedDelegatingFeature(PLAN);
    const receipt = receiptOf(await prepare({ featureId: STREAM }));
    const events = await store.query(STREAM);
    const assigned = events.filter((e) => e.type === 'task.assigned');
    expect(assigned.map((e) => e.data)).toEqual([
      { taskId: 'T-2', title: 'title of T-2' },
      { taskId: 'T-3', title: 'title of T-3' },
    ]);
    const prepared = events.find((e) => e.type === 'workflow.prepared');
    expect(prepared).toBeDefined();
    expect(assigned.every((e) => e.sequence < (prepared?.sequence ?? 0))).toBe(true);
    expect(receipt.tailSequence).toBe(prepared?.sequence);
    receiptOf(await prepare({ featureId: STREAM }));
    expect((await store.query(STREAM)).filter((e) => e.type === 'task.assigned')).toHaveLength(2);
  });

  /**
   * A task with an earlier `task.assigned` row gets no second row, because the task projection reads a second row as a return to `assigned`.
   * The next version compiles from the remaining tasks, which all have rows.
   */
  it('Prepare_ATaskTheStreamAlreadyHeardOf_IsNotAnnouncedAgain', async () => {
    await seedDelegatingFeature(PLAN);
    await store.append(STREAM, { type: 'task.assigned', data: { taskId: 'T-3', title: 'by hand', branch: 'feat/t3' } });
    receiptOf(await prepare({ featureId: STREAM }));
    const taskIds = async (): Promise<string[]> =>
      (await store.query(STREAM))
        .filter((e) => e.type === 'task.assigned')
        .map((e) => (e.data as { taskId: string }).taskId);
    expect(await taskIds()).toEqual(['T-3', 'T-2']);

    await store.append(STREAM, { type: 'state.patched', data: { patch: { 'tasks[1].status': 'complete' } } });
    expect(receiptOf(await prepare({ featureId: STREAM })).capsuleVersion).toBe(2);
    expect(await taskIds()).toEqual(['T-3', 'T-2']);
  });

  it('Prepare_ARefusedCompilation_AnnouncesNothing', async () => {
    await seedDelegatingFeature(PLAN);
    const refused = await prepare({ featureId: STREAM }, [], ['fs:read']);
    expect(refused.success).toBe(false);
    expect((await store.query(STREAM)).filter((e) => e.type === 'task.assigned')).toEqual([]);
  });

  /**
   * The verification terms are inputs to the compilation. A policy change for a risk tier in the batch compiles the next version with the new gate list.
   * A policy change for a risk tier outside the batch replays the recorded capsule.
   */
  it('Prepare_AChangedVerificationPolicy_CompilesTheNextVersion', async () => {
    await seedDelegatingFeature(PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    expect(first.capsule.settlementContract.taskVerification?.['T-2']).toEqual({
      riskTier: 'medium',
      boundaryTouching: false,
      baseRef: INTEGRATION_BRANCH,
    });
    const before = first.capsule.knowledge.patterns.map((p) => p.statement);

    const elsewhere = resolveConfig({ verification: { policy: { high: ['check_contract_drift'] } } });
    expect(receiptOf(await prepare({ featureId: STREAM }, [], FIT_CAPABILITIES, elsewhere))).toEqual(first);
    expect(await preparedRows()).toHaveLength(1);

    const changed = resolveConfig({ verification: { policy: { medium: ['check_contract_drift'] } } });
    const next = receiptOf(await prepare({ featureId: STREAM }, [], FIT_CAPABILITIES, changed));
    expect(next.capsuleVersion).toBe(2);
    const after = next.capsule.knowledge.patterns.map((p) => p.statement);
    expect(after).toContain(
      'A task at riskTier=medium, boundaryTouching=false is verified at settlement by: check_contract_drift.',
    );
    expect(after).not.toEqual(before);
    expect(await preparedRows()).toHaveLength(2);
  });

  it('Prepare_ARegisteredCatalog_IsBoundIntoTheAuthority', async () => {
    await seedDelegatingFeature(PLAN);
    const receipt = receiptOf(await prepare({ featureId: STREAM }, [{ id: 'INV-9', summary: 'catalog statement' }]));
    expect(receipt.capsule.authority.invariants.map((i) => i.id)).toContain('INV-9');
  });

  /** The spec is the first key that prepare reads, so it wins over the plan of the same workflow. */
  it('Prepare_AWorkflowWithSpecAndPlan_BindsTheSpec', async () => {
    expect(await bindingFor({ spec: SPEC_PATH, plan: PLAN_PATH })).toEqual(bindingOf(SPEC_PATH));
  });

  it('Prepare_AWorkflowWithDesignAndPlan_BindsTheDesign', async () => {
    expect(await bindingFor({ design: DESIGN_PATH, plan: PLAN_PATH })).toEqual(bindingOf(DESIGN_PATH));
  });

  /** An artifact key can hold a document instead of its path. A value with a line feed or a carriage return is not a reference. */
  it('Prepare_ASpecThatHoldsContents_IsSkippedForThePlanPath', async () => {
    const contents = [
      '# The spec\n\nThe design is in this text.\n',
      '# The spec\r\nThe design is in this text.',
      'The spec\rThe design is in this text.',
    ];
    for (const [index, spec] of contents.entries()) {
      const binding = await bindingFor({ spec, plan: PLAN_PATH }, `${STREAM}-contents-${index}`);
      expect(binding, JSON.stringify(spec)).toEqual(bindingOf(PLAN_PATH));
    }
  });

  /** The bound is inclusive. A line at the bound is a reference, and one more character makes it too long. */
  it('Prepare_AReferenceOverTheLengthBound_IsSkipped', async () => {
    const atTheBound = 'r'.repeat(REFERENCE_BOUND);
    const overTheBound = 'r'.repeat(REFERENCE_BOUND + 1);
    expect(await bindingFor({ spec: overTheBound, plan: PLAN_PATH }, `${STREAM}-over`)).toEqual(bindingOf(PLAN_PATH));
    expect(await bindingFor({ spec: atTheBound, plan: PLAN_PATH }, `${STREAM}-at`)).toEqual(bindingOf(atTheBound));
  });

  it('Prepare_APlanOnlyWorkflow_BindsThePlanArtifactAsTheDesignOfRecord', async () => {
    expect(await bindingFor({ plan: PLAN_PATH })).toEqual(bindingOf(PLAN_PATH));
  });

  /** The first workflow records no artifact. The second records a value that is not a reference under each key. The third records a list. */
  it('Prepare_AWorkflowWithNoUsableArtifact_CompilesWithNoRationale', async () => {
    expect(await bindingFor({}, `${STREAM}-none`)).toEqual(NO_BINDING);
    const unusable = { spec: '', design: 'line one\nline two', plan: 'r'.repeat(REFERENCE_BOUND + 1) };
    expect(await bindingFor(unusable, `${STREAM}-unusable`)).toEqual(NO_BINDING);
    expect(await bindingFor({ spec: [SPEC_PATH] }, `${STREAM}-list`)).toEqual(NO_BINDING);
  });

  /**
   * A blank value names no document. Five more characters end a line, so a value that holds one is two lines.
   * They are the vertical tab, the form feed, the next line character, and the line and paragraph separators.
   * Each such spec is skipped for the plan path. A path with spaces in it is one line that is not blank, so it binds.
   */
  it('Prepare_ABlankOrMultiLineSeparatorReference_IsSkipped', async () => {
    const character = (code: number): string => String.fromCharCode(code);
    const blank = [' ', '    ', character(0x09), ` ${character(0xa0)} `];
    const twoLines = [0x0b, 0x0c, 0x85, 0x2028, 0x2029].map((code) => `docs/specs/one${character(code)}two.md`);
    const skipped = [...blank, ...twoLines];
    expect(skipped).toHaveLength(9);
    for (const [index, spec] of skipped.entries()) {
      const binding = await bindingFor({ spec, plan: PLAN_PATH }, `${STREAM}-skipped-${index}`);
      expect(binding, JSON.stringify(spec)).toEqual(bindingOf(PLAN_PATH));
    }

    const spaced = 'docs/specs/prepare unit spec.md';
    expect(await bindingFor({ spec: spaced, plan: PLAN_PATH }, `${STREAM}-spaced`)).toEqual(bindingOf(spaced));
  });

  /**
   * The id is the counter of the stream and holds no part of the design reference.
   * A workflow with another reference, or with none, is at the same version.
   * The digest of the reference stays in the provenance sources.
   */
  it('Prepare_AStreamWithNoRevision_CompilesTheFirstDesignVersion', async () => {
    await seedDelegatingFeature(PLAN);
    const receipt = receiptOf(await prepare({ featureId: STREAM }));
    expect(await revisionRows()).toEqual([]);
    expect(receipt.capsule.identity.designVersion).toBe('design-v1');
    expect(WorkflowPreparedData.parse((await preparedRows())[0]).designVersion).toBe('design-v1');
    expect(designBinding(receipt)).toEqual(bindingOf('docs/specs/prepare-unit.md'));

    const elsewhere = `${STREAM}-another-reference`;
    await seedDelegatingFeature(PLAN, elsewhere, INTEGRATION_BRANCH, { spec: SPEC_PATH });
    const other = receiptOf(await prepare({ featureId: elsewhere }));
    expect(other.capsule.identity.designVersion).toBe('design-v1');
    expect(designBinding(other)).toEqual(bindingOf(SPEC_PATH));

    const unbound = `${STREAM}-no-reference`;
    await seedDelegatingFeature(PLAN, unbound, INTEGRATION_BRANCH, {});
    expect(receiptOf(await prepare({ featureId: unbound })).capsule.identity.designVersion).toBe('design-v1');
  });

  /**
   * The batch is held with two deviations. The decision accepts the material one and rejects the other.
   * So the round records one design revision, rejects the batch with nothing run, and leaves the plan as it was.
   * The held batch alone moves no input, so the retry before the decision replays the first receipt.
   *
   * After the revision, the same plan compiles the next capsule version under the next design version.
   * That capsule states the accepted change, and its provenance pins the revision row.
   * The last comparison takes those two parts out and puts the two first versions back.
   * Thus nothing else in the capsule moved.
   */
  it('Prepare_AfterADesignRevision_CompilesTheNextVersionRatherThanReplaying', async () => {
    await seedDelegatingFeature(PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    expect(first.capsule.identity.designVersion).toBe('design-v1');

    const batch = { capsuleVersion: first.capsuleVersion, batchId: 'batch-revises-the-design' };
    const held = await settle({
      ...batch,
      claims: first.capsule.graph.tasks.map((task) => ({
        taskId: task.taskId,
        fields: { worktreePath: '/nonexistent-prepare-worktree' },
        evidence: [],
      })),
      deviations: [
        { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' },
        { deviationKind: 'missing-context', statement: 'the capsule did not name the port' },
      ],
    });
    expect(held.outcome).toBe('deviation-pending');
    expect(held.pendingDeviations?.map((pending) => pending.deviationKind)).toEqual([
      'invalidated-assumption',
      'missing-context',
    ]);
    expect(await revisionRows()).toEqual([]);
    expect(receiptOf(await prepare({ featureId: STREAM }))).toEqual(first);

    const decided = await settle({
      ...batch,
      decisions: (held.pendingDeviations ?? []).map((pending) => ({
        deviationId: pending.deviationId,
        decision: pending.deviationKind === 'invalidated-assumption' ? 'accepted' : 'rejected',
        actor: 'human:reviewer',
        rationale: 'the assumption was wrong, and the capsule did name the port',
      })),
    });
    expect(decided.outcome).toBe('rejected');
    expect(decided.verification).toEqual([]);
    expect(decided.designRevision).toMatchObject({ priorDesignVersion: 1, nextDesignVersion: 2 });
    const revisions = await revisionRows();
    expect(revisions.map((row) => [row.priorDesignVersion, row.nextDesignVersion])).toEqual([[1, 2]]);
    expect(revisions[0]?.bundleRefs).toEqual(decided.bundleRefs);
    expect((await store.query(STREAM)).filter((e) => e.type === 'task.completed')).toEqual([]);

    const next = receiptOf(await prepare({ featureId: STREAM }));
    expect(next.capsuleVersion).toBe(2);
    expect(next.operationId).not.toBe(first.operationId);
    expect(next.capsuleDigest).not.toBe(first.capsuleDigest);
    expect(next.capsule.identity.designVersion).toBe('design-v2');
    const stated = designBinding(next).rationale.slice(designBinding(first).rationale.length);
    expect(stated).toEqual([acceptedStatement(2, 'the store was not SQLite')]);
    const isPin = (source: { readonly sourceId: string }): boolean => source.sourceId === 'design-revisions';
    expect(next.capsule.provenance.sources.filter(isPin)).toEqual([
      { sourceId: 'design-revisions', digest: contentDigest(revisions) },
    ]);
    expect({
      ...next.capsule,
      identity: { ...next.capsule.identity, designVersion: 'design-v1', capsuleVersion: 1 },
      knowledge: {
        ...next.capsule.knowledge,
        rationale: next.capsule.knowledge.rationale.slice(0, designBinding(first).rationale.length),
      },
      provenance: {
        ...next.capsule.provenance,
        sources: next.capsule.provenance.sources.filter((source) => !isPin(source)),
      },
    }).toEqual(first.capsule);

    const rows = (await preparedRows()).map((row) => WorkflowPreparedData.parse(row));
    expect(rows.map((row) => [row.capsuleVersion, row.designVersion])).toEqual([
      [1, 'design-v1'],
      [2, 'design-v2'],
    ]);
    expect(receiptOf(await prepare({ featureId: STREAM }))).toEqual(next);
    expect(await preparedRows()).toHaveLength(2);
  });

  /**
   * The first prepare is recorded under the name of the earlier compiler. The second is the production call.
   * The claim of the earlier compiler does not answer it, so it compiles the next version from the same batch.
   */
  it('Prepare_AClaimFromAnEarlierCompilerVersion_IsNotReplayed', async () => {
    expect(EARLIER_COMPILER_VERSION).not.toBe(PREPARE_COMPILER_VERSION);
    const { recorded, prepared } = await recordedThenPrepared(EARLIER_COMPILER_VERSION);
    expect(recorded.capsuleVersion).toBe(1);
    expect(recorded.capsule.provenance.compilerVersion).toBe(EARLIER_COMPILER_VERSION);

    expect(prepared.capsuleVersion).toBe(2);
    expect(prepared.operationId).not.toBe(recorded.operationId);
    expect(prepared.capsule.provenance.compilerVersion).toBe(PREPARE_COMPILER_VERSION);
    expect(prepared.capsule.graph).toEqual(recorded.capsule.graph);
    const rows = (await preparedRows()).map((row) => WorkflowPreparedData.parse(row));
    expect(rows.map((row) => [row.capsuleVersion, row.compilerVersion])).toEqual([
      [1, EARLIER_COMPILER_VERSION],
      [2, PREPARE_COMPILER_VERSION],
    ]);
  });

  /** The same two calls, with the name of this build through the seam. The second call replays the claim of the first. */
  it('Prepare_AClaimFromTheSameCompilerVersion_IsReplayed', async () => {
    const { recorded, prepared } = await recordedThenPrepared(PREPARE_COMPILER_VERSION);
    expect(recorded.capsuleVersion).toBe(1);
    expect(recorded.capsule.provenance.compilerVersion).toBe(PREPARE_COMPILER_VERSION);

    expect(prepared).toEqual(recorded);
    expect(await preparedRows()).toHaveLength(1);
    expect(await bundleBlobCount()).toBe(1);
  });

  /**
   * The stored capsule is the one that this build compiles, with two fields in the form of the earlier build.
   * They are the design version id in its hash form and the name of the earlier compiler.
   * The production commit puts the capsule in custody as the next version.
   * The lookup that settlement uses reads it back, and the capsule of this build is still found beside it.
   */
  it('Prepare_ACapsuleStoredWithTheEarlierIdentityForm_StillParsesAndIsFound', async () => {
    await seedDelegatingFeature(PLAN);
    const current = receiptOf(await prepare({ featureId: STREAM }));
    const earlierId = earlierDesignVersionId('docs/specs/prepare-unit.md');
    expect(earlierId).toMatch(/^design-[0-9a-f]{16}$/);
    expect(current.capsule.identity.designVersion).not.toBe(earlierId);

    const earlier: ExarchosCapsuleV1 = {
      ...current.capsule,
      identity: { ...current.capsule.identity, designVersion: earlierId, capsuleVersion: 2 },
      provenance: { ...current.capsule.provenance, compilerVersion: EARLIER_COMPILER_VERSION },
    };
    const lowered = lowerBuiltInDefinition('feature');
    if (lowered === undefined) throw new Error('the feature workflow did not lower');
    const stored = await runWithDispatchContext(correlation(), () =>
      commitPreparedCapsule(wiring(), {
        streamId: STREAM,
        operationId: 'prepare:recorded-by-the-earlier-compiler',
        requestDigest: 'sha256:recorded-by-the-earlier-compiler',
        workflowType: 'feature',
        capsule: earlier,
        definition: lowered.definition,
      }),
    );
    expect(stored.capsuleDigest).toBe(capsuleDigest(earlier));

    const found = await findPreparedCapsule(wiring(), STREAM, 2);
    if (!found.found) throw new Error('the capsule in the earlier identity form was not found');
    expect(ExarchosCapsuleV1Schema.parse(found.capsule)).toEqual(earlier);
    expect(found.capsule.identity.designVersion).toBe(earlierId);
    expect(found.record.designVersion).toBe(earlierId);
    expect(found.record.compilerVersion).toBe(EARLIER_COMPILER_VERSION);
    expect(found.record.capsuleDigest).toBe(capsuleDigest(earlier));

    const beside = await findPreparedCapsule(wiring(), STREAM, 1);
    if (!beside.found) throw new Error('the capsule of this build was not found');
    expect(beside.capsule.identity.designVersion).toBe('design-v1');
  });

  /** A server that dispatches for another workspace must bind the configuration and catalog of that workspace, not those of the process directory. */
  it('Prepare_TheCatalog_IsResolvedFromTheDispatchedWorkspace', async () => {
    await seedDelegatingFeature(PLAN);
    const workspace = path.join(stateDir, 'dispatched-workspace');
    expect(workspace).not.toBe(process.cwd());
    const roots: string[] = [];
    const result = await runWithDispatchContext(correlation(), () =>
      handlePrepare({ featureId: STREAM }, stateDir, { ...wiring(), cwd: workspace }, {
        catalogInvariants: (_workflowType, _phase, repoRoot) => {
          roots.push(repoRoot);
          return [];
        },
        now: () => COMPILED_AT,
      }),
    );
    receiptOf(result);
    expect(roots).toEqual([workspace]);
  });

  /**
   * The stream moves after the handler reads its tail and before the record commits. A concurrent preparation of the same version lands in this window.
   * No claim survives the lost race, so the next preparation compiles the version again.
   */
  it('Prepare_AStreamThatMovesBeforeTheCommit_LosesTheVersionAndLeavesNoClaim', async () => {
    await seedDelegatingFeature(PLAN);

    const lost = await prepareThroughARace();
    expect(lost.success, JSON.stringify(lost)).toBe(false);
    if (!lost.success) expect(lost.error.code).toBe('CONCURRENCY_CONFLICT');
    expect(await preparedRows()).toEqual([]);

    const retried = receiptOf(await prepare({ featureId: STREAM }));
    expect(retried.capsuleVersion).toBe(1);
    expect(await preparedRows()).toHaveLength(1);
  });

  /**
   * The profile holds what the calls of the plane need: `settle` and each leaf of the segment that it composes. It comes from their registrations.
   * The bound knowledge states the gates for each tier, so a harness can tell its workers without a policy copy.
   */
  it('Prepare_TheCapsule_CarriesTheExecutionProfileTheRegistryDeclares', async () => {
    await seedDelegatingFeature(PLAN);
    const receipt = receiptOf(await prepare({ featureId: STREAM }));
    const profile = receipt.capsule.executionProfile;
    expect(profile).toBeDefined();
    expect(profile?.capabilities).toEqual(planeExecutionCapabilities());
    expect(profile?.capabilities).toEqual(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']);
    expect(receipt.capsule.knowledge.patterns.map((p) => p.statement)).toEqual([
      'A task at riskTier=medium, boundaryTouching=false is verified at settlement by: check_static_analysis, check_test_adequacy.',
    ]);
  });

  /**
   * A harness without shell access cannot run the ladder gates that settlement composes. It gets the refusal here, before the handler compiles or records anything.
   * A caller with no trusted snapshot has no grant, so the handler refuses it too.
   */
  it('Prepare_ARuntimeThatCannotSettleTheBatch_IsRefusedBeforeFanOut', async () => {
    await seedDelegatingFeature(PLAN);
    const blobs = await bundleBlobCount();
    const result = await prepare({ featureId: STREAM }, [], ['fs:read', 'fs:write', 'mcp:exarchos']);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RUNTIME_UNFIT');
      expect(result.error.message).toContain('"shell:exec"');
    }
    expect(await preparedRows()).toEqual([]);
    expect(await bundleBlobCount()).toBe(blobs);
    const anonymous = await runWithDispatchContext(mintDispatchContext(undefined), () =>
      handlePrepare({ featureId: STREAM }, stateDir, wiring(), { catalogInvariants: () => [], now: () => COMPILED_AT }),
    );
    expect(anonymous.success).toBe(false);
    if (!anonymous.success) expect(anonymous.error.code).toBe('RUNTIME_UNFIT');
  });

  describe('refusals happen before any effect', () => {
    async function expectRefused(result: ToolResult, code: string): Promise<void> {
      expect(result.success, JSON.stringify(result)).toBe(false);
      if (!result.success) expect(result.error.code).toBe(code);
      expect(await preparedRows()).toEqual([]);
      expect(await bundleBlobCount()).toBe(0);
    }

    it('Prepare_NoWorkflow_IsRefused', async () => {
      await expectRefused(await prepare({ featureId: STREAM }), 'WORKFLOW_NOT_FOUND');
    });

    it('Prepare_AWorkflowTypeWithoutADelegationBatch_IsRefused', async () => {
      await store.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'debug' } });
      await expectRefused(await prepare({ featureId: STREAM }), 'WORKFLOW_TYPE_UNSUPPORTED');
    });

    it('Prepare_AFeatureNotYetDelegating_IsRefused', async () => {
      await store.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
      await expectRefused(await prepare({ featureId: STREAM }), 'PHASE_NOT_PREPARABLE');
    });

    it('Prepare_APlanWithNothingOutstanding_IsRefused', async () => {
      await seedDelegatingFeature([{ id: 'T-1', status: 'complete' }]);
      await expectRefused(await prepare({ featureId: STREAM }), 'NOTHING_TO_PREPARE');
    });

    it('Prepare_ATaskWaitingOnATaskThePlanLacks_IsRefused', async () => {
      await seedDelegatingFeature([{ id: 'T-1', status: 'pending', blockedBy: ['T-ghost'] }]);
      await expectRefused(await prepare({ featureId: STREAM }), 'UNKNOWN_DEPENDENCY');
    });

    it('Prepare_PendingTasksWithNoneReady_AreRefusedNamingTheirBlockers', async () => {
      await seedDelegatingFeature([
        { id: 'T-1', status: 'pending', blockedBy: ['T-2'] },
        { id: 'T-2', status: 'pending', blockedBy: ['T-1'] },
      ]);
      const result = await prepare({ featureId: STREAM });
      await expectRefused(result, 'NO_READY_TASKS');
      if (!result.success) {
        expect(result.error.message).toContain('"T-1" waits on "T-2"');
        expect(result.error.message).toContain('"T-2" waits on "T-1"');
      }
    });

    it('Prepare_AWorkflowWithNoIntegrationBranch_IsRefusedWithHowToSetIt', async () => {
      await seedDelegatingFeature(PLAN, STREAM, null);
      const result = await prepare({ featureId: STREAM });
      await expectRefused(result, 'BASE_UNRESOLVED');
      if (!result.success) expect(result.error.message).toContain('"synthesis.integrationBranch"');
      expect((await store.query(STREAM)).filter((e) => e.type === 'task.assigned')).toEqual([]);
    });

    it('Prepare_AnIntegrationBranchThatIsNotASafeRef_IsRefused', async () => {
      for (const [index, branch] of ['-x', 'main..feature', 'feature x', '   '].entries()) {
        const streamId = `${STREAM}-unsafe-${index}`;
        await seedDelegatingFeature(PLAN, streamId, branch);
        const result = await prepare({ featureId: streamId });
        expect(result.success, branch).toBe(false);
        if (!result.success) expect(result.error.code).toBe('BASE_UNRESOLVED');
        expect(await preparedRows(streamId)).toEqual([]);
      }
    });

    it('Prepare_NoSubject_IsRefused', async () => {
      await expectRefused(await prepare({}), 'INVALID_INPUT');
    });
  });
});

/** The recompile of a continuation after one revision that names the task that is not ready. */
const NAMED_RECOMPILE = {
  priorCapsuleVersion: 1,
  priorDesignVersion: 1,
  nextDesignVersion: 2,
  declaredTasks: ['task-named'],
  invalidatedTasks: ['task-named', 'task-after'],
};

/** A response in the form that a carrier parses against the declared output schema. */
function wireEnvelopeOf(data: unknown): unknown {
  return JSON.parse(
    JSON.stringify({ success: true, data, next_actions: [], _meta: {}, _perf: { ms: 0, bytes: 0, tokens: 0 } }),
  );
}

/** The error code of a refused call, or undefined for a call that succeeded. */
function refusalCodeOf(result: ToolResult): string | undefined {
  return result.success ? undefined : result.error?.code;
}

/**
 * The first prepare after a design revision is a continuation. It compiles the ready frontier as
 * an ordinary prepare does, and its commit also holds one `capsule.recompiled` row.
 *
 * In most cases the revision names the task that waits on a task of the first batch. Thus the
 * named task is not ready at the continuation, and one more task waits on it.
 */
describe('prepare — the continuation after a design revision', () => {
  /**
   * The continuation appends two rows: the recompile row, and then the prepared record. Both tasks
   * of the batch have announcements from the first prepare, so the commit announces nothing.
   * The row names the capsule of its commit by version and digest, and it references the same
   * bundle as the record. The test reads that bundle back from custody.
   */
  it('Prepare_AContinuation_RecordsTheSliceAheadOfThePreparedRecord', async () => {
    const { next, appended } = await continuationAfter(['task-named']);
    expect(next.capsuleVersion).toBe(2);
    expect(next.capsule.identity.designVersion).toBe('design-v2');
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-ready', 'task-open']);

    expect(appended.map((e) => e.type)).toEqual(['capsule.recompiled', 'workflow.prepared']);
    const [row, record] = appended;
    if (row === undefined || record === undefined) throw new Error('unreachable');
    const recompiled = CapsuleRecompiledData.parse(row.data);
    expect(recompiled).toStrictEqual({
      operationId: next.operationId,
      workflowId: STREAM,
      capsuleVersion: 2,
      capsuleDigest: next.capsuleDigest,
      ...NAMED_RECOMPILE,
      bundleRefs: next.bundleRefs,
    });
    expect(row.timestamp).toBe(COMPILED_AT);
    expect(record.sequence).toBe(row.sequence + 1);
    expect(next.tailSequence).toBe(record.sequence);

    const prepared = WorkflowPreparedData.parse(record.data);
    expect(prepared.capsuleVersion).toBe(2);
    expect(prepared.capsuleDigest).toBe(recompiled.capsuleDigest);
    expect(prepared.bundleRefs).toEqual(recompiled.bundleRefs);
    const digest = recompiled.bundleRefs[0]?.digest;
    if (digest === undefined) throw new Error('the recompile row references no bundle');
    expect(await store.bundleStore.has(digest)).toBe('ok');
    const found = await findPreparedCapsule(wiring(), STREAM, 2);
    if (!found.found) throw new Error('the recompiled capsule was not found');
    expect(capsuleDigest(found.capsule)).toBe(recompiled.capsuleDigest);
  });

  /**
   * The receipt of the first prepare has no recompile. The receipt of the continuation has the
   * versions and the two task lists of its row. The output schema that the registry declares
   * accepts the receipt, and it refuses a recompile whose task list is not a list.
   */
  it('Prepare_AContinuationReceipt_CarriesTheRecompile', async () => {
    const { first, next } = await continuationAfter(['task-named']);
    expect(first).not.toHaveProperty('recompile');
    expect(next.recompile).toStrictEqual(NAMED_RECOMPILE);
    expect(await recompileRows()).toMatchObject([NAMED_RECOMPILE]);

    const declared = findActionInRegistry('exarchos_orchestrate', 'prepare')?.outputSchema;
    if (declared === undefined) throw new Error('the registry declares no output schema for prepare');
    expect(declared.safeParse(wireEnvelopeOf(first)).success).toBe(true);
    expect(declared.safeParse(wireEnvelopeOf(next)).success).toBe(true);
    const malformed = { ...next, recompile: { ...NAMED_RECOMPILE, invalidatedTasks: 'task-named' } };
    expect(declared.safeParse(wireEnvelopeOf(malformed)).success).toBe(false);
  });

  /**
   * Both revisions come before the continuation, so one row records them. The row spans the
   * design versions of both. One task is in both revisions, and the row declares it once.
   */
  it('Prepare_TwoRevisionsBeforeOneContinuation_AreOneRowSpanningBothVersions', async () => {
    const { next, appended } = await continuationAfter(['task-named'], ['task-named', 'task-apart']);
    expect((await revisionRows()).map((row) => [row.priorDesignVersion, row.nextDesignVersion])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(next.capsuleVersion).toBe(2);
    expect(next.capsule.identity.designVersion).toBe('design-v3');

    const spanning = {
      priorCapsuleVersion: 1,
      priorDesignVersion: 1,
      nextDesignVersion: 3,
      declaredTasks: ['task-apart', 'task-named'],
      invalidatedTasks: ['task-named', 'task-after', 'task-apart'],
    };
    expect(appended.map((e) => e.type)).toEqual(['capsule.recompiled', 'workflow.prepared']);
    expect(await recompileRows()).toMatchObject([spanning]);
    expect(next.recompile).toStrictEqual(spanning);
  });

  /** The revision changes the design and names no task. The continuation still leaves its row. */
  it('Prepare_ARevisionThatNamesNoTask_StillRecordsARowWithEmptyLists', async () => {
    const { next, appended } = await continuationAfter([]);
    expect((await revisionRows()).map((row) => row.affectedTasks)).toEqual([[]]);
    expect(next.capsule.identity.designVersion).toBe('design-v2');

    const empty = {
      priorCapsuleVersion: 1,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      declaredTasks: [],
      invalidatedTasks: [],
    };
    expect(appended.map((e) => e.type)).toEqual(['capsule.recompiled', 'workflow.prepared']);
    expect(await recompileRows()).toMatchObject([empty]);
    expect(next.recompile).toStrictEqual(empty);
  });

  /**
   * The named task waits on a task of the batch, so the continuation does not compile it or
   * announce it. After that task completes, an ordinary prepare compiles the named task under the
   * same design version.
   */
  it('Prepare_AnInvalidatedTaskThatIsNotReady_IsNamedOnTheRowAndCompiledByALaterPrepare', async () => {
    const { next } = await continuationAfter(['task-named']);
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-ready', 'task-open']);
    expect((await recompileRows()).map((row) => row.invalidatedTasks)).toEqual([['task-named', 'task-after']]);
    expect(await announcedTasks()).toEqual(['task-ready', 'task-open']);

    await replan(completing(CONTINUATION_PLAN, 'task-ready'));
    const later = receiptOf(await prepare({ featureId: STREAM }));
    expect(later.capsuleVersion).toBe(3);
    expect(later.capsule.identity.designVersion).toBe('design-v2');
    expect(later.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-open', 'task-named']);
    expect(later).not.toHaveProperty('recompile');
    expect(await recompileRows()).toHaveLength(1);
    expect(await announcedTasks()).toEqual(['task-ready', 'task-open', 'task-named']);
  });

  /**
   * The twin stream holds the same plan and the same plan change, and no revision. The plan
   * change makes the named task ready before the continuation. Both prepares compile the same
   * graph and announce that one task. The task that waits on it is on the row and has no
   * announcement. The continuation writes no state document.
   */
  it('Prepare_AContinuation_AnnouncesOnlyWhatAnOrdinaryPrepareWould', async () => {
    const twin = `${STREAM}-twin`;
    await seedDelegatingFeature(CONTINUATION_PLAN);
    await seedDelegatingFeature(CONTINUATION_PLAN, twin);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    receiptOf(await prepare({ featureId: twin }));
    await revise(first, 'batch-revising', ['task-named']);
    const moved = completing(CONTINUATION_PLAN, 'task-ready');
    await replan(moved);
    await replan(moved, twin);

    const before = await rowCount();
    const twinBefore = await rowCount(twin);
    const continued = receiptOf(await prepare({ featureId: STREAM }));
    const ordinary = receiptOf(await prepare({ featureId: twin }));

    expect(continued.recompile?.invalidatedTasks).toEqual(['task-named', 'task-after']);
    expect(ordinary).not.toHaveProperty('recompile');
    expect(continued.capsule.graph).toEqual(ordinary.capsule.graph);
    expect(continued.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-open', 'task-named']);

    expect((await rowsAfter(before)).map((e) => e.type)).toEqual([
      'task.assigned',
      'capsule.recompiled',
      'workflow.prepared',
    ]);
    expect((await rowsAfter(twinBefore, twin)).map((e) => e.type)).toEqual(['task.assigned', 'workflow.prepared']);
    expect(await announcedTasks()).toEqual(['task-ready', 'task-open', 'task-named']);
    expect(await announcedTasks(twin)).toEqual(await announcedTasks());
    expect((await readdir(stateDir)).filter((name) => name.endsWith('.state.json'))).toEqual([]);
  });

  /**
   * The case above finds no state document, and a prepare that writes to a document that is absent
   * also leaves none. Here the state directory holds the document of the workflow before the
   * continuation. The document lists the two invalidated tasks as unfinished.
   * The continuation records its recompile, and the bytes of the document are the same after it.
   */
  it('Prepare_AContinuationBesideAStateDocument_LeavesTheDocumentAsItWas', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    await revise(first, 'batch-revising', ['task-named']);
    const { stateFile } = await initStateFile(stateDir, STREAM, 'feature', {
      phase: 'delegate',
      tasks: CONTINUATION_PLAN.map((task) => ({ id: task.id, title: `title of ${task.id}`, status: task.status })),
    });
    expect((await readdir(stateDir)).filter((name) => name.endsWith('.state.json'))).toEqual([path.basename(stateFile)]);
    const before = await readFile(stateFile);
    const document: unknown = JSON.parse(before.toString('utf8'));
    expect(document).toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({ id: 'task-named', status: 'pending' }),
        expect.objectContaining({ id: 'task-after', status: 'pending' }),
      ]),
    });

    const continued = receiptOf(await prepare({ featureId: STREAM }));
    expect(continued.recompile?.invalidatedTasks).toEqual(['task-named', 'task-after']);
    expect(await recompileRows()).toHaveLength(1);
    expect((await readFile(stateFile)).equals(before)).toBe(true);
  });

  /** The retry gets its answer from the claim of the continuation. It appends no row and writes no blob. */
  it('Prepare_ARetriedContinuation_ReturnsTheRecordedCapsuleAndAppendsNothing', async () => {
    const { next } = await continuationAfter(['task-named']);
    const rows = await rowCount();
    const blobs = await bundleBlobCount();

    const retried = receiptOf(await prepare({ featureId: STREAM }));
    expect(retried).toEqual(next);
    expect(retried.recompile).toStrictEqual(NAMED_RECOMPILE);
    expect(await rowCount()).toBe(rows);
    expect(await recompileRows()).toHaveLength(1);
    expect(await preparedRows()).toHaveLength(2);
    expect(await bundleBlobCount()).toBe(blobs);
  });

  /**
   * The stream moves after the continuation reads its tail. The commit is refused, and the only
   * new row is the one that moved the stream. The revision is still pending, so the retry records
   * the recompile. A second retry replays that receipt.
   */
  it('Prepare_AContinuationThatLosesTheRace_AppendsNothingAndTheRetryRecordsOnce', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    await revise(first, 'batch-revising', ['task-named']);
    const before = await rowCount();

    const lost = await prepareThroughARace();
    expect(refusalCodeOf(lost), JSON.stringify(lost)).toBe('CONCURRENCY_CONFLICT');
    expect((await rowsAfter(before)).map((e) => e.type)).toEqual(['state.patched']);
    expect(await recompileRows()).toEqual([]);
    expect(await preparedRows()).toHaveLength(1);

    const retried = receiptOf(await prepare({ featureId: STREAM }));
    expect(retried.capsuleVersion).toBe(2);
    expect(retried.recompile).toStrictEqual(NAMED_RECOMPILE);
    expect((await rowsAfter(before)).map((e) => e.type)).toEqual([
      'state.patched',
      'capsule.recompiled',
      'workflow.prepared',
    ]);

    expect(receiptOf(await prepare({ featureId: STREAM }))).toEqual(retried);
    expect(await recompileRows()).toHaveLength(1);
    expect(await preparedRows()).toHaveLength(2);
  });

  /** The plan changes between two prepares, and no decision round revises the design. */
  it('Prepare_WithNoRevision_EmitsNoRecompileRecord', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    await replan(completing(CONTINUATION_PLAN, 'task-ready'));
    const second = receiptOf(await prepare({ featureId: STREAM }));

    expect(second.capsuleVersion).toBe(2);
    expect(await revisionRows()).toEqual([]);
    expect(first).not.toHaveProperty('recompile');
    expect(second).not.toHaveProperty('recompile');
    expect(await recompileRows()).toEqual([]);
    expect((await store.query(STREAM)).map((e) => e.type)).not.toContain('capsule.recompiled');
  });

  /**
   * The prepared record of the continuation comes after the revision, so the revision is not
   * pending for the next prepare. That prepare compiles the changed plan under the same design
   * version, and its commit holds one announcement and the record.
   */
  it('Prepare_AfterAContinuationAndAChangedPlan_TheNextPrepareIsOrdinary', async () => {
    await continuationAfter(['task-named']);
    await replan(completing(CONTINUATION_PLAN, 'task-open'));
    const before = await rowCount();

    const ordinary = receiptOf(await prepare({ featureId: STREAM }));
    expect(ordinary.capsuleVersion).toBe(3);
    expect(ordinary.capsule.identity.designVersion).toBe('design-v2');
    expect(ordinary.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-ready', 'task-apart']);
    expect(ordinary).not.toHaveProperty('recompile');
    expect((await rowsAfter(before)).map((e) => e.type)).toEqual(['task.assigned', 'workflow.prepared']);
    expect(await recompileRows()).toHaveLength(1);
  });

  /**
   * Each task completes after the revision and before the next prepare. The refusal appends no
   * row and writes no blob. The refusal also leaves the revision pending. When the plan holds its
   * unfinished tasks again, the next prepare is the continuation of the same revision.
   */
  it('Prepare_APendingRevisionWithEveryTaskComplete_IsRefusedAndRecordsNothing', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    await revise(first, 'batch-revising', ['task-named']);
    await replan(completing(CONTINUATION_PLAN, ...CONTINUATION_PLAN.map((task) => task.id)));
    const rows = await rowCount();
    const blobs = await bundleBlobCount();

    const refused = await prepare({ featureId: STREAM });
    expect(refusalCodeOf(refused), JSON.stringify(refused)).toBe('NOTHING_TO_PREPARE');
    expect(await rowCount()).toBe(rows);
    expect(await recompileRows()).toEqual([]);
    expect(await preparedRows()).toHaveLength(1);
    expect(await bundleBlobCount()).toBe(blobs);

    await replan(CONTINUATION_PLAN);
    const before = await rowCount();
    const continued = receiptOf(await prepare({ featureId: STREAM }));
    expect(continued.capsuleVersion).toBe(2);
    expect(continued.capsule.identity.designVersion).toBe('design-v2');
    expect(continued.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-ready', 'task-open']);
    expect(continued.recompile).toStrictEqual(NAMED_RECOMPILE);
    expect((await rowsAfter(before)).map((e) => e.type)).toEqual(['capsule.recompiled', 'workflow.prepared']);
    expect(await recompileRows()).toMatchObject([NAMED_RECOMPILE]);
  });

  /**
   * After the revision, the two tasks of the first batch wait on each other, so no task is ready.
   * The refusal appends no row. When the plan is as it was, the next prepare is the continuation
   * of the same revision.
   */
  it('Prepare_APendingRevisionWhoseTasksAreAllBlocked_IsRefusedAndStaysPending', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    await revise(first, 'batch-revising', ['task-named']);
    const waitsOn: Readonly<Record<string, string>> = { 'task-ready': 'task-open', 'task-open': 'task-ready' };
    await replan(
      CONTINUATION_PLAN.map((task) => {
        const blocker = waitsOn[task.id];
        return blocker === undefined ? task : { ...task, blockedBy: [blocker] };
      }),
    );
    const rows = await rowCount();
    const blobs = await bundleBlobCount();

    const refused = await prepare({ featureId: STREAM });
    expect(refusalCodeOf(refused), JSON.stringify(refused)).toBe('NO_READY_TASKS');
    expect(await rowCount()).toBe(rows);
    expect(await recompileRows()).toEqual([]);
    expect(await bundleBlobCount()).toBe(blobs);

    await replan(CONTINUATION_PLAN);
    const before = await rowCount();
    const continued = receiptOf(await prepare({ featureId: STREAM }));
    expect(continued.capsuleVersion).toBe(2);
    expect(continued.recompile).toStrictEqual(NAMED_RECOMPILE);
    expect((await rowsAfter(before)).map((e) => e.type)).toEqual(['capsule.recompiled', 'workflow.prepared']);
    expect(await recompileRows()).toMatchObject([NAMED_RECOMPILE]);
  });
});

/** The statement that the revision of `revise` gives, and its one material deviation. */
const REVISED_FINDING = 'the store was not SQLite';

/**
 * A capsule under a revised design states the accepted changes as bound knowledge.
 * Each revision comes from a real decision round of `settle`, so its bundle is in custody.
 * A case that makes a bundle unreadable removes its blob from the store of the test, or damages it.
 */
describe('prepare — the accepted design changes as knowledge', () => {
  /**
   * The capsule before the revision states only the design of record. The capsule after it also
   * states the accepted deviation and its actor, and not the deviation that the round rejected.
   * The capsule in custody holds the same statements.
   */
  it('Prepare_ACapsuleAfterARevision_BindsTheAcceptedStatementAndItsActor', async () => {
    const { first, next } = await continuationAfter(['task-named']);
    expect(designBinding(first).rationale).toEqual([DESIGN_OF_RECORD]);
    expect(first.capsule.provenance.sources.map((source) => source.sourceId)).not.toContain('design-revisions');

    expect(next.capsule.identity.designVersion).toBe('design-v2');
    expect(designBinding(next).rationale).toEqual([DESIGN_OF_RECORD, acceptedStatement(2, REVISED_FINDING)]);
    expect(next.capsule.provenance.sources.filter((source) => source.sourceId === 'design-revisions')).toEqual([
      { sourceId: 'design-revisions', digest: contentDigest(await revisionRows()) },
    ]);

    const found = await findPreparedCapsule(wiring(), STREAM, 2);
    if (!found.found) throw new Error('the capsule of the continuation was not found');
    expect(found.capsule.knowledge.rationale).toEqual(next.capsule.knowledge.rationale);
  });

  it('Prepare_ARevisionWithAProposedChange_BindsTheChange', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const finding = 'the endpoint reads a cache that the design did not name';
    const proposedChange = 'the named task reads the cache through the adapter';
    await decide(first, 'batch-revising', [
      {
        deviationKind: 'invalidated-assumption',
        statement: finding,
        decision: 'accepted',
        affectedTasks: ['task-named'],
        proposedChange,
        actor: 'policy:design-board',
      },
    ]);

    const next = receiptOf(await prepare({ featureId: STREAM }));
    expect(designBinding(next).rationale).toEqual([
      DESIGN_OF_RECORD,
      'Design version 2 holds an accepted change. Decided by "policy:design-board". ' +
        'Proposed change: "the named task reads the cache through the adapter". ' +
        'Deviation: "the endpoint reads a cache that the design did not name".',
    ]);
    expect(acceptedStatement(2, finding, proposedChange, 'policy:design-board')).toBe(
      designBinding(next).rationale[1],
    );
  });

  /**
   * One round accepts two material deviations, each with its own actor. The row names both ids.
   * The capsule states both, in the order of the ids on the row, and each with its own actor.
   */
  it('Prepare_ARevisionCoveringTwoDeviations_BindsTwoStatements', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const durable = { statement: 'the queue was not durable', actor: 'human:architect' };
    const shared = { statement: 'the cache was not shared', actor: 'human:operator' };
    const round = await decide(first, 'batch-revising', [
      { deviationKind: 'invalidated-assumption', decision: 'accepted', affectedTasks: ['task-named'], ...durable },
      { deviationKind: 'invalidated-assumption', decision: 'accepted', ...shared },
    ]);
    expect(await revisionRows()).toHaveLength(1);
    expect([...round.row.deviationIds].sort()).toEqual(
      [round.idOf(durable.statement), round.idOf(shared.statement)].sort(),
    );

    const next = receiptOf(await prepare({ featureId: STREAM }));
    const stated = round.row.deviationIds.map((deviationId) => {
      const change = deviationId === round.idOf(durable.statement) ? durable : shared;
      return acceptedStatement(2, change.statement, undefined, change.actor);
    });
    expect(stated).toHaveLength(2);
    expect(designBinding(next).rationale).toEqual([DESIGN_OF_RECORD, ...stated]);
  });

  /**
   * The bundle of the round holds four deviations and two accepted decisions.
   * One accepted deviation is material, and the row names that one alone.
   * The capsule states it, and it states no other deviation of the bundle.
   */
  it('Prepare_ARoundThatAlsoRejectedOrAcceptedANonMaterialDeviation_BindsOnlyWhatTheRevisionNames', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const round = await decide(first, 'batch-revising', [
      {
        deviationKind: 'invalidated-assumption',
        statement: 'the queue was not durable',
        decision: 'accepted',
        affectedTasks: ['task-named'],
      },
      { deviationKind: 'invalidated-assumption', statement: 'the cache was not shared', decision: 'rejected' },
      { deviationKind: 'missing-context', statement: 'the capsule did not name the region', decision: 'accepted' },
    ]);
    expect(round.row.deviationIds).toEqual([round.idOf('the queue was not durable')]);
    const bundle = decodeSettlementBundle(await store.bundleStore.resolve(bundleDigestOf(round.row)));
    expect(bundle.deviations.map((deviation) => deviation.statement).sort()).toEqual([
      'batch-revising did not name the port',
      'the cache was not shared',
      'the capsule did not name the region',
      'the queue was not durable',
    ]);
    expect(bundle.decisions?.filter((decision) => decision.decision === 'accepted')).toHaveLength(2);

    const next = receiptOf(await prepare({ featureId: STREAM }));
    expect(designBinding(next).rationale).toEqual([
      DESIGN_OF_RECORD,
      acceptedStatement(2, 'the queue was not durable'),
    ]);
  });

  /**
   * The prepare after the continuation is ordinary: it records no recompile, and its batch holds
   * no task that the revision names. Its capsule states the accepted change as the continuation did.
   */
  it('Prepare_AnOrdinaryPrepareAfterAContinuation_StillBindsTheAcceptedChanges', async () => {
    const { next } = await continuationAfter(['task-named']);
    await replan(completing(CONTINUATION_PLAN, 'task-open'));

    const ordinary = receiptOf(await prepare({ featureId: STREAM }));
    expect(ordinary.capsuleVersion).toBe(3);
    expect(ordinary).not.toHaveProperty('recompile');
    expect(ordinary.capsule.identity.designVersion).toBe('design-v2');
    expect(ordinary.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-ready', 'task-apart']);
    expect(designBinding(ordinary).rationale).toEqual([DESIGN_OF_RECORD, acceptedStatement(2, REVISED_FINDING)]);
    expect(designBinding(ordinary).rationale).toEqual(designBinding(next).rationale);
  });

  /**
   * The stream holds two revisions, and the first covers two deviations. The second prepare passes
   * another compiler name, so no claim answers it. It compiles again from the same rows, the same
   * bundles and the same batch, and it reads each bundle again. Both capsules state the same changes
   * in the same order.
   */
  it('Prepare_TwoPreparesWithTheSameInputs_BindTheSameStatements', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    await decide(first, 'batch-revising-both', [
      { deviationKind: 'invalidated-assumption', statement: 'the queue was not durable', decision: 'accepted' },
      {
        deviationKind: 'invalidated-assumption',
        statement: 'the cache was not shared',
        decision: 'accepted',
        affectedTasks: ['task-named'],
        proposedChange: 'the named task reads the shared cache',
      },
    ]);
    await revise(first, 'batch-revising-one', ['task-apart']);

    const one = receiptOf(await prepare({ featureId: STREAM }));
    const again = countingBundleStore();
    const two = receiptOf(
      await runWithDispatchContext(correlation(), () =>
        handlePrepare({ featureId: STREAM }, stateDir, wiring(), {
          bundleStore: again.bundles,
          catalogInvariants: () => [],
          now: () => COMPILED_AT,
          compilerVersion: 'exarchos-prepare-another',
        }),
      ),
    );

    expect([one.capsuleVersion, two.capsuleVersion]).toEqual([2, 3]);
    expect(two.operationId).not.toBe(one.operationId);
    expect([...again.read].sort()).toEqual((await revisionRows()).map((row) => bundleDigestOf(row).value).sort());
    expect(designBinding(one).rationale).toHaveLength(4);
    expect(designBinding(one).rationale[1]).toBe(acceptedStatement(3, REVISED_FINDING));
    expect(designBinding(two).rationale).toEqual(designBinding(one).rationale);
  });

  /**
   * The seam answers the read of the bundle of a revision with another real bundle in custody.
   * The bundle of the submitting round holds the same deviations and no decision.
   * The bundle of another round holds an accepted deviation of another batch, so its id is different.
   * Each call is refused and records nothing. Through the store of the test, the same prepare compiles.
   */
  it('Prepare_ABundleThatLacksANamedDeviation_IsRefusedAsUnreadable', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const material: StagedDeviation = {
      deviationKind: 'invalidated-assumption',
      statement: 'the queue was not durable',
      decision: 'accepted',
      affectedTasks: ['task-named'],
    };
    const round = await decide(first, 'batch-revising', [material]);
    const other = await decide(first, 'batch-revising-apart', [material]);
    const named = round.idOf(material.statement);
    expect(other.idOf(material.statement)).not.toBe(named);
    const heldRef = round.held.bundleRefs?.[0];
    if (heldRef === undefined) throw new Error('the held receipt names no bundle');
    const rows = await rowCount();
    const blobs = await bundleBlobCount();

    const undecided = await prepareThrough(bundleStoreAnswering(bundleDigestOf(round.row), heldRef.digest));
    expect(refusalCodeOf(undecided), JSON.stringify(undecided)).toBe('REVISION_UNREADABLE');
    if (!undecided.success) {
      expect(undecided.error.message).toContain(`lacks an accepted decision for the deviation "${named}"`);
      expect(undecided.error.message).toContain('design version 2');
    }

    const foreign = await prepareThrough(bundleStoreAnswering(bundleDigestOf(round.row), bundleDigestOf(other.row)));
    expect(refusalCodeOf(foreign), JSON.stringify(foreign)).toBe('REVISION_UNREADABLE');
    if (!foreign.success) expect(foreign.error.message).toContain(`lacks the deviation "${named}"`);

    expect(await rowCount()).toBe(rows);
    expect(await preparedRows()).toHaveLength(1);
    expect(await recompileRows()).toEqual([]);
    expect(await bundleBlobCount()).toBe(blobs);

    const decisionOnly = await editedBundleOf(round.row, (bundle) => ({
      ...bundle,
      deviations: bundle.deviations.filter((deviation) => deviation.statement !== material.statement),
    }));
    const stripped = decodeSettlementBundle(await store.bundleStore.resolve(decisionOnly));
    expect(stripped.decisions).toContainEqual(expect.objectContaining({ deviationId: named, decision: 'accepted' }));
    expect(stripped.deviations.map((deviation) => deviation.statement)).toEqual(['batch-revising did not name the port']);
    const withoutDeviation = await prepareThrough(bundleStoreAnswering(bundleDigestOf(round.row), decisionOnly));
    expect(refusalCodeOf(withoutDeviation), JSON.stringify(withoutDeviation)).toBe('REVISION_UNREADABLE');
    expect(withoutDeviation.error?.message).toContain(`lacks the deviation "${named}"`);
    expect(await rowCount()).toBe(rows);
    expect(await preparedRows()).toHaveLength(1);

    const compiled = receiptOf(await prepare({ featureId: STREAM }));
    expect(compiled.capsuleVersion).toBe(2);
    expect(designBinding(compiled).rationale).toHaveLength(3);
  });

  /**
   * The edited bundle is the real bundle of the round with one decision changed: it rejects the
   * deviation that the row names. The seam answers the read of the revision with that bundle.
   * The bundle still holds the deviation and a decision for it, so only the answer of the decision refuses it.
   * The call records nothing. Through the store of the test, the same prepare compiles.
   */
  it('Prepare_ABundleWhoseNamedDeviationWasRejected_IsRefusedAsUnreadable', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const round = await decide(first, 'batch-revising', [acceptedMaterial('the queue was not durable', ['task-named'])]);
    const named = round.idOf('the queue was not durable');
    expect(round.row.deviationIds).toEqual([named]);

    const rejecting = await editedBundleOf(round.row, (bundle) => ({
      ...bundle,
      decisions: (bundle.decisions ?? []).map((decision) =>
        decision.deviationId === named ? { ...decision, decision: 'rejected' } : decision,
      ),
    }));
    const edited = decodeSettlementBundle(await store.bundleStore.resolve(rejecting));
    expect(edited.decisions?.map((decision) => decision.decision)).toEqual(['rejected', 'rejected']);
    expect(edited.decisions?.map((decision) => decision.deviationId)).toContain(named);
    expect(edited.deviations.map((deviation) => deviation.statement)).toContain('the queue was not durable');
    const rows = await rowCount();
    const blobs = await bundleBlobCount();

    const refused = await prepareThrough(bundleStoreAnswering(bundleDigestOf(round.row), rejecting));
    expect(refusalCodeOf(refused), JSON.stringify(refused)).toBe('REVISION_UNREADABLE');
    expect(refused.error?.message).toContain(`lacks an accepted decision for the deviation "${named}"`);
    expect(refused.error?.message).toContain('design version 2');
    expect(await rowCount()).toBe(rows);
    expect(await preparedRows()).toHaveLength(1);
    expect(await recompileRows()).toEqual([]);
    expect(await bundleBlobCount()).toBe(blobs);

    const compiled = receiptOf(await prepare({ featureId: STREAM }));
    expect(compiled.capsuleVersion).toBe(2);
    expect(designBinding(compiled).rationale).toEqual([
      DESIGN_OF_RECORD,
      acceptedStatement(2, 'the queue was not durable'),
    ]);
  });

  /**
   * The stream holds one revision. The continuation is recorded through the seam, under the name of
   * an earlier compiler. The production call passes no name, so that claim does not answer it.
   * It compiles the next capsule version from the same batch, and that capsule states the accepted change.
   * The revision is not pending after the continuation, so the production call records no recompile.
   */
  it('Prepare_AClaimFromAnEarlierCompilerOnARevisedStream_IsCompiledAgainWithTheAcceptedChanges', async () => {
    expect(EARLIER_COMPILER_VERSION).not.toBe(PREPARE_COMPILER_VERSION);
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    await revise(first, 'batch-revising', ['task-named']);

    const recorded = receiptOf(await prepareAsCompiler(EARLIER_COMPILER_VERSION));
    expect(recorded.capsuleVersion).toBe(2);
    expect(recorded.capsule.provenance.compilerVersion).toBe(EARLIER_COMPILER_VERSION);
    expect(recorded.recompile).toStrictEqual(NAMED_RECOMPILE);

    const prepared = receiptOf(await prepare({ featureId: STREAM }));
    expect(prepared.capsuleVersion).toBe(3);
    expect(prepared.operationId).not.toBe(recorded.operationId);
    expect(prepared.capsule.provenance.compilerVersion).toBe(PREPARE_COMPILER_VERSION);
    expect(prepared.capsule.identity.designVersion).toBe('design-v2');
    expect(prepared.capsule.graph).toEqual(recorded.capsule.graph);
    expect(designBinding(prepared).rationale).toEqual([DESIGN_OF_RECORD, acceptedStatement(2, REVISED_FINDING)]);
    expect(prepared).not.toHaveProperty('recompile');

    const records = (await preparedRows()).map((row) => WorkflowPreparedData.parse(row));
    expect(records.map((row) => [row.capsuleVersion, row.designVersion, row.compilerVersion])).toEqual([
      [1, 'design-v1', PREPARE_COMPILER_VERSION],
      [2, 'design-v2', EARLIER_COMPILER_VERSION],
      [3, 'design-v2', PREPARE_COMPILER_VERSION],
    ]);
    expect(await recompileRows()).toHaveLength(1);
  });

  /**
   * One round accepts twelve material deviations. One of them names the task that the next capsule
   * compiles, and its id is the last on the row. Five of the others name a task outside that capsule.
   * The first eight ids of the row do not hold the last one, and the position check keeps that true.
   * The capsule states that change first, and then the first seven of the others in row order.
   * The last statement counts the four changes that the capsule does not state.
   */
  it('Prepare_ARoundOfManyDeviationsWithOneThatNamesACapsuleTask_BindsThatChangeFirst', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const others = Array.from({ length: 11 }, (_, index) =>
      acceptedMaterial(`assumption ${index} did not hold`, index % 2 === 1 ? ['task-apart'] : undefined),
    );
    const naming = acceptedMaterial(REVISED_FINDING, ['task-named']);
    const round = await decide(first, 'batch-revising-many', [...others.slice(0, 5), naming, ...others.slice(5)]);
    const namingId = round.idOf(naming.statement);
    expect(round.row.deviationIds).toHaveLength(12);
    expect(round.row.affectedTasks).toEqual(['task-apart', 'task-named']);
    expect(round.row.deviationIds.indexOf(namingId)).toBeGreaterThanOrEqual(8);
    await replan(completing(CONTINUATION_PLAN, 'task-ready'));

    const next = receiptOf(await prepare({ featureId: STREAM }));
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-open', 'task-named']);

    const statedInRowOrder = round.row.deviationIds
      .filter((deviationId) => deviationId !== namingId)
      .map((deviationId) => {
        const deviation = others.find((candidate) => round.idOf(candidate.statement) === deviationId);
        if (deviation === undefined) throw new Error(`the row names ${deviationId}, which no staged deviation has`);
        return acceptedStatement(2, deviation.statement);
      });
    expect(statedInRowOrder).toHaveLength(11);
    expect(designBinding(next).rationale).toEqual([
      DESIGN_OF_RECORD,
      acceptedStatement(2, naming.statement),
      ...statedInRowOrder.slice(0, 7),
      leftOutStatement(4),
    ]);
  });

  /**
   * Three rounds revise the design. The oldest accepts three deviations. One names the task that the
   * next capsule compiles, one names no task, and one names a task outside that capsule.
   * The middle round accepts two, and one of them names the task of the capsule. The newest accepts one.
   *
   * The capsule states the two changes that name its task first, the one of the newer revision ahead.
   * The other four follow from the newest revision down, and the two of the oldest keep the order of its row.
   * The seam records each read. The prepare reads the two revisions that name the task, the newer one
   * ahead, and then the third. It reads no bundle twice.
   */
  it('Prepare_ChangesThatNameACapsuleTask_ComeFirstAcrossRevisionsNewestFirst', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const oldestPlain = 'the oldest round found a change with no task';
    const oldestApart = 'the oldest round found a change apart';
    const oldest = await decide(first, 'batch-revising-oldest', [
      acceptedMaterial(oldestPlain),
      acceptedMaterial('the oldest round found a change of the named task', ['task-named']),
      acceptedMaterial(oldestApart, ['task-apart']),
    ]);
    const middle = await decide(first, 'batch-revising-middle', [
      acceptedMaterial('the middle round found a change with no task'),
      acceptedMaterial('the middle round found a change of the named task', ['task-after', 'task-named']),
    ]);
    const newest = await decide(first, 'batch-revising-newest', [
      acceptedMaterial('the newest round found a change with no task'),
    ]);
    expect([oldest, middle, newest].map((round) => [round.row.nextDesignVersion, round.row.deviationIds.length])).toEqual([
      [2, 3],
      [3, 2],
      [4, 1],
    ]);
    await replan(completing(CONTINUATION_PLAN, 'task-ready'));

    const counting = countingBundleStore();
    const next = receiptOf(await prepareThrough(counting.bundles));
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-open', 'task-named']);

    const oldestRest = new Map([oldestPlain, oldestApart].map((statement) => [oldest.idOf(statement), statement]));
    const oldestRestInRowOrder = oldest.row.deviationIds.flatMap((deviationId) => {
      const statement = oldestRest.get(deviationId);
      return statement === undefined ? [] : [statement];
    });
    expect(oldestRestInRowOrder).toHaveLength(2);
    expect(designBinding(next).rationale).toEqual([
      DESIGN_OF_RECORD,
      acceptedStatement(3, 'the middle round found a change of the named task'),
      acceptedStatement(2, 'the oldest round found a change of the named task'),
      acceptedStatement(4, 'the newest round found a change with no task'),
      acceptedStatement(3, 'the middle round found a change with no task'),
      ...oldestRestInRowOrder.map((statement) => acceptedStatement(2, statement)),
    ]);
    expect(counting.read).toEqual([middle, oldest, newest].map((round) => bundleDigestOf(round.row).value));
  });

  /**
   * Ten revisions name thirteen changes. The first names the task that the next capsule compiles.
   * The second covers three deviations, and one of them names that task. Those two changes are bound first.
   * The six newest revisions follow, and the last statement counts the five changes that are left out.
   *
   * The seam records each read. The prepare reads the two revisions that name the task, and then the
   * six newest, each one once. The third revision covers two deviations and the fourth covers one.
   * No change of them is bound, and the prepare reads neither bundle.
   */
  it('Prepare_OnlyTheBundlesOfBoundRevisions_AreRead', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const namedOfThree = 'the second round found a change of the named task';
    await revise(first, 'batch-revising-0', ['task-named']);
    await decide(first, 'batch-revising-1', [
      acceptedMaterial('the second round found a change with no task'),
      acceptedMaterial(namedOfThree, ['task-named']),
      acceptedMaterial('the second round found a change apart', ['task-apart']),
    ]);
    await decide(first, 'batch-revising-2', [
      acceptedMaterial('the third round found a change with no task'),
      acceptedMaterial('the third round found a change apart', ['task-apart']),
    ]);
    const staged = 10;
    for (let index = 3; index < staged; index += 1) {
      await revise(first, `batch-revising-${index}`, []);
    }
    await replan(completing(CONTINUATION_PLAN, 'task-ready'));
    const rows = await revisionRows();
    expect(rows.map((row) => [row.nextDesignVersion, row.deviationIds.length])).toEqual([
      [2, 1],
      [3, 3],
      [4, 2],
      [5, 1],
      [6, 1],
      [7, 1],
      [8, 1],
      [9, 1],
      [10, 1],
      [11, 1],
    ]);
    const digests = rows.map((row) => bundleDigestOf(row).value);
    expect(new Set(digests).size).toBe(staged);

    const counting = countingBundleStore();
    const next = receiptOf(await prepareThrough(counting.bundles));
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-open', 'task-named']);

    const restVersions = [11, 10, 9, 8, 7, 6];
    expect(designBinding(next).rationale).toEqual([
      DESIGN_OF_RECORD,
      acceptedStatement(3, namedOfThree),
      acceptedStatement(2, REVISED_FINDING),
      ...restVersions.map((version) => acceptedStatement(version, REVISED_FINDING)),
      leftOutStatement(5),
    ]);
    const readVersions = [3, 2, ...restVersions];
    expect(counting.read).toEqual(readVersions.map((version) => digests[version - 2]));
    const leftOutDigests = [digests[2], digests[3]];
    expect(counting.read.filter((digest) => leftOutDigests.includes(digest))).toEqual([]);
  });

  /**
   * Four faults, one after the other. A seam fails the read, and then it answers with a bundle of another kind.
   * Then the blob of the bundle is removed from the store, and a damaged blob takes its place.
   * Each prepare is refused with the fault of the bundle, and it appends no row and writes no blob.
   */
  it('Prepare_ARevisionWhoseBundleCannotBeRead_IsRefusedAndRecordsNothing', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const digest = bundleDigestOf(await revise(first, 'batch-revising', ['task-named']));
    const rows = await rowCount();
    const blobs = await bundleBlobCount();

    const faulted = await prepareThrough(failingBundleStore('EIO: the disk did not answer'));
    expect(refusalCodeOf(faulted), JSON.stringify(faulted)).toBe('REVISION_UNREADABLE');
    if (!faulted.success) expect(faulted.error.message).toContain('cannot be read (EIO: the disk did not answer)');

    const preparedRef = first.bundleRefs?.[0];
    if (preparedRef === undefined) throw new Error('the first receipt names no bundle');
    const otherKind = await prepareThrough(bundleStoreAnswering(digest, preparedRef.digest));
    expect(refusalCodeOf(otherKind), JSON.stringify(otherKind)).toBe('REVISION_UNREADABLE');
    if (!otherKind.success) expect(otherKind.error.message).toContain('does not decode as a settlement bundle');
    expect(await rowCount()).toBe(rows);
    expect(await bundleBlobCount()).toBe(blobs);

    await unlink(blobPath(digest));
    const removed = await prepare({ featureId: STREAM });
    expect(refusalCodeOf(removed), JSON.stringify(removed)).toBe('REVISION_UNREADABLE');
    if (!removed.success) {
      expect(removed.error.message).toContain('design version 2');
      expect(removed.error.message).toContain(`sha256:${digest.value}`);
      expect(removed.error.message).toContain('is not in the run-bundle store');
    }
    expect(await rowCount()).toBe(rows);
    expect(await bundleBlobCount()).toBe(blobs - 1);

    await writeFile(blobPath(digest), 'not the bytes of the bundle');
    const damaged = await prepare({ featureId: STREAM });
    expect(refusalCodeOf(damaged), JSON.stringify(damaged)).toBe('REVISION_UNREADABLE');
    if (!damaged.success) expect(damaged.error.message).toContain('does not match its digest');
    expect(await rowCount()).toBe(rows);
    expect(await bundleBlobCount()).toBe(blobs);
    expect(await preparedRows()).toHaveLength(1);
    expect(await recompileRows()).toEqual([]);
    expect((await store.query(STREAM)).map((e) => e.type)).not.toContain('capsule.recompiled');
  });

  /**
   * The refusal leaves no claim. Then the test puts the bytes of the bundle in the store again.
   * The same prepare is now the continuation of the revision, and it states the accepted change.
   */
  it('Prepare_ARevisionWhoseBundleIsRestored_CompilesOnTheRetry', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const digest = bundleDigestOf(await revise(first, 'batch-revising', ['task-named']));
    const bytes = await store.bundleStore.resolve(digest);
    await unlink(blobPath(digest));
    const refused = await prepare({ featureId: STREAM });
    expect(refusalCodeOf(refused), JSON.stringify(refused)).toBe('REVISION_UNREADABLE');

    expect(await store.bundleStore.put(bytes, digest)).toEqual(digest);
    const before = await rowCount();
    const retried = receiptOf(await prepare({ featureId: STREAM }));
    expect(retried.capsuleVersion).toBe(2);
    expect(retried.recompile).toStrictEqual(NAMED_RECOMPILE);
    expect(designBinding(retried).rationale).toEqual([DESIGN_OF_RECORD, acceptedStatement(2, REVISED_FINDING)]);
    expect((await rowsAfter(before)).map((e) => e.type)).toEqual(['capsule.recompiled', 'workflow.prepared']);
    expect(receiptOf(await prepare({ featureId: STREAM }))).toEqual(retried);
    expect(await preparedRows()).toHaveLength(2);
  });

  /**
   * The first call compiles, and the seam records its read of the bundle of the revision.
   * The second call is a replay, and the seam records no read.
   * Then the blob is removed, and the replay still returns the recorded receipt.
   */
  it('Prepare_AReplayOfARecordedPrepare_ReadsNoBundle', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const digest = bundleDigestOf(await revise(first, 'batch-revising', ['task-named']));

    const compiling = countingBundleStore();
    const next = receiptOf(await prepareThrough(compiling.bundles));
    expect(compiling.read).toEqual([digest.value]);

    const replaying = countingBundleStore();
    expect(receiptOf(await prepareThrough(replaying.bundles))).toEqual(next);
    expect(replaying.read).toEqual([]);

    await unlink(blobPath(digest));
    expect(receiptOf(await prepare({ featureId: STREAM }))).toEqual(next);
    expect(await preparedRows()).toHaveLength(2);
  });

  /**
   * Each of the eight revisions holds a statement and a proposed change that are far over the limit.
   * The uncut texts alone are over the budget. The receipt states the eight changes and is under
   * it, so the economy seam of the dispatcher returns the receipt whole.
   */
  it('Prepare_AReceiptAfterEightRevisions_StaysUnderTheResponseBudget', async () => {
    await seedDelegatingFeature(CONTINUATION_PLAN);
    const first = receiptOf(await prepare({ featureId: STREAM }));
    const revisions = 8;
    const textLength = 2100;
    for (let index = 0; index < revisions; index += 1) {
      await decide(first, `batch-revising-${index}`, [
        {
          deviationKind: 'invalidated-assumption',
          statement: `finding ${index} `.padEnd(textLength, 's'),
          decision: 'accepted',
          affectedTasks: ['task-named'],
          proposedChange: `change ${index} `.padEnd(textLength, 'p'),
        },
      ]);
    }
    expect(Math.ceil((revisions * 2 * textLength) / 4)).toBeGreaterThan(PREPARE_ECONOMY_BUDGET_TOKENS);

    const next = receiptOf(await prepare({ featureId: STREAM }));
    expect(next.capsule.identity.designVersion).toBe('design-v9');
    const stated = designBinding(next).rationale.slice(1);
    expect(stated).toHaveLength(revisions);
    for (const [index, statement] of stated.entries()) {
      const revision = revisions - 1 - index;
      expect(statement).toContain(`"finding ${revision} sss`);
      expect(statement).toContain(`"change ${revision} ppp`);
      expect(statement.length).toBeLessThan(700);
    }

    expect(estimateOutputTokens(next)).toBeLessThan(PREPARE_ECONOMY_BUDGET_TOKENS);
    const result: ToolResult = { success: true, data: next };
    expect(enforceResponseEconomy(result, 'exarchos_orchestrate', 'prepare')).toBe(result);
  });
});

describe('prepare — the registered action', () => {
  /** An agent reads the refusals of an action from its description, so the description names each code. */
  it('PrepareAction_ItsDescription_NamesTheUnreadableRevisionRefusal', () => {
    const description = findActionInRegistry('exarchos_orchestrate', 'prepare')?.description ?? '';
    expect(PREPARE_REFUSAL_CODES).toContain('REVISION_UNREADABLE');
    expect(description).toContain('REVISION_UNREADABLE');
    expect(PREPARE_REFUSAL_CODES.filter((code) => !description.includes(code))).toEqual([]);
  });
});
