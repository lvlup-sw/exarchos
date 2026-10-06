// `prepare` end to end, against a real event store and a real content-addressed
// bundle store in a temporary directory.
//
// No test of the pure compiler can check these facts. The record references bytes in custody,
// and those bytes read back as the capsule that the receipt returned. A retry gets its answer
// from the durable claim. Each refusal leaves the store unchanged.
//
// One case needs a design revision on the stream. The row comes from a real decision round of
// `settle`, because `settle` is the one writer of that row.
//
// @oracle-sources: ../../../../src/verbs/prepare/handler.ts, the prepared bundle read back out of the content-addressed store and re-digested rather than compared with the in-process capsule

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
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
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import type { RunBundleStore } from '../../../../src/events/bundle/run-bundle-store.js';
import { DesignRevisedData, WorkflowPreparedData, type DesignRevised } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { productionExecuteDeps } from '../../../../src/verbs/execute/executor.js';
import type { CatalogInvariant } from '../../../../src/verbs/prepare/bind-authority.js';
import { PREPARE_COMPILER_VERSION } from '../../../../src/verbs/prepare/compile-capsule.js';
import { handlePrepare, planeExecutionCapabilities } from '../../../../src/verbs/prepare/handler.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import { commitPreparedCapsule, findPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import type { PreparedCapsuleReceipt } from '../../../../src/verbs/prepare/types.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
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
        tasks: tasks.map((t) => ({ id: t.id, title: `title of ${t.id}`, status: t.status, blockedBy: t.blockedBy ?? [] })),
      },
    },
  });
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
   * After the revision, the same plan compiles the next capsule version under the next design version.
   * The last comparison puts the two first versions back, so nothing else in the capsule moved.
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
    expect({
      ...next.capsule,
      identity: { ...next.capsule.identity, designVersion: 'design-v1', capsuleVersion: 1 },
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
    const real = store.bundleStore;
    const racing: RunBundleStore = Object.create(real);
    racing.putThenReference = async (artifactId, bytes, commit) => {
      await store.append(STREAM, { type: 'state.patched', data: { patch: { 'artifacts.notes': 'moved' } } });
      return real.putThenReference(artifactId, bytes, commit);
    };

    const lost = await runWithDispatchContext(correlation(), () =>
      handlePrepare({ featureId: STREAM }, stateDir, wiring(), {
        bundleStore: racing,
        catalogInvariants: () => [],
        now: () => COMPILED_AT,
      }),
    );
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
