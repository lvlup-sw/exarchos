// @oracle-sources: ../../src/verbs/execute/executor.ts, original persisted SQLite claim and receipt rows, content-addressed stored input bytes, and real Git subprocess heads observed before independent publication
/** Real SQLite publication and executor retries preserve one immutable input without public coordinate authority. */
import { resolveConfig } from '../../src/config/resolve.js';
import { SEGMENT_INPUT_CLAIM_STREAM } from '../../src/storage/sqlite/constants.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalJson, requestDigest as canonicalRequestDigest } from '../../src/contract/request-context.js';
import { capsuleDigest } from '../../src/contract/capsule/capsule-digest.js';
import { profiledValidCapsule, } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { EventStore } from '../../src/events/store.js';
import { RunBundleStore } from '../../src/events/bundle/run-bundle-store.js';
import { runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { declared, none } from '../../src/registry.js';
import { observeRepository, observeTree } from '../../src/utils/git-tree.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { configDigestAt } from '../../src/verbs/prepare/prepare-scope.js';
import { handleSettle } from '../../src/verbs/settle/handler.js';
import { TaskCompletionArgs } from '../../src/verbs/execute/arg-schemas.js';
import { handleExecuteIntent, type ExecuteIntentDeps } from '../../src/verbs/execute/executor.js';
import { decodeExecuteIntentBundle, ExecuteIntentInputSchema, normalizedExecuteRequestDigest, SegmentInputBindingV1Schema } from '../../src/verbs/execute/run-bundle.js';
import { verificationOperationId, settlementClaimKey } from '../../src/verbs/settle/settlement-reads.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { fixtureAction, fixtureRunbook, fixtureStep, findFixtureAction, fixtureWiring, fixtureCorrelation } from '../unit/verbs/execute/fixtures.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const TIME = '2026-11-14T00:00:00.000Z';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

/** Fail final custody after a real leaf committed, while retaining durable pre-leaf input. */
class InterruptedStore extends RunBundleStore {
  failTerminal = true;
  override async put(bytes: Uint8Array) {
    if (this.failTerminal && JSON.parse(Buffer.from(bytes).toString()).kind === 'execute-intent-run') throw new Error('interrupted before terminal custody');
    return super.put(bytes);
  }
}

/** The fixture uses approved source bytes, a real clean checkout and actual operation claims. */
async function setup(unsafe = false, enforcement: 'block' | 'advisory' = 'block', quiet = false, pinnedConfig = false, declarePath = true) {
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'file.txt': 'base' } });
  const worktree = await repo.worktreeFor('root');
  closes.push(() => rmrfAsync(repo.root));
  const repository = await observeRepository(worktree);
  if (repository.kind !== 'repository') throw new Error('Missing fixture repository');
  const root = makeTempDir('segment-input-');
  let events = new EventStore(root); await events.initialize();
  closes.push(async () => { events.close(); await rmrfAsync(root); });
  const text = textOf([task('root')]);
  const bundle = preparedFixture(text);
  const streamId = bundle.capsule.identity.workflowId;
  const read = readDesignRecord(Buffer.from(text), bundle.designRecord?.reference ?? 'plan.md');
  if (read.kind !== 'typed') throw new Error('Invalid fixture plan');
  const capsule = bundle.capsule;
  capsule.provenance.compilerVersion = 'exarchos-prepare-8';
  capsule.graph.tasks = read.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate',
    stage: { kind: 'task-batch', stepId: 'delegate' }, taskContext: {
      taskId: entry.id, title: entry.title, instructions: entry.instructions, files: [...entry.files], testFiles: [...entry.testFiles],
      acceptance: [...entry.acceptance], riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
      blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
      source: { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } },
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] },
    } }));
  capsule.graph.dependencies = []; capsule.graph.joins = [];
  capsule.contracts.taskInputs = {};
  capsule.contracts.taskResults = Object.fromEntries(['root'].map(id => [id,
    id === 'child' ? [{ name: 'forkCommit', type: 'string' as const, required: true }] : [{ name: 'passed', type: 'boolean' as const, required: true }],
  ]));
  if (quiet && declarePath) capsule.contracts.taskResults.root = [{ name: 'passed', type: 'boolean', required: true }, { name: 'worktreePath', type: 'string', required: true }];
  capsule.settlementContract = { ...profiledValidCapsule().settlementContract, requiredResults: ['root'], skipPhases: [],
    verificationMode: 'immutable-task-diff-v1', scope: { repository: repository.repository, checkout: repo.checkout, configDigest: pinnedConfig ? await configDigestAt(repo.checkout) : 'c'.repeat(64) },
    taskVerification: Object.fromEntries(['root'].map(id => [id, { riskTier: 'low', boundaryTouching: false, baseRef: 'main', baseCommit: repo.baseCommit }])) };
  const preparedDigest = await events.bundleStore.put(encodePreparedBundle(bundle));
  const initial = prepared(bundle);
  await events.append(streamId, { type: 'workflow.prepared', schemaVersion: '1.0', timestamp: TIME, data: {
    ...initial.data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest: preparedDigest }],
  } });
  const selection = selectPreparedAuthority(await events.query(streamId), streamId);
  if (selection === undefined) throw new Error('Missing prepared record');
  const authority = await loadPreparedCustody(selection, events.bundleStore);
  const outer = settlementClaimKey(streamId, { ...capsule.identity, batchId: 'batch' });
  const operationId = verificationOperationId(outer, 'root');
  const coordinate = TaskVerificationCoordinateSchema.parse({ protocolVersion: '1', taskId: 'root', capsule: capsule.identity,
    repository: repository.repository, rootBaseCommit: repo.baseCommit, diffBaseCommit: repo.baseCommit, observedHeadCommit: repo.baseCommit, blockers: [] });
  const args = { taskId: 'root', worktreePath: worktree, baseRef: 'main', riskTier: 'low', boundaryTouching: false,
    capsuleVersion: capsule.identity.capsuleVersion, result: quiet ? { passed: true, worktreePath: worktree } : { z: { b: 2, a: 1 }, a: true } };
  const callerDigest = quiet ? canonicalRequestDigest({ streamId, identity: { ...capsule.identity, batchId: 'batch' },
    claims: [{ taskId: 'root', fields: args.result, evidence: [] }], deviations: [] })
    : `sha256:${createHash('sha256').update(canonicalJson(args)).digest('hex')}`;
  const bundles = new InterruptedStore(events.bundleStore.root); bundles.failTerminal = false;
  let calls = 0; const profiles: unknown[] = [];
  const action = fixtureAction({ name: 'fixture_effect', replay: quiet ? { kind: 'safe-repeat' } : unsafe ? { kind: 'claim-required', scope: 'stream-subject-request' } : { kind: 'reject-replay', because: 'the persisted event proves this fixture effect' },
    emissions: quiet ? none('the safe-repeat fixture has no event effects') : declared({ event: 'task.completed', condition: 'always', owner: 'orchestrate', role: 'primary' }) });
  const deps: ExecuteIntentDeps = { runbookTable: [fixtureRunbook('task-completion', [fixtureStep('fixture_effect', 'stop')])],
    findAction: findFixtureAction([action]), argSchemas: { 'task-completion': TaskCompletionArgs }, handlerTool: 'exarchos_orchestrate',
    handlers: { fixture_effect: async (_args, _state, ctx) => {
      calls++; profiles.push(ctx?.verificationProfile);
      if (ctx === undefined) throw new Error('Missing context');
      if (!quiet) await ctx.eventStore.append(streamId, { type: 'task.completed', timestamp: TIME, data: { taskId: 'root' } }, { idempotencyKey: `${operationId}:effect` });
      return { success: true, data: { appended: 'task.completed' } };
    } }, bundleStore: bundles, verificationInput: { authority, outerOperationId: outer, batchId: 'batch', callerDigest, coordinate } };
  const run = (rawArgs: Record<string, unknown> = args, overrides: ExecuteIntentDeps = deps) => runWithDispatchContext(fixtureCorrelation(), () =>
    handleExecuteIntent({ intent: 'task-completion', featureId: streamId, operationId, args: rawArgs }, root, { ...fixtureWiring(root, events), projectConfig: resolveConfig({ events: { 'emission-enforcement': enforcement } }) }, overrides));
  const backend = () => events.getAppender().ensureSqliteBackendSync();
  return { repo, root, worktree, coordinate, args, streamId, operationId, deps, bundles, run, backend,
    settle: () => handleSettle({ featureId: streamId, capsuleVersion: capsule.identity.capsuleVersion, batchId: 'batch',
      claims: [{ taskId: 'root', fields: args.result, evidence: [] }] }, root, fixtureWiring(root, events), { execute: deps }),
    profiles: () => profiles,
    calls: () => calls, rows: () => events.query(streamId),
    reopen: async () => { events.close(); events = new EventStore(root); await events.initialize(); } };
}

describe('immutable segment input', () => {
  /** Actual terminal claim and custody replay after deleting the original checkout, with no leaf call. */
  it('SegmentRetry_DeletedTreeOriginalArgs', async () => {
    const f = await setup(); const first = await f.run(); expect(first.success).toBe(true);
    const initial = f.backend().lookupOperationClaim<{ bundleRefs: { digest: { algorithm: 'sha256'; value: string } }[] }>(f.operationId);
    const runRef = initial?.result.bundleRefs[0]; if (runRef === undefined) throw new Error('Missing run custody');
    const run = decodeExecuteIntentBundle(await f.bundles.resolve(runRef.digest));
    expect(run.input?.args.coordinate).toEqual(f.coordinate);
    const held = f.backend().lookupSegmentInput(f.operationId); expect(held).toBeDefined();
    const binding = SegmentInputBindingV1Schema.parse(JSON.parse(held ?? 'null'));
    expect(binding.callerDigest).not.toEqual(binding.inputDigest); expect(binding.inputDigest).not.toEqual(binding.inputRef.digest);
    const claim = f.backend().lookupOperationClaim(f.operationId); expect(claim?.sequences).toHaveLength(1);
    await rmrfAsync(f.worktree); await f.reopen();
    const replay = await f.run({ ...f.args, result: { a: true, z: { a: 1, b: 2 } } });
    expect(replay).toEqual(first); expect(f.calls()).toBe(1); expect(f.backend().lookupSegmentInput(f.operationId)).toBe(held);
  });

  /** One real leaf effect survives the failed final publication. The supported elision verifies its already committed emission. */
  it('LeafCommittedBeforeCrash_OriginalCoordinate', async () => {
    const f = await setup(); f.bundles.failTerminal = true;
    expect((await f.run()).success).toBe(false); expect(f.calls()).toBe(1);
    expect(f.backend().lookupOperationClaim(f.operationId)).toBeUndefined();
    const held = f.backend().lookupSegmentInput(f.operationId); await f.reopen(); f.bundles.failTerminal = false;
    expect((await f.run()).success).toBe(true); expect(f.calls()).toBe(1);
    expect((await f.rows()).filter(row => row.type === 'emission.violated')).toHaveLength(0);
    expect((await f.rows()).filter(row => row.type === 'task.completed')).toHaveLength(1);
    expect(f.backend().lookupSegmentInput(f.operationId)).toBe(held);
  });

  /** The binding does not grant an unsafe leaf permission to repeat effects without its terminal receipt. */
  it('InterruptedClaimRequiredLeaf_RefusesWithoutReplacement', async () => {
    const f = await setup(true); f.bundles.failTerminal = true; await f.run(); const held = f.backend().lookupSegmentInput(f.operationId);
    await f.reopen(); f.bundles.failTerminal = false; const retry = await f.run();
    expect(retry.success).toBe(false); expect(retry.error?.message).toContain('safe continuation'); expect(f.calls()).toBe(1);
    expect(f.backend().lookupSegmentInput(f.operationId)).toBe(held);
  });

  /** Public coordinate bytes never select the internal path, including the unchanged coordinate of a valid run. */
  it('PublicCoordinate_RefusesBeforeEffects', async () => {
    const f = await setup(); const { verificationInput: _internal, ...publicDeps } = f.deps;
    expect((await f.run({ ...f.args, coordinate: f.coordinate }, publicDeps)).success).toBe(false);
    expect(f.calls()).toBe(0); expect(f.backend().lookupSegmentInput(f.operationId)).toBeUndefined();
  });

  /** Seeded changed nested caller values cannot replace a winner or invoke another leaf. */
  it('ChangedFork_DigestMismatch', async () => {
    const f = await setup(); expect((await f.run()).success).toBe(true); const held = f.backend().lookupSegmentInput(f.operationId);
    await fc.assert(fc.asyncProperty(fc.integer({ min: 3, max: 50 }), async value => {
      expect((await f.run({ ...f.args, result: { z: { a: value, b: 2 }, a: true } })).success).toBe(false);
    }), { seed: 192705, numRuns: 12 });
    expect(f.calls()).toBe(1); expect(f.backend().lookupSegmentInput(f.operationId)).toBe(held);
  });
  /** The held reference is mandatory even when a terminal claim exists. A copied claim is not a replacement. */
  it('MissingInput_NoExecution', async () => {
    const f = await setup(); expect((await f.run()).success).toBe(true);
    const held = f.backend().lookupSegmentInput(f.operationId);
    const binding = SegmentInputBindingV1Schema.parse(JSON.parse(held ?? 'null'));
    const missing = new RunBundleStore(makeTempDir('missing-input-custody-'));
    closes.push(() => rmrfAsync(missing.root));
    const failed = await f.run(f.args, { ...f.deps, bundleStore: missing });
    expect(failed.success).toBe(false); expect(f.calls()).toBe(1);
    expect(binding.inputRef.artifactId).toBe(`segment-input:${f.operationId}`);
  });

  /** A losing observation cannot replace the first row. Its namespace neither allocates a sequence nor accepts ordinary claims. */
  it('TwoInitialObservations_OneInputBinding', async () => {
    const f = await setup(); const backend = f.backend();
    const before = await f.rows(); const key = `${f.operationId}:race`;
    expect(backend.bindSegmentInput(key, '{"winner":1}')).toBe('{"winner":1}');
    const contender = new EventStore(f.root); await contender.initialize();
    try { expect(contender.getAppender().ensureSqliteBackendSync().bindSegmentInput(key, '{"winner":2}')).toBe('{"winner":1}'); }
    finally { contender.close(); }
    expect(await f.rows()).toEqual(before); expect(f.backend().lookupOperationClaim(key)).toBeUndefined();
    expect(() => f.backend().lookupIdempotencyClaim(SEGMENT_INPUT_CLAIM_STREAM, key)).toThrow('Reserved');
    expect(() => f.backend().deleteStream(SEGMENT_INPUT_CLAIM_STREAM)).toThrow('Reserved');
    const row = before[0]; if (row === undefined) throw new Error('Missing fixture event');
    expect(() => f.backend().appendEvent(SEGMENT_INPUT_CLAIM_STREAM, row)).toThrow('Reserved');
    expect(() => f.backend().addOutboxEntry(SEGMENT_INPUT_CLAIM_STREAM, row)).toThrow('Reserved');
    expect(f.backend().readSequenceHighWaterMark(SEGMENT_INPUT_CLAIM_STREAM)).toBe(0);
    await expect(f.backend().atomicAppend({ streamId: SEGMENT_INPUT_CLAIM_STREAM, idempotencyKey: key, n: 1,
      finalize: () => { throw new Error('must not finalize'); } })).rejects.toThrow('Reserved');
    expect(f.backend().lookupSegmentInput(key)).toBe('{"winner":1}');
  });

  /** A wrong pinned root and a failed durable write cannot claim input or invoke a leaf. */
  it('InvalidCandidateOrCustodyFailure_NoBinding', async () => {
    const f = await setup(); const internal = f.deps.verificationInput;
    if (internal === undefined) throw new Error('Missing internal fixture');
    expect((await f.run(f.args, { ...f.deps, verificationInput: { ...internal,
      coordinate: { ...f.coordinate, rootBaseCommit: 'f'.repeat(40) } } })).success).toBe(false);
    expect(f.backend().lookupSegmentInput(f.operationId)).toBeUndefined(); expect(f.calls()).toBe(0);
    class FailedInputStore extends RunBundleStore { override async put(): Promise<never> { throw new Error('input custody unavailable'); } }
    expect((await f.run(f.args, { ...f.deps, bundleStore: new FailedInputStore(f.bundles.root) })).success).toBe(false);
    expect(f.backend().lookupSegmentInput(f.operationId)).toBeUndefined(); expect(f.calls()).toBe(0);
  });

  /** Advisory and halted terminal receipts replay their full original verdict without another handler call. */
  it('TerminalAdvisoryAndHalt_ExactReplay', async () => {
    for (const mode of ['advisory', 'halt']) {
      const f = await setup(false, mode === 'advisory' ? 'advisory' : 'block'); let calls = 0;
      const deps = { ...f.deps, handlers: { fixture_effect: async () => {
        calls++; return mode === 'advisory' ? { success: true } : { success: false, error: { code: 'EXPECTED_HALT', message: 'fixture halt' } };
      } } };
      const first = await f.run(f.args, deps); expect(first.success).toBe(mode === 'advisory');
      expect(f.backend().lookupOperationClaim(f.operationId)).toBeDefined(); await f.reopen();
      expect(await f.run(f.args, deps)).toEqual(first); expect(calls).toBe(1);
    }
  });

  /** Two independent publishers observe different clean heads before either transaction claims the input. Neither executes a leaf. */
  it('OverlappingObservations_IndependentSqlitePublishersKeepOneWinner', async () => {
    const f = await setup();
    await f.repo.commitIn('root', { 'file.txt': 'second observed head' });
    const observed = await observeTree(f.worktree); if (observed.kind !== 'tree' || observed.head === undefined) throw new Error('Missing head');
    expect(observed.head).not.toBe(f.coordinate.observedHeadCommit);
    const payloads: string[] = [];
    for (const head of [f.coordinate.observedHeadCommit, observed.head]) {
      const input = ExecuteIntentInputSchema.parse({ intent: 'task-completion', streamId: f.streamId,
        args: { ...f.args, coordinate: { ...f.coordinate, observedHeadCommit: head } } });
      const digest = await f.bundles.put(Buffer.from(canonicalJson(input)));
      payloads.push(canonicalJson(SegmentInputBindingV1Schema.parse({ namespace: 'exarchos.segment-input.v1', bindingVersion: '1',
        operationId: f.operationId, streamId: f.streamId, callerDigest: { algorithm: 'sha256', value: f.deps.verificationInput?.callerDigest.slice(7) },
        inputDigest: { algorithm: 'sha256', value: normalizedExecuteRequestDigest(input.intent, input.streamId, input.args).slice(7) },
        inputRef: { artifactId: `segment-input:${f.operationId}`, digest } })));
    }
    expect(payloads[0]).not.toBe(payloads[1]);
    const source = `import { SqliteBackend } from ${JSON.stringify(new URL('../../src/storage/sqlite-backend.ts', import.meta.url).href)};
      import { STORE_DB_FILENAME } from ${JSON.stringify(new URL('../../src/utils/paths.ts', import.meta.url).href)};
      import { join } from 'node:path';
      console.error('initializing'); const store = new SqliteBackend(join(process.env.BINDING_TEST_ROOT, STORE_DB_FILENAME)); store.initialize(); console.error('initialized');
      console.log('ready');
      await new Promise(resolve => process.stdin.once('data', resolve)); console.error('released');
      try { console.log(store.bindSegmentInput(process.env.BINDING_TEST_OPERATION, process.env.BINDING_TEST_PAYLOAD)); }
      finally { store.close(); process.stdin.destroy(); }`;
    const children = payloads.map(payload => spawn('bun', ['--eval', source], {
      env: { ...process.env, BINDING_TEST_ROOT: f.root, BINDING_TEST_OPERATION: f.operationId, BINDING_TEST_PAYLOAD: payload },
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    const readers = children.map(child => createInterface({ input: child.stdout }));
    const errors = children.map(() => '');
    children.forEach((child, index) => child.stderr?.on('data', data => { errors[index] = (errors[index] + String(data)).slice(-4000); }));
    try {
      await Promise.all(children.map(async (child, index) => { const [ready] = await Promise.race([once(readers[index]!, 'line', { signal: AbortSignal.timeout(10000) }).catch(() => { throw new Error(`readiness: ${errors[index]}`); }), once(child, 'exit').then(() => { throw new Error(errors[index] || 'publisher exited before readiness'); })]); expect(ready).toBe('ready'); }));
      const results = readers.map((reader, index) => once(reader, 'line', { signal: AbortSignal.timeout(10000) }).catch(() => { throw new Error(`winner: ${errors[index]}`); }));
      const exits = children.map(child => once(child, 'exit', { signal: AbortSignal.timeout(10000) }));
      for (const child of children) child.stdin.end('publish\n');
      const winners = await Promise.all(results); expect(winners[0]?.[0]).toEqual(winners[1]?.[0]);
      expect(payloads).toContain(winners[0]?.[0]);
      expect(f.backend().lookupSegmentInput(f.operationId)).toBe(winners[0]?.[0]);
      for (const [code] of await Promise.all(exits)) expect(code).toBe(0);
      expect(f.calls()).toBe(0); expect(f.backend().lookupOperationClaim(f.operationId)).toBeUndefined();
      expect((await f.rows()).filter(row => row.type !== 'workflow.prepared')).toEqual([]);
    } finally {
      for (const reader of readers) reader.close();
      await Promise.all(children.map(async child => {
        if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
      }));
    }
  });

  /** Recovery authenticates input first but cannot execute an unfinished segment before the normal pinned-profile gate. */
  it('InterruptedBinding_ResumesOnlyAfterPinnedProfileEligibility', async () => {
    const f = await setup(false, 'block', true); f.bundles.failTerminal = true;
    expect((await f.run()).success).toBe(false); expect(f.calls()).toBe(1);
    expect(f.backend().lookupOperationClaim(f.operationId)).toBeUndefined();
    const held = f.backend().lookupSegmentInput(f.operationId); expect(held).toBeDefined();
    const internal = f.deps.verificationInput; if (internal === undefined) throw new Error('Missing internal fixture');
    const replayOnly = await f.run(f.args, { ...f.deps, verificationInput: { ...internal, replayOnly: true } });
    expect(replayOnly.success).toBe(false); expect(replayOnly.error?.message).toContain('Replay-only'); expect(f.calls()).toBe(1);
    f.bundles.failTerminal = false;
    const result = await f.settle();
    expect(result.success, JSON.stringify(result)).toBe(false);
    expect(f.calls()).toBe(1); expect(f.backend().lookupOperationClaim(f.operationId)).toBeUndefined();
    expect(f.backend().lookupSegmentInput(f.operationId)).toBe(held);
    expect(result.error?.code).toBe('CAPSULE_UNRESOLVED');
    expect(result.error?.message).toContain('config');
    const valid = await setup(false, 'block', true, true); valid.bundles.failTerminal = true;
    expect((await valid.run()).success).toBe(false); await valid.reopen(); valid.bundles.failTerminal = false;
    expect((await valid.settle()).success).toBe(true); expect(valid.calls()).toBe(2);
    expect(valid.profiles()).toEqual([undefined, { capsuleVersion: valid.coordinate.capsule.capsuleVersion,
      profile: valid.deps.verificationInput?.authority.capsule.settlementContract.verificationProfile }]);
    const ineligible = await setup(false, 'block', true, true, false); ineligible.bundles.failTerminal = true;
    expect((await ineligible.run()).success).toBe(false); ineligible.bundles.failTerminal = false;
    const rejected = await ineligible.settle(); expect(rejected.data).toMatchObject({ outcome: 'rejected', acceptedTasks: [] });
    expect(ineligible.calls()).toBe(1); expect(ineligible.backend().lookupOperationClaim(ineligible.operationId)).toBeUndefined();
  });

});
