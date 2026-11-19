/**
 * Full typed graphs retain approved context, with an explicit historical frontier control.
 * @oracle-sources: ../../src/verbs/prepare/handler.ts, literal authored graphs and source coordinates
 */
import * as outputEconomy from '../../src/dispatch/core/economy.js';
import { summarizePreparedCapsuleReceipt } from '../../src/verbs/prepare/economy.js';
import { handleReadPreparedCapsule } from '../../src/verbs/prepare/read-prepared-capsule.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { preparedDetailDeliverable } from '../../src/verbs/prepare/economy.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { decodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../src/dispatch/caller-identity.js';
import { mintDispatchContext, runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../src/events/store.js';
import { handlePrepare, type PrepareDeps } from '../../src/verbs/prepare/handler.js';
import { PreparedCapsuleReceiptData } from '../../src/verbs/prepare/schemas.js';
import { ContentDigestV1Schema } from '../../src/workflow/admission/types.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { task, textOf } from '../helpers/capsule/prepared-authority.js';
import { releaseCheckDefinition } from '../helpers/definitions/user-definition.js';

const STREAM = 'full-graph';
const BASE = 'codex/integration';
const HEAD = 'a'.repeat(40);
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function fixture(text: string, user = false) {
  const root = makeTempDir('prepare-full-graph-');
  cleanup.push(() => rmrfAsync(root));
  const checkout = path.join(root, 'checkout');
  await mkdir(checkout);
  await writeFile(path.join(checkout, 'plan.md'), text);
  if (user) {
    await mkdir(path.join(checkout, '.exarchos/workflows'), { recursive: true });
    await writeFile(path.join(checkout, '.exarchos/workflows/release-check.workflow.json'), JSON.stringify(releaseCheckDefinition()));
  }
  const stateDir = path.join(root, 'state');
  const events = new EventStore(stateDir);
  await events.initialize();
  cleanup.push(() => events.close());
  await events.append(STREAM, { type: 'workflow.started', schemaVersion: '1.1', data: {
    featureId: STREAM, workflowType: user ? 'release-check' : 'feature', initialPhase: user ? 'build' : 'delegate',
  } });
  await events.append(STREAM, { type: 'state.patched', data: { patch: { 'synthesis.integrationBranch': BASE } } });
  const deps: PrepareDeps = {
    compilerVersion: 'exarchos-prepare-8', now: () => '2026-11-14T00:00:00.000Z', catalogInvariants: () => [],
    scopeGit: {
      observe: async () => ({ kind: 'repository', toplevel: checkout, repository: path.join(checkout, '.git') }),
      commitOf: async (_checkout, ref) => ref.startsWith('refs/tags/') ? { kind: 'absent' } : { kind: 'commit', commit: HEAD },
      isAncestor: async () => ({ kind: 'ancestor' }),
    },
  };
  const call = (overrides: PrepareDeps = {}) => {
    const identity = deriveMcpCallerIdentity({ sessionId: 'full-graph' });
    const dispatch = mintDispatchContext(undefined, snapshotCallerAuthorization(identity,
      createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'])));
    return runWithDispatchContext(dispatch, () => handlePrepare({ featureId: STREAM, repoRoot: checkout, intent: {
      mode: 'compile', designRef: 'plan.md', approval: { decision: 'approved', designDigest: digest(text) },
    } }, stateDir, { stateDir, eventStore: events, enableTelemetry: false }, { ...deps, ...overrides }));
  };
  const prepare = async (overrides: PrepareDeps = {}) => {
    const result = await call(overrides);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    const receipt = PreparedCapsuleReceiptData.parse(result.data);
    return { ...receipt, capsule: ExarchosCapsuleV1Schema.parse(receipt.capsule) };
  };
  return { checkout, events, call, prepare };
}

function threeWaves() {
  return [task('root'), task('left', { blockedBy: ['root'] }), task('right', { blockedBy: ['root'] }),
    task('finish', { blockedBy: ['right', 'left'] })];
}

describe('complete approved graph compilation', () => {
  it('ThreeWaves_OneGraph_PreservesOrderedEdgesJoinsAndForkContracts', async () => {
    const s = await fixture(textOf(threeWaves()));
    const receipt = await s.prepare();
    expect(receipt.capsule.provenance.compilerVersion).toBe('exarchos-prepare-8');
    expect(receipt.capsule.graph.tasks.map(node => [node.taskId, node.stepId, node.stage])).toEqual([
      ['root', 'delegate', { kind: 'task-batch', stepId: 'delegate' }],
      ['left', 'delegate', { kind: 'task-batch', stepId: 'delegate' }],
      ['right', 'delegate', { kind: 'task-batch', stepId: 'delegate' }],
      ['finish', 'delegate', { kind: 'task-batch', stepId: 'delegate' }],
    ]);
    expect(receipt.capsule.graph.dependencies).toEqual([
      { from: 'root', to: 'left' }, { from: 'root', to: 'right' },
      { from: 'right', to: 'finish' }, { from: 'left', to: 'finish' },
    ]);
    expect(receipt.capsule.graph.joins).toEqual([{
      joinId: `join:${digest(JSON.stringify('finish'))}`, forTaskId: 'finish', waitsFor: ['right', 'left'], mode: 'all',
    }]);
    expect(receipt.capsule.settlementContract.requiredResults).toEqual(['root', 'left', 'right', 'finish']);
    expect(receipt.capsule.settlementContract).toMatchObject({ skipPhases: [], verificationMode: 'immutable-task-diff-v1' });
    expect(receipt.capsule.contracts.taskResults.root?.some(field => field.name === 'forkCommit')).toBe(false);
    for (const id of ['left', 'right', 'finish']) {
      expect(receipt.capsule.contracts.taskResults[id]).toContainEqual({ name: 'forkCommit', type: 'string', required: true });
    }
    expect((await s.prepare()).operationId).toBe(receipt.operationId);
    expect((await s.events.query(STREAM)).filter(row => row.type === 'workflow.prepared')).toHaveLength(1);
  });

  it('CompletedAncestor_RemainsReferencedWithoutGrantingStanding', async () => {
    const s = await fixture(textOf(threeWaves()));
    for (const id of ['root', 'left', 'right', 'finish']) {
      await s.events.append(STREAM, { type: 'task.completed', data: { taskId: id } });
    }
    const receipt = await s.prepare();
    expect(receipt.capsule.graph.tasks.map(node => node.taskId)).toEqual(['root', 'left', 'right', 'finish']);
    expect(receipt.capsule.settlementContract.requiredResults).toEqual(['root', 'left', 'right', 'finish']);
    expect(receipt.capsule.graph.dependencies).toHaveLength(4);
  });

  it('Context_ApprovedBytesOnly_SurvivesAnEditedSource', async () => {
    const authored = task('root', { title: 'Approved title', instructions: 'Preserve the approved behavior.',
      acceptance: ['Keep exact acceptance.'], knowledgeSlice: { invariantIds: ['INV-1'], adrRefs: ['ADR-1'], symbols: ['compile'], files: ['src/a.ts'] } });
    const text = textOf([authored]);
    const s = await fixture(text);
    const receipt = await s.prepare({ catalogInvariants: () => {
      writeFileSync(path.join(s.checkout, 'plan.md'), textOf([task('replacement')]));
      return [];
    } });
    const start = text.indexOf(JSON.stringify(authored));
    const end = start + JSON.stringify(authored).length;
    const line = text.slice(0, start).split('\n').length;
    expect(receipt.capsule.graph.tasks[0]?.taskContext).toEqual({
      taskId: 'root', title: 'Approved title', instructions: 'Preserve the approved behavior.',
      files: ['root.ts'], testFiles: [], acceptance: ['Keep exact acceptance.'],
      riskTier: 'low', boundaryTouching: false, testLayer: 'unit', blockedBy: [], resultContractRef: 'root',
      knowledgeSlice: { invariantIds: ['INV-1'], adrRefs: ['ADR-1'], symbols: ['compile'], files: ['src/a.ts'] },
      source: { reference: 'plan.md', digest: digest(text), span: { start, end, startLine: line, endLine: line } },
    });
    const ref = receipt.bundleRefs?.[0];
    if (ref === undefined) throw new Error('Missing prepared custody');
    const stored = decodePreparedBundle(await s.events.bundleStore.resolve(ContentDigestV1Schema.parse(ref.digest)));
    expect(stored.designRecord?.text).toBe(text);
    expect(stored.capsule).toEqual(receipt.capsule);
  });

  it('UserStep_StageFromPin_DoesNotAssumeDelegate', async () => {
    const s = await fixture(textOf(threeWaves()), true);
    const receipt = await s.prepare();
    expect(receipt.capsule.graph.tasks.map(node => node.stage)).toEqual(Array(4).fill({ kind: 'task-batch', stepId: 'build' }));
  });

  it('DefaultCompiler_KeepsTheHistoricalFrontier', async () => {
    const s = await fixture(textOf(threeWaves()));
    const receipt = await s.prepare({ compilerVersion: 'exarchos-prepare-7' });
    expect(receipt.capsule.provenance.compilerVersion).toBe('exarchos-prepare-7');
    expect(receipt.capsule.graph.tasks).toEqual([{ taskId: 'root', title: 'root', stepId: 'delegate' }]);
    expect(receipt.capsule.graph.dependencies).toEqual([]);
    expect(receipt.capsule.settlementContract.verificationMode).toBeUndefined();
  });

  it('DefaultTypedCompiler_ActivatesCompleteApprovedGraph', async () => {
    const s = await fixture(textOf(threeWaves()));
    const receipt = await s.prepare({ compilerVersion: undefined });
    expect(receipt.capsule.provenance.compilerVersion).toBe('exarchos-prepare-8');
    expect(receipt.capsule.graph.tasks.map(node => node.taskId)).toEqual(['root', 'left', 'right', 'finish']);
    expect(receipt.capsule.graph.dependencies).toHaveLength(4);
    expect(receipt.capsule.settlementContract.verificationMode).toBe('immutable-task-diff-v1');
  });

  it('WholeGraph_InvalidDisconnectedComponent_RefusesWithoutCustody', async () => {
    const s = await fixture(textOf([task('root'), task('bad', { blockedBy: ['missing'] })]));
    const rows = await s.events.query(STREAM);
    const put = vi.spyOn(s.events.bundleStore, 'putThenReference');
    const claim = vi.spyOn(s.events.getAppender(), 'decideOnce');
    expect(await s.call()).toMatchObject({ success: false, error: { code: 'PLAN_UNSOUND' } });
    expect(await s.events.query(STREAM)).toEqual(rows);
    expect(put).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('JoinIdentity_AnAuthoredCollision_UsesOneStableFreeId', async () => {
    const collision = `join:${digest(JSON.stringify('finish'))}`;
    const s = await fixture(textOf([...threeWaves(), task(collision)]));
    const receipt = await s.prepare();
    expect(receipt.capsule.graph.joins[0]?.joinId).toBe(`${collision}:1`);
    expect(new Set([...receipt.capsule.graph.tasks.map(node => node.taskId), ...receipt.capsule.graph.joins.map(join => join.joinId)]).size).toBe(6);
  });

  it('GraphModel_AuthoredChainsKeepEveryEdgeAndContext', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async count => {
      const tasks = Array.from({ length: count }, (_, index) => task(`node-${index}`, { blockedBy: index === 0 ? [] : [`node-${index - 1}`] }));
      const s = await fixture(textOf(tasks));
      const receipt = await s.prepare();
      expect(receipt.capsule.graph.tasks.map(node => node.taskId)).toEqual(tasks.map(entry => entry.id));
      expect(receipt.capsule.graph.dependencies).toEqual(tasks.slice(1).map((entry, index) => ({ from: `node-${index}`, to: entry.id })));
      expect(receipt.capsule.graph.tasks.map(node => node.taskContext?.instructions)).toEqual(tasks.map(entry => entry.instructions));
      expect(receipt.capsule.graph.joins).toEqual([]);
    }), { seed: 192703, numRuns: 8 });
  });

  it('ThirtyTasks_CompileWithinTheBoundAndRetainEveryContext', async () => {
    const tasks = Array.from({ length: 30 }, (_, index) => task(`node-${index}`, { blockedBy: index < 10 ? [] : [`node-${index - 10}`, `node-${(index - 10 + 1) % 10 + (index >= 20 ? 10 : 0)}`] }));
    const s = await fixture(textOf(tasks));
    const started = performance.now();
    const receipt = await s.prepare();
    console.info(JSON.stringify({ measurement: 'thirty-task-prepare', elapsedMs: performance.now() - started }));
    for (const node of receipt.capsule.graph.tasks) {
      const envelope = { context: node.taskContext, resultContract: receipt.capsule.contracts.taskResults[node.taskId] };
      expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(24000);
    }
    expect(receipt.capsule.graph.tasks).toHaveLength(30);
    expect(receipt.capsule.graph.tasks.every(node => node.taskContext !== undefined)).toBe(true);
    expect(receipt.capsule.graph.dependencies).toHaveLength(40);
    const backend = s.events.getAppender().ensureSqliteBackendSync();
    const original = backend.lookupOperationClaim(receipt.operationId);
    expect(original?.result).toMatchObject({ capsule: receipt.capsule });
    expect(outputEconomy.estimateOutputTokens(receipt)).toBeGreaterThan(8000);
    const summary = summarizePreparedCapsuleReceipt(receipt); expect(summary.detailRead).toBeDefined();
    const replay = await s.prepare(); expect(replay).toEqual(receipt);
    expect(backend.lookupOperationClaim(receipt.operationId)).toEqual(original);
    const invocation = summary.detailRead; if (invocation === undefined) throw new Error('Missing read invocation');
    const detail = await handleReadPreparedCapsule(invocation.arguments, '', { stateDir: '', eventStore: s.events });
    expect(detail.success, JSON.stringify(detail)).toBe(true);
  });

  /** Exact escaped UTF-8 context limits are enforced before prepared custody is published. */
  it('Context_ExactUtf8Limit_AndOneOver_Preflight', async () => {
    const measurement = vi.spyOn(outputEconomy, 'estimateOutputTokens');
    for (const instructions of ['x'.repeat(6000), '界'.repeat(2000), '\"'.repeat(6000)]) {
      const make = (padding: number) => task('bounded', { instructions,
        acceptance: Array.from({ length: 12 }, (_, i) => `${i}:` + 'a'.repeat(1 + Math.floor(padding / 12) + (i < padding % 12 ? 1 : 0))) });
      const base = await fixture(textOf([make(0)])); const receipt = await base.prepare();
      const context = receipt.capsule.graph.tasks[0]?.taskContext; if (context === undefined) throw new Error('Missing context');
      const size = (padding: number) => {
        const authored = make(padding); const text = textOf([authored]);
        const read = readDesignRecord(Buffer.from(text), context.source.reference); if (read.kind !== 'typed') throw new Error('Invalid plan');
        const entry = read.snapshot.tasks[0]; if (entry === undefined) throw new Error('Missing task');
        return Buffer.byteLength(JSON.stringify({ context: { ...context, instructions, acceptance: authored.acceptance,
          source: { ...context.source, digest: read.snapshot.digest, span: entry.span } }, resultContract: receipt.capsule.contracts.taskResults.bounded }), 'utf8');
      };
      let padding = 24000 - size(0);
      for (let count = 0; count < 5 && size(padding) !== 24000; count++) padding += 24000 - size(padding);
      expect(size(padding)).toBe(24000);
      const exact = await fixture(textOf([make(padding)])); const accepted = await exact.prepare();
      const maximumCalls = measurement.mock.calls.filter(([value]) => typeof value === 'object' && value !== null
        && 'data' in value && typeof value.data === 'object' && value.data !== null
        && 'operationId' in value.data && value.data.operationId === 'x'.repeat(256));
      expect(maximumCalls.length).toBeGreaterThan(0);
      expect(JSON.stringify(maximumCalls.at(-1))).toContain(String(Number.MAX_SAFE_INTEGER));
      expect(preparedDetailDeliverable(accepted.capsule)).toBe(true);
      const over = await fixture(textOf([make(padding + 1)])); const before = await over.events.query(STREAM);
      expect(size(padding + 1)).toBe(24001);
      const refused = await over.call(); expect(refused.success).toBe(false); expect(refused.error?.code).toBe('CAPSULE_UNSOUND');
      expect(await over.events.query(STREAM)).toEqual(before);
    }
  });

});
