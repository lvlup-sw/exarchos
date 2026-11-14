// @oracle-sources: real Git ancestry, persisted SQLite operation claims and original run custody, independent dependency-position model
/** Whole-DAG settlement authenticates predecessors and retains original verification coordinates. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { capsuleDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { configDigestAt } from '../../src/verbs/prepare/prepare-scope.js';
import { handleSettle } from '../../src/verbs/settle/handler.js';
import { productionExecuteDeps } from '../../src/verbs/execute/executor.js';
import { decodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { resolveTaskStanding } from '../../src/verbs/settle/task-standing.js';
import { taskGraphOrder } from '../../src/verbs/settle/dag-scheduler.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { fixtureWiring } from '../unit/verbs/execute/fixtures.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { EventStore } from '../../src/events/store.js';
import { observeRepository } from '../../src/utils/git-tree.js';
import { nodeTestProfile } from '../helpers/verification-profile.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { runAsTrustedCaller, seedActivePhaseAttempt } from '../../tools/test-helpers/trusted-context.js';
import type { SettlementClaim } from '../../src/verbs/settle/adjudicate.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
/** Git commands operate only on disposable linked fixture trees. */
async function git(tree: string, ...args: string[]) { return (await execFileAsync('git', ['-C', tree, ...args])).trim(); }

/** The independent model scans remaining authored tasks for satisfied predecessor predicates. */
function referenceOrder(tasks: readonly string[], edges: readonly { from: string; to: string }[]): string[] {
  const remaining = [...tasks]; const done: string[] = [];
  while (remaining.length > 0) {
    const next = remaining.findIndex(task => edges.filter(edge => edge.to === task).every(edge => done.includes(edge.from)));
    if (next < 0) throw new Error('Model cycle');
    const [task] = remaining.splice(next, 1); if (task === undefined) throw new Error('Missing model task');
    done.push(task);
  }
  return done;
}

/** Publishes an approved typed graph whose real task heads contain their direct predecessors. */
async function fixture(dependencies: Readonly<Record<string, readonly string[]>> = { a: [], b: [], c: ['a', 'b'], d: ['c'] }, legacy = false) {
  const stateDir = makeTempDir('s7-dag-');
  const journal = join(stateDir, 'commands.jsonl');
  const command = `const fs=require('node:fs'),cp=require('node:child_process');fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()})+'\\n');process.exit(fs.existsSync('FAIL')?1:0);`;
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'command.cjs': command } });
  closes.push(() => rmrfAsync(repo.root));
  const events = new EventStore(stateDir); await events.initialize();
  closes.push(async () => { events.close(); await rmrfAsync(stateDir); });
  const edges = Object.entries(dependencies).flatMap(([to, from]) => from.map(from => ({ from, to })));
  const trees = new Map<string, string>(); const heads = new Map<string, string>(); const forks = new Map<string, string>();
  for (const id of referenceOrder(Object.keys(dependencies), edges)) {
    const tree = await repo.worktreeFor(id); trees.set(id, tree);
    for (const parent of dependencies[id] ?? []) await git(tree, 'merge', '--no-edit', `task/${parent}`);
    forks.set(id, await git(tree, 'rev-parse', 'HEAD'));
    await repo.commitIn(id, { [`${id}.ts`]: `export const ${id} = true;\n` });
    heads.set(id, await git(tree, 'rev-parse', 'HEAD'));
  }
  const text = textOf(Object.entries(dependencies).map(([id, blockedBy]) => task(id, { blockedBy: [...blockedBy] })));
  const bundle = preparedFixture(text); const capsule = bundle.capsule;
  const read = readDesignRecord(Buffer.from(text), bundle.designRecord?.reference ?? 'plan.md');
  if (read.kind !== 'typed') throw new Error('Invalid typed fixture');
  const repository = await observeRepository(repo.checkout); if (repository.kind !== 'repository') throw new Error('Missing repository');
  const profile = nodeTestProfile();
  const cmd = (name: string) => ({ state: 'resolved' as const, argv: [process.execPath, 'command.cjs', name], source: 'config' as const });
  profile.staticAnalysis = { state: 'resolved', checks: [{ name: 'lint', command: cmd('static') }], source: 'config' };
  profile.integration.command = cmd('integration');
  profile.contract = { codegen: cmd('codegen'), typecheck: cmd('types'), diff: { ...cmd('diff'), argv: [...cmd('diff').argv, '@baseCommit@', '@headCommit@'] } };
  capsule.provenance.compilerVersion = legacy ? 'exarchos-prepare-7' : 'exarchos-prepare-8';
  capsule.graph.tasks = read.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate',
    stage: { kind: 'task-batch', stepId: 'delegate' }, taskContext: { taskId: entry.id, title: entry.title,
      instructions: entry.instructions, files: [...entry.files], testFiles: [...entry.testFiles], acceptance: [...entry.acceptance],
      riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
      blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
      source: { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } },
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] } } }));
  capsule.graph.dependencies = edges; capsule.graph.joins = Object.entries(dependencies).filter(([, parents]) => parents.length > 1)
    .map(([id, parents]) => ({ joinId: `join-${id}`, forTaskId: id, waitsFor: [...parents], mode: 'all' }));
  capsule.contracts.taskInputs = {};
  capsule.contracts.taskResults = Object.fromEntries(Object.entries(dependencies).map(([id, parents]) => [id,
    [{ name: 'worktreePath', type: 'string', required: true }, ...(parents.length ? [{ name: 'forkCommit', type: 'string', required: true }] : [])]]));
  capsule.settlementContract = { ...profiledValidCapsule().settlementContract, requiredResults: Object.keys(dependencies), skipPhases: [],
    verificationProfile: profile, verificationMode: 'immutable-task-diff-v1',
    scope: { repository: repository.repository, checkout: repo.checkout, configDigest: await configDigestAt(repo.checkout) },
    taskVerification: Object.fromEntries(Object.keys(dependencies).map(id => [id, { riskTier: 'low', boundaryTouching: false, baseRef: 'main', baseCommit: repo.baseCommit }])) };
  await seedActivePhaseAttempt(events, capsule.identity.workflowId);
  const digest = await events.bundleStore.put(encodePreparedBundle(bundle)); const initial = prepared(bundle);
  await events.append(capsule.identity.workflowId, { type: 'workflow.prepared', schemaVersion: '1.0', data: {
    ...initial.data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest }] } });
  const claim = (taskId: string): SettlementClaim => ({ taskId, fields: { worktreePath: trees.get(taskId),
    ...((dependencies[taskId]?.length ?? 0) > 0 ? { forkCommit: forks.get(taskId) } : {}) }, evidence: [] });
  const ctx = fixtureWiring(stateDir, events);
  const call = (claims: readonly SettlementClaim[], batchId = 'batch', handlers = ACTION_HANDLERS) => runAsTrustedCaller(stateDir, () => handleSettle({
    featureId: capsule.identity.workflowId, capsuleVersion: capsule.identity.capsuleVersion, batchId, claims }, stateDir, ctx,
    { execute: productionExecuteDeps(handlers, 'exarchos_orchestrate') }));
  const rows = () => events.query(capsule.identity.workflowId);
  const commands = async (): Promise<{cwd:string;args:string[];head:string}[]> => (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const standing = async (taskId: string) => resolveTaskStanding({ streamId: capsule.identity.workflowId, taskId, rows: await rows(),
    bundles: events.bundleStore, lookupClaim: id => events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(id) });
  return { stateDir, repo, events, capsule, trees, heads, forks, claim, ctx, call, rows, commands, standing };
}

describe('partial DAG settlement', () => {
  /** Reverse claims still commit three dependency waves and persist the original coordinate in custody. */
  it('ReverseClaims_ThreeWaveFanIn', async () => {
    const f = await fixture({ d: ['c'], c: ['a', 'b'], b: [], a: [] });
    const result = await f.call(['d', 'c', 'b', 'a'].map(f.claim));
    expect(result.success, JSON.stringify(result)).toBe(true); expect(result.data).toMatchObject({ outcome: 'settled', acceptedTasks: ['a', 'b', 'c', 'd'] });
    const rows = await f.rows(); const terminals = rows.filter(row => row.type === 'orchestrate.intent_executed');
    expect(terminals).toHaveLength(4);
    expect(rows.filter(row => row.type === 'task.completed').map(row => row.data?.taskId)).toEqual(['b', 'a', 'c', 'd']);
    for (const id of ['a', 'b', 'c', 'd']) {
      const standing = await f.standing(id); expect(standing.kind, JSON.stringify(standing)).toBe('accepted');
      if (standing.kind !== 'accepted') throw new Error('No actual standing');
      expect(standing.proof.headCommit).toBe(f.heads.get(id));
      expect(standing.proof.coordinate.diffBaseCommit).toBe(id === 'a' || id === 'b' ? f.repo.baseCommit : f.forks.get(id));
      expect(standing.proof.recheck(rows, key => f.events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(key))).toBe(true);
    }
    const settled = rows.find(row => row.type === 'execution.settled');
    const refs = settled?.data?.bundleRefs; if (!Array.isArray(refs) || refs[0] === undefined) throw new Error('Missing outer custody');
    const stored = decodeSettlementBundle(await f.events.bundleStore.resolve(refs[0].digest));
    expect(stored.verification?.map(trace => trace.coordinate?.taskId)).toEqual(['b', 'a', 'c', 'd']);
    const replay = await f.call(['d', 'c', 'b', 'a'].map(f.claim)); expect(replay.data).toEqual(result.data);
    expect(await f.rows()).toEqual(rows);
  });

  /** An omitted blocker requires real prior accepted standing. A partial subset never moves the phase. */
  it('PartialThenRest_Accepts', async () => {
    const f = await fixture();
    const partial = await f.call(['b', 'a'].map(f.claim), 'first');
    expect(partial.success, JSON.stringify(partial)).toBe(true); expect(partial.data).toMatchObject({ acceptedTasks: ['a', 'b'], phaseMove: { kind: 'not-decided' } });
    const before = (await f.rows()).filter(row => row.type === 'orchestrate.intent_executed');
    const rest = await f.call(['d', 'c'].map(f.claim), 'rest'); expect(rest.success, JSON.stringify(rest)).toBe(true);
    expect(rest.data).toMatchObject({ outcome: 'settled', acceptedTasks: ['c', 'd'] });
    expect((await f.rows()).filter(row => row.type === 'orchestrate.intent_executed').slice(0, 2)).toEqual(before);
    expect((await f.standing('d')).kind).toBe('accepted');
  });

  /** A failed predecessor stops descendants while an independent branch commits its own actual segment. */
  it('FailedBlocker_NoDependentGates', async () => {
    const f = await fixture();
    const claims = [f.claim('d'), f.claim('c'), f.claim('b'), { ...f.claim('a'), status: 'failed' as const, reason: 'failed', fields: {} }];
    const result = await f.call(claims); expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ outcome: 'corrective-capsule', acceptedTasks: ['b'] });
    expect((await f.rows()).filter(row => row.type === 'task.completed').map(row => row.data?.taskId)).toEqual(['b']);
    expect((await f.commands()).every(row => row.cwd === f.trees.get('b'))).toBe(true);
    const chain = await fixture({ root: [], child: ['root'], later: ['child'], failed: [] });
    const failed: SettlementClaim = { taskId: 'failed', status: 'failed', reason: 'unrelated failure', fields: {}, evidence: [] };
    const partial = await chain.call([chain.claim('child'), failed, chain.claim('root')], 'partial');
    expect(partial.success, JSON.stringify(partial)).toBe(true);
    expect(partial.data).toMatchObject({ outcome: 'corrective-capsule', acceptedTasks: ['child', 'root'] });
    expect((await chain.standing('failed')).kind).not.toBe('accepted');
    expect((await chain.standing('child')).kind).toBe('accepted');
    const continuation = await chain.call([chain.claim('later')], 'later');
    expect(continuation.success, JSON.stringify(continuation)).toBe(true);
    expect(continuation.data).toMatchObject({ acceptedTasks: ['later'], phaseMove: { kind: 'not-decided' } });
    expect((await chain.standing('later')).kind).toBe('accepted');
    const old = await fixture({ prior: [], fresh: ['prior'] });
    expect((await old.call([old.claim('prior')], 'accepted')).success).toBe(true);
    const priorRows = await old.rows();
    const refusedReplacement = await old.call([{ taskId: 'prior', status: 'failed', reason: 'replacement failed', fields: {}, evidence: [] }, old.claim('fresh')], 'replacement');
    expect(refusedReplacement.data).toMatchObject({ outcome: 'corrective-capsule', acceptedTasks: [] });
    expect((await old.rows()).filter(row => row.type === 'orchestrate.intent_executed')).toEqual(priorRows.filter(row => row.type === 'orchestrate.intent_executed'));
  });

  /** Duplicate identities, wrong result fields and dependent fork syntax refuse before even Git observation. */
  it('DuplicateClaims_ZeroExecution', async () => {
    const f = await fixture(); let observations = 0;
    f.ctx.treeObserver = async () => { observations += 1; throw new Error('Unexpected Git observation'); };
    const variants = [[f.claim('a'), f.claim('a')], [f.claim('a'), { ...f.claim('c'), fields: { ...f.claim('c').fields, forkCommit: 'main' } }],
      [f.claim('a'), { ...f.claim('b'), fields: { worktreePath: 42 } }], [f.claim('a'), { ...f.claim('b'), fields: { ...f.claim('b').fields, extra: true } }]];
    const before = await f.rows();
    for (const [index, claims] of variants.entries()) { const result = await f.call(claims, `bad-${index}`); expect(result.success).toBe(false); }
    expect(observations).toBe(0); expect(await f.rows()).toEqual(before);
  });

  /** A real interruption after completion but before terminal commitment cannot borrow the compatibility row. */
  it('BareCompletion_AndHaltedSegment_NoStanding', async () => {
    const f = await fixture({ a: [] });
    await f.events.append(f.capsule.identity.workflowId, { type: 'task.completed', schemaVersion: '1.0', data: { taskId: 'a' } });
    const handlers = { ...ACTION_HANDLERS, task_complete: async (...args: Parameters<NonNullable<typeof ACTION_HANDLERS.task_complete>>) => {
      await ACTION_HANDLERS.task_complete!(...args); throw new Error('Crash after real completion');
    } };
    await f.call([f.claim('a')], 'crash', handlers).catch(() => undefined);
    const before = await f.rows(); expect(before.filter(row => row.type === 'task.completed')).toHaveLength(2);
    expect(before.filter(row => row.type === 'orchestrate.intent_executed')).toHaveLength(0);
    const retry = await f.call([f.claim('a')], 'crash'); expect(retry.success).toBe(false);
    expect(await f.rows()).toEqual(before); expect((await f.standing('a')).kind).not.toBe('accepted');
    const legacy = await fixture({ a: [] }, true);
    await legacy.events.append(legacy.capsule.identity.workflowId, { type: 'task.completed', schemaVersion: '1.0', data: { taskId: 'a' } });
    const old = await legacy.call([legacy.claim('a')]); expect(old.success, JSON.stringify(old)).toBe(true);
    expect(old.data).toMatchObject({ verification: [{ taskId: 'a', outcome: 'already-complete' }] });
    expect((await legacy.rows()).filter(row => row.type === 'orchestrate.intent_executed')).toEqual([]);
  });

  /** Outer custody failure preserves committed segment claims and their exact input across a cold continuation. */
  it('OuterFailure_SegmentContinuation', async () => {
    const f = await fixture({ a: [], b: ['a'] });
    const put = f.events.bundleStore.put.bind(f.events.bundleStore);
    const failure = vi.spyOn(f.events.bundleStore, 'put').mockImplementation(async bytes => {
      if (JSON.parse(Buffer.from(bytes).toString('utf8')).kind === 'settlement-adjudication') throw new Error('Outer custody unavailable');
      return put(bytes);
    });
    try { await f.call([f.claim('b'), f.claim('a')]).catch(() => undefined); } finally { failure.mockRestore(); }
    const before = await f.rows();
    const segments = before.filter(row => row.type === 'orchestrate.intent_executed'); expect(segments).toHaveLength(2);
    expect(before.filter(row => row.type === 'execution.settled')).toHaveLength(0);
    const commands = await f.commands();
    await git(f.repo.checkout, 'update-ref', 'refs/heads/main', f.heads.get('b')!);
    f.ctx.treeObserver = async () => { throw new Error('Replay observed a moving checkout'); };
    const retry = await f.call([f.claim('b'), f.claim('a')]); expect(retry.success, JSON.stringify(retry)).toBe(true);
    expect(await f.commands()).toEqual(commands);
    expect((await f.rows()).filter(row => row.type === 'orchestrate.intent_executed')).toEqual(segments);
    expect((await f.standing('b')).kind).toBe('accepted');
  });

  /** A later foreign completion cannot turn a real halted gate segment into a verified result. */
  it('ForeignCompletion_DoesNotReplaceHaltedRun', async () => {
    const f = await fixture({ a: [], b: [] });
    await f.repo.commitIn('a', { FAIL: 'fail the real configured commands' });
    const put = f.events.bundleStore.put.bind(f.events.bundleStore);
    const failure = vi.spyOn(f.events.bundleStore, 'put').mockImplementation(async bytes => {
      if (JSON.parse(Buffer.from(bytes).toString('utf8')).kind === 'settlement-adjudication') throw new Error('No outer verdict yet');
      return put(bytes);
    });
    try { await f.call([f.claim('b'), f.claim('a')]).catch(() => undefined); } finally { failure.mockRestore(); }
    const before = await f.rows(); expect(before.filter(row => row.type === 'execution.settled')).toHaveLength(0);
    expect(before.filter(row => row.type === 'orchestrate.intent_executed')).toHaveLength(2);
    await f.events.append(f.capsule.identity.workflowId, { type: 'task.completed', schemaVersion: '1.0', data: { taskId: 'a' } });
    const commands = await f.commands();
    const replay = await f.call([f.claim('b'), f.claim('a')]); expect(replay.success, JSON.stringify(replay)).toBe(true);
    expect(replay.data).toMatchObject({ acceptedTasks: ['b'], outcome: 'corrective-capsule' });
    expect(await f.commands()).toEqual(commands);
    const after = await f.rows();
    expect(after.filter(row => row.type === 'orchestrate.intent_executed')).toEqual(before.filter(row => row.type === 'orchestrate.intent_executed'));
    expect((await f.call([f.claim('b'), f.claim('a')])).data).toEqual(replay.data);
    expect(await f.rows()).toEqual(after);
    expect((await f.standing('a')).kind).not.toBe('accepted');
  });

  /** A separate process publishes the exact outer winner after the losing call commits its segment. */
  it('ConcurrentOuterWinner_OriginalReceipt', async () => {
    const f = await fixture({ a: [] });
    const claims = [f.claim('a')]; const query = f.events.query.bind(f.events);
    let winner: unknown; let published = false; let originalEffects: unknown;
    const source = `import { EventStore } from ${JSON.stringify(new URL('../../src/events/store.ts', import.meta.url).href)};
      import { handleSettle } from ${JSON.stringify(new URL('../../src/verbs/settle/handler.ts', import.meta.url).href)};
      import { productionExecuteDeps } from ${JSON.stringify(new URL('../../src/verbs/execute/executor.ts', import.meta.url).href)};
      import { ACTION_HANDLERS } from ${JSON.stringify(new URL('../../src/verbs/composite.ts', import.meta.url).href)};
      import { fixtureWiring } from ${JSON.stringify(new URL('../unit/verbs/execute/fixtures.ts', import.meta.url).href)};
      import { runAsTrustedCaller } from ${JSON.stringify(new URL('../../tools/test-helpers/trusted-context.ts', import.meta.url).href)};
      const stateDir=${JSON.stringify(f.stateDir)}; const events=new EventStore(stateDir); await events.initialize();
      try { const result=await runAsTrustedCaller(stateDir,()=>handleSettle(${JSON.stringify({ featureId: f.capsule.identity.workflowId, capsuleVersion: f.capsule.identity.capsuleVersion, batchId: 'batch', claims })}, stateDir,fixtureWiring(stateDir,events),{execute:productionExecuteDeps(ACTION_HANDLERS,'exarchos_orchestrate')})); console.log('WINNER:'+JSON.stringify(result)); }
      finally { events.close(); }`;
    const pause = vi.spyOn(f.events, 'query').mockImplementation(async (...args) => {
      const rows = await query(...args);
      if (!published && rows.some(row => row.type === 'orchestrate.intent_executed')) {
        published = true; originalEffects = await f.commands();
        const stdout = await execFileAsync('bun', ['--eval', source], { timeout: 15000 });
        const line = stdout.split('\n').find(line => line.startsWith('WINNER:'));
        if (line === undefined) throw new Error('No actual child winner');
        winner = JSON.parse(line.slice('WINNER:'.length));
        return query(...args);
      }
      return rows;
    });
    let result;
    try { result = await f.call(claims); } finally { pause.mockRestore(); }
    expect(published).toBe(true); expect(winner).toMatchObject({ success: true });
    expect(result).toEqual(winner); expect(await f.commands()).toEqual(originalEffects);
    const rows = await f.rows();
    expect(rows.filter(row => row.type === 'orchestrate.intent_executed')).toHaveLength(1);
    expect(rows.filter(row => row.type === 'task.completed')).toHaveLength(1);
    expect(rows.filter(row => row.type === 'execution.settled')).toHaveLength(1);
    expect((await f.call(claims)).data).toEqual(result.data); expect(await f.rows()).toEqual(rows);
  });

  /** Generated orders satisfy an independent predecessor-position oracle, including a wide bounded graph. */
  it('GraphModel_StableOrderAndBoundedWork', () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }), bits => {
      const tasks = bits.map((_, i) => `t${i.toString().padStart(3, '0')}`);
      const edges = tasks.slice(1).flatMap((to, i) => bits[i] ? [{ from: tasks[i]!, to }] : []);
      const authored = [...tasks].reverse();
      const order = taskGraphOrder(authored, edges);
      expect(order).toEqual(referenceOrder(authored, edges));
      for (const edge of edges) expect(order.indexOf(edge.from)).toBeLessThan(order.indexOf(edge.to));
      expect(new Set(order).size).toBe(tasks.length);
    }), { seed: 9009, numRuns: 80 });
    const tasks = Array.from({ length: 1000 }, (_, i) => `n${i}`);
    const started = performance.now();
    const wide = taskGraphOrder(tasks, []);
    console.info(JSON.stringify({ benchmark: 'T09-wide-DAG', nodes: tasks.length, elapsedMs: performance.now() - started }));
    expect(wide).toEqual(tasks);
    expect(taskGraphOrder(['z', 'a', 'c'], [{ from: 'z', to: 'c' }])).toEqual(['z', 'a', 'c']);
    expect(() => taskGraphOrder(['a', 'b'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])).toThrow('Cyclic');
  });
});
