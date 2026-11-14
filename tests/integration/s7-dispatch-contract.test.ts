/**
 * Historical pages authenticate immutable custody and retain every approved task exactly once.
 * @oracle-sources: authored fixture contexts, SQLite rows and claims, UTF-8 serialized carrier bytes
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { createMcpServer } from '../../src/adapters/mcp/mcp.js';
import { buildCli } from '../../src/adapters/cli/cli.js';
import { createV2Client, createV2LinkedTransportPair, connectV2Client, connectV2Server } from '../../src/contract/sdk/seam.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { findActionInRegistry, normalizeActionContract } from '../../src/registry.js';
import { ReadPreparedCapsuleArguments } from '../../src/verbs/prepare/schemas.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { EventSourcedTaskStore } from '../../src/projections/task-store/event-sourced-task-store.js';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { nodeTestProfile } from '../helpers/verification-profile.js';
import { WorkflowPreparedData } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { capsuleDigest, contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { fixture, task, textOf, prepared } from '../helpers/capsule/prepared-authority.js';
import { PreparedDetailOutputSchema } from '../../src/registry/output-schemas.js';
import { summarizePreparedCapsuleReceipt } from '../../src/verbs/prepare/economy.js';
import { estimateOutputTokens } from '../../src/dispatch/core/economy.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const close: (() => Promise<void> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const fn of close.splice(0).reverse()) await fn(); });

/** Builds independent complete custody without the reader or compiler as its expected-value oracle. */
async function setup(count = 30, large = false, stateRoot?: string, label = 'original') {
  const root = stateRoot ?? makeTempDir('prepared-detail-'); close.push(() => rmrfAsync(root));
  const events = new EventStore(root); await events.initialize(); close.push(() => events.close());
  const tasks = Array.from({ length: count }, (_, i) => task(`task-${i}`, {
    blockedBy: i < 10 ? [] : [`task-${i - 10}`, `task-${(i - 10 + 1) % 10 + (i >= 20 ? 10 : 0)}`],
    instructions: large ? '界\"'.repeat(1800) : `Implement ${label} task ${i} with its exact approved obligations.`,
  }));
  const text = textOf(tasks); const bundle = fixture(text); const capsule = bundle.capsule;
  const read = readDesignRecord(Buffer.from(text), 'unavailable/plan.md'); if (read.kind !== 'typed') throw new Error('Invalid fixture');
  capsule.provenance.compilerVersion = 'exarchos-prepare-8';
  capsule.graph.tasks = read.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate', stage: { kind: 'task-batch', stepId: 'delegate' },
    taskContext: { taskId: entry.id, title: entry.title, instructions: entry.instructions, files: [...entry.files], testFiles: [...entry.testFiles],
      acceptance: [...entry.acceptance], riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
      blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
      source: { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } },
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] } } }));
  capsule.graph.dependencies = tasks.flatMap(entry => entry.blockedBy.map(from => ({ from, to: entry.id })));
  capsule.graph.joins = tasks.filter(entry => entry.blockedBy.length > 1).map(entry => ({ joinId: `join:${contentDigest(entry.id)}`, forTaskId: entry.id, waitsFor: [...entry.blockedBy], mode: 'all' }));
  capsule.contracts.taskResults = Object.fromEntries(tasks.map(entry => [entry.id, [{ name: 'worktreePath', type: 'string' as const, required: true },
    ...(entry.blockedBy.length ? [{ name: 'forkCommit', type: 'string' as const, required: true }] : [])]]));
  capsule.contracts.taskInputs = {};
  capsule.settlementContract.scope = { repository: '/isolated/repository.git', checkout: '/isolated/checkout', configDigest: 'a'.repeat(64) };
  capsule.settlementContract.verificationProfile = nodeTestProfile();
  capsule.settlementContract.verificationMode = 'immutable-task-diff-v1';
  capsule.settlementContract.requiredResults = tasks.map(entry => entry.id);
  capsule.settlementContract.taskVerification = Object.fromEntries(tasks.map(entry => [entry.id, { riskTier: 'low' as const, boundaryTouching: false, baseRef: 'main', baseCommit: 'a'.repeat(40) }]));
  const store = async (next = bundle) => {
    const digest = await events.bundleStore.put(encodePreparedBundle(next));
    const row = prepared(next);
    await events.append(next.capsule.identity.workflowId, { type: row.type, schemaVersion: '1.0', data: { ...row.data,
      bundleRefs: [{ artifactId: 'run-bundle:fixture', digest }] } });
  };
  await store();
  const args = { streamId: capsule.identity.workflowId, capsuleVersion: capsule.identity.capsuleVersion };
  const ctx: DispatchContext = { stateDir: root, eventStore: events, enableTelemetry: true, treeObserver: async () => { throw new Error('Unexpected checkout read'); } };
  const call = (extra: Record<string, unknown> = {}) => dispatch('exarchos_orchestrate', { action: 'read_prepared_capsule', ...args, ...extra }, ctx);
  const snapshot = () => {
    const db = new Database(join(root, 'exarchos.db'), { readonly: true });
    try { return { events: db.query('SELECT * FROM events ORDER BY streamId, sequence').all(), claims: db.query('SELECT * FROM idempotency_claims ORDER BY streamId, idempotencyKey').all(), state: db.query('SELECT * FROM workflow_state ORDER BY 1').all(), streams: db.query('SELECT * FROM streams ORDER BY 1').all() }; }
    finally { db.close(); }
  };
  return { root, events, bundle, capsule, tasks, call, args, store, snapshot, ctx };
}

/** Parses the declared successful output rather than trusting a cast. */
function page(result: unknown) {
  const parsed = PreparedDetailOutputSchema.parse(result);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed;
}


/** Uses the actual Commander carrier, including the generated action-id check. */
async function cli(ctx: DispatchContext, args: Record<string, unknown>) {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { chunks.push(String(chunk)); return true; });
  try {
    const program = buildCli(ctx); program.exitOverride();
    const argv = Object.entries(args).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, String(value)]);
    await program.parseAsync(['node', 'exarchos', 'orchestrate', 'read_prepared_capsule', ...argv, '--json']);
  } finally { spy.mockRestore(); }
  return JSON.parse(chunks.join(''));
}

/** Only per-invocation correlation ids differ between the two real transports. */
function withoutCorrelation(result: Record<string, unknown>) {
  const { _meta, ...rest } = result;
  if (typeof _meta !== 'object' || _meta === null) return rest;
  const { operationId, correlationId, causationId, ...stableMeta } = _meta as Record<string, unknown>;
  void operationId; void correlationId; void causationId;
  return { ...rest, _meta: stableMeta };
}

describe('prepared detail public dispatch', () => {
  it('DetailRead_CliMcpParity_BothFrontEndsRecoverPinnedContext', async () => {
    const f = await setup();
    const summary = summarizePreparedCapsuleReceipt({ operationId: 'prepare:fixture', workflowId: f.args.streamId,
      capsuleVersion: f.args.capsuleVersion, capsuleDigest: capsuleDigest(f.capsule), definitionVersion: f.capsule.identity.definitionVersion,
      capsule: f.capsule, bundleRefs: (await f.events.query(f.args.streamId))[0]?.data?.bundleRefs });
    const invocation = summary.detailRead; if (!invocation) throw new Error('Missing compiler-8 invocation');
    const expected = structuredClone(f.capsule.graph.tasks);
    const contracts = structuredClone(f.capsule.contracts.taskResults);
    const originalRecord = WorkflowPreparedData.parse((await f.events.query(f.args.streamId))[0]?.data);
    const newer = await setup(30, false, undefined, 'newer'); newer.capsule.identity.capsuleVersion += 1; await f.store(newer.bundle);
    const server = createMcpServer(f.ctx); const client = createV2Client({ name: 's7-detail', version: '1' }, { capabilities: {} });
    const [ct, st] = createV2LinkedTransportPair();
    await Promise.all([connectV2Server(server, st), connectV2Client(client, ct)]);
    close.push(() => client.close());
    const before = f.snapshot(); const recovered = [];
    let args = invocation.arguments;
    for (let pages = 0; ; pages += 1) {
      expect(pages).toBeLessThan(30);
      const cliResult = page(await cli(f.ctx, args));
      const mcp = await client.callTool({ name: invocation.tool, arguments: { action: invocation.action, ...args } });
      const mcpResult = page(mcp.structuredContent);
      expect(withoutCorrelation(cliResult)).toEqual(withoutCorrelation(mcpResult));
      expect(estimateOutputTokens(cliResult)).toBeLessThanOrEqual(8000);
      expect(estimateOutputTokens(mcpResult)).toBeLessThanOrEqual(8000);
      expect(cliResult.data.capsule.capsuleVersion).toBe(f.args.capsuleVersion);
      expect(cliResult.data.operationId).toBe(originalRecord.operationId);
      expect(cliResult.data.capsuleDigest).toBe(originalRecord.capsuleDigest);
      expect(cliResult.data.bundleRefs).toEqual(originalRecord.bundleRefs);
      recovered.push(...cliResult.data.items);
      if (!cliResult.data.continuation) break;
      args = cliResult.data.continuation.arguments;
    }
    expect(recovered.map(item => item.taskId)).toEqual(f.tasks.map(item => item.id));
    expect(recovered.map(item => item.context)).toEqual(expected.map(item => item.taskContext));
    expect(recovered.map(item => item.resultContract)).toEqual(f.tasks.map(item => contracts[item.id]));
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 29 }), fc.integer({ min: 1, max: 10 }), async (offset, limit) => {
      const args = { ...f.args, offset, limit };
      const cliResult = page(await cli(f.ctx, args));
      const mcpResult = page((await client.callTool({ name: invocation.tool, arguments: { action: invocation.action, ...args } })).structuredContent);
      expect(withoutCorrelation(cliResult)).toEqual(withoutCorrelation(mcpResult));
      expect(cliResult.data.items.map(item => item.context)).toEqual(expected.slice(offset, offset + limit).map(item => item.taskContext));
      expect(estimateOutputTokens(cliResult)).toBeLessThanOrEqual(8000);
    }), { seed: 192712, numRuns: 6 });
    for (const args of [{ ...f.args, streamId: 'unknown' }, { ...f.args, capsuleVersion: 999 }]) {
      const cliResult = await cli(f.ctx, args);
      const mcpResult = (await client.callTool({ name: invocation.tool, arguments: { action: invocation.action, ...args } })).structuredContent;
      expect(cliResult.success).toBe(false);
      expect(withoutCorrelation(cliResult)).toEqual(withoutCorrelation(mcpResult as Record<string, unknown>));
    }
    expect(f.snapshot()).toEqual(before);
  });

  it('TelemetryOn_DetailAndRefusalsHaveZeroWrites', async () => {
    const f = await setup();
    await f.events.append(f.args.streamId, { type: 'workflow.rehydrated', data: {
      projectionSequence: 1, deliveryPath: 'direct', tokenEstimate: 100, phaseHasPlaybook: false, phasePlaybookComposed: false } });
    const resolver = createInMemoryResolver(['mcp:exarchos:readonly']);
    resolver.snapshot({ capabilities: { elicitation: {}, tasks: {} } });
    const elicit = vi.fn(async () => ({ value: f.args.streamId }));
    const ctx: DispatchContext = { ...f.ctx, callerIdentity: deriveMcpCallerIdentity({ sessionId: 'prepared-detail-readonly' }), capabilityResolver: resolver, taskStore: new EventSourcedTaskStore(f.events), elicitationClient: { create: elicit } };
    const before = f.snapshot();
    const read = (args: Record<string, unknown>) => dispatch('exarchos_orchestrate', { action: 'read_prepared_capsule', ...args }, ctx);
    page(await read(f.args)); page(await read(f.args));
    for (const args of [{ capsuleVersion: 1 }, { ...f.args, capsuleVersion: 999 }, { ...f.args, task: {} }, { ...f.args, featureId: f.args.streamId }, { ...f.args, limit: 11 }]) {
      expect((await read(args)).success).toBe(false);
    }
    expect((await dispatch('exarchos_orchestrate', { action: 'read_prepared_capsule', ...f.args, task: {} }, f.ctx)).success).toBe(false);
    expect((await dispatch('exarchos_orchestrate', { action: 'prepare', streamId: f.args.streamId, repoRoot: '/isolated/repository' }, ctx)).error?.code).toBe('CAPABILITY_DENIED');
    expect(elicit).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
    const rows = await f.events.query(f.args.streamId); const ref = WorkflowPreparedData.parse(rows[0]?.data).bundleRefs[0];
    if (!ref) throw new Error('Missing ref');
    await rm(join(f.events.bundleStore.root, 'sha256', ref.digest.value.slice(0, 2), ref.digest.value.slice(2)));
    expect((await read(f.args)).error?.code).toBe('PREPARED_DETAIL_UNAVAILABLE'); expect(f.snapshot()).toEqual(before);
    await dispatch('exarchos_view', { action: 'pipeline' }, f.ctx);
    expect(f.snapshot().events.length).toBeGreaterThan(before.events.length);
  });

  it('Compiler8_DeclaredShapeParity_ClosedInputsAndReadAuthority', async () => {
    const action = findActionInRegistry('exarchos_orchestrate', 'read_prepared_capsule');
    if (!action) throw new Error('Missing detail declaration');
    expect(action.schema).toBe(ReadPreparedCapsuleArguments);
    const contract = normalizeActionContract(action.actionContract);
    expect(contract.replay.kind).toBe('safe-repeat'); expect(contract.emissions.kind).toBe('none');
    expect(contract.executionAuthority).toEqual({ kind: 'local' });
    expect(contract.touches.resources).toEqual({ kind: 'declared', values: [{ kind: 'stream', selector: 'streamId' }] });
    expect(action.economy?.budgetTokens).toBe(8000);
    const f = await setup(1); const before = f.snapshot();
    for (const input of [{}, { ...f.args, capsuleVersion: -1 }, { ...f.args, offset: 0.5 }, { ...f.args, limit: 11 }, { ...f.args, featureId: f.args.streamId }]) {
      expect(action.schema.safeParse(input).success).toBe(false);
    }
    const result = await f.call(); expect(action.outputSchema.safeParse(result).success).toBe(true);
    expect(f.snapshot()).toEqual(before);
  });

  it('FinalCarrier_CorrelationAndAmbientWarningFitBeforeReturn', async () => {
    const home = makeTempDir('detail-divergence-'); close.push(() => rmrfAsync(home));
    vi.stubEnv('HOME', home); vi.stubEnv('CLAUDE_PLUGIN_ROOT', ''); vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
    vi.stubEnv('WORKFLOW_STATE_DIR', ''); vi.stubEnv('XDG_STATE_HOME', ''); vi.stubEnv('EXARCHOS_ALLOW_STORE_DIVERGENCE', '');
    const f = await setup(10, true, join(home, '.exarchos', 'state'));
    const plugin = join(home, '.claude', 'workflow-state'); await mkdir(plugin, { recursive: true }); await writeFile(join(plugin, 'exarchos.db'), '');
    const before = f.snapshot();
    const result = page(await f.call({ _meta: { correlationId: '界'.repeat(3000), causationId: 'quoted"'.repeat(50) } }));
    expect(result.warnings).toHaveLength(1); expect(result.warnings?.[0]).toContain('Event-store divergence');
    expect(result.data.count).toBeGreaterThan(0); expect(result.data.count).toBeLessThan(10);
    expect(result._meta.correlationId).toBe('界'.repeat(3000));
    expect(estimateOutputTokens(result)).toBeLessThanOrEqual(8000);
    vi.stubEnv('WORKFLOW_STATE_DIR', f.root);
    const unpadded = page(await f.call({ _meta: { correlationId: 'x' } }));
    const correlationId = 'x'.repeat(32000 - Buffer.byteLength(JSON.stringify(unpadded)) + 1);
    const exact = page(await f.call({ _meta: { correlationId } }));
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(32000);
    vi.stubEnv('WORKFLOW_STATE_DIR', '');
    const warned = page(await f.call({ _meta: { correlationId } }));
    expect(warned.warnings).toHaveLength(1);
    expect(warned.data.count).toBeLessThan(exact.data.count);
    expect(estimateOutputTokens(warned)).toBeLessThanOrEqual(8000);
    const refused = await f.call({ capsuleVersion: 999 }); expect(refused.success).toBe(false); expect(refused.warnings).toHaveLength(1);
    expect(f.snapshot()).toEqual(before);
  });

});
