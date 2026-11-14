// @oracle-sources: real Git ancestry, persisted SQLite operation claims and original run custody, independent dependency-position model
/** Whole-DAG settlement authenticates predecessors and retains original verification coordinates. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { ArtifactIdSchema } from '../../src/workflow/admission/types.js';
import { handlePrepare } from '../../src/verbs/prepare/handler.js';
import { PreparedCapsuleReceiptData } from '../../src/verbs/prepare/schemas.js';
import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { requestDigest } from '../../src/contract/request-context.js';
import { handleExecuteIntent } from '../../src/verbs/execute/executor.js';
import { decodeExecuteIntentBundle } from '../../src/verbs/execute/run-bundle.js';
import { IntentExecutedOutputSchema } from '../../src/verbs/execute/schemas.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import { decodeSettlementBundle, encodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { settlementClaimKey, verificationOperationId } from '../../src/verbs/settle/settlement-reads.js';
import { SettlementReceiptData } from '../../src/verbs/settle/schemas.js';
import { OrchestrateIntentExecutedData } from '../../src/events/schemas.js';
import { DECIDE_ONCE_CLAIM_STREAM } from '../../src/storage/sqlite/constants.js';
import { recompiledSliceOf } from '../../src/verbs/prepare/recompiled-slice.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { capsuleDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { configDigestAt } from '../../src/verbs/prepare/prepare-scope.js';
import { deviationIdOf, handleSettle } from '../../src/verbs/settle/handler.js';
import { productionExecuteDeps } from '../../src/verbs/execute/executor.js';
import { resolveTaskStanding } from '../../src/verbs/settle/task-standing.js';
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
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });
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
async function fixture(dependencies: Readonly<Record<string, readonly string[]>> = { a: [], b: [], c: ['a', 'b'], d: ['c'] }, compilerVersion = 'exarchos-prepare-8') {
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
  capsule.provenance.compilerVersion = compilerVersion;
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
  await events.append(capsule.identity.workflowId, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
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
  return { text, stateDir, repo, events, bundle, capsule, trees, heads, forks, claim, ctx, call, rows, commands, standing };
}


/** Intercepts only the outer write after verification and before its transaction acquires the lock. */
function beforeCommit(f: Awaited<ReturnType<typeof fixture>>, change: (attempt: number) => Promise<void>) {
  const appender = f.events.getAppender(); const decide = appender.decideOnce.bind(appender);
  const resolve = f.events.bundleStore.resolve.bind(f.events.bundleStore);
  let committing = false; let attempts = 0;
  vi.spyOn(f.events.bundleStore, 'resolve').mockImplementation(async digest => {
    expect(committing).toBe(false); return resolve(digest);
  });
  vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
    if (!id.startsWith('settle:')) return decide(id, digest, closure);
    await change(++attempts);
    return decide(id, digest, tx => {
      committing = true;
      try { return closure(tx); } finally { committing = false; }
    });
  });
  return () => attempts;
}

/** Changes one selected row while its head and task-level judgement stay constant. */
async function changeMember(f: Awaited<ReturnType<typeof fixture>>, kind: string, tick: number) {
  const rows = await f.rows(); const row = rows.find(row => row.type === kind && (kind !== 'gate.executed' || row.data?.gateName === 'static-analysis'));
  if (row === undefined) throw new Error('Missing selected effect');
  const db = new Database(join(f.stateDir, 'exarchos.db'));
  try {
    const data = { ...row.data, fenceProbe: tick }; const payload = { ...row, data };
    db.prepare('UPDATE events SET data=?,payload=? WHERE streamId=? AND sequence=?').run(JSON.stringify(data), JSON.stringify(payload), row.streamId, row.sequence);
  } finally { db.close(); }
}


/** Publishes a genuine new root segment and an actual accepting claim for a competing coordinator. */
async function competingAcceptance(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
  const prior = await f.standing(taskId); if (prior.kind !== 'accepted') throw new Error('Missing prior acceptance');
  const rows = await f.rows(); const selection = selectPreparedAuthority(rows, f.capsule.identity.workflowId);
  if (selection === undefined) throw new Error('Missing prepared authority');
  const authority = await loadPreparedCustody(selection, f.events.bundleStore);
  const original = decodeExecuteIntentBundle(await f.events.bundleStore.resolve(prior.proof.runBundle.digest));
  if (original.input === undefined) throw new Error('Missing original input');
  await f.repo.commitIn(taskId, { 'later.txt': 'new accepted root' });
  const head = await git(f.trees.get(taskId) ?? '', 'rev-parse', 'HEAD');
  const identity = { ...f.capsule.identity, batchId: 'competing' };
  const outer = settlementClaimKey(f.capsule.identity.workflowId, identity);
  const segment = verificationOperationId(outer, taskId);
  const claims = [f.claim(taskId)]; const digest = requestDigest({ streamId: f.capsule.identity.workflowId, identity, claims, deviations: [] });
  const coordinate = { ...prior.proof.coordinate, capsule: f.capsule.identity, observedHeadCommit: head };
  const args = { ...original.input.args, capsuleVersion: f.capsule.identity.capsuleVersion, coordinate };
  const profile = f.capsule.settlementContract.verificationProfile; if (profile === undefined) throw new Error('Missing pinned profile');
  const result = await runAsTrustedCaller(f.stateDir, () => handleExecuteIntent({ intent: 'task-completion', featureId: f.capsule.identity.workflowId,
    operationId: segment, args }, f.stateDir, { ...f.ctx, verificationProfile: { capsuleVersion: f.capsule.identity.capsuleVersion,
      profile } }, { ...productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'),
    verificationInput: { authority, outerOperationId: outer, callerDigest: digest, batchId: identity.batchId, coordinate } }));
  expect(result.success, JSON.stringify(result)).toBe(true);
  const receipt = IntentExecutedOutputSchema.options[0].shape.data.parse(result.data); expect(receipt.outcome).toBe('committed');
  const oldOuter = f.events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(prior.proof.outerOperationId);
  const oldReceipt = SettlementReceiptData.parse(oldOuter?.result);
  const ref = oldReceipt.bundleRefs?.[0]; if (ref === undefined) throw new Error('Missing outer custody');
  const oldBundle = decodeSettlementBundle(await f.events.bundleStore.resolve(ref.digest));
  const trace = { taskId, outcome: 'verified' as const, operationId: segment, bundleRefs: receipt.bundleRefs, treeCommit: head, coordinate };
  const bundle = { ...oldBundle, operationId: outer, requestDigest: digest, capsule: identity, claims, verification: [trace], acceptedTasks: [taskId] };
  const bundleRef = { artifactId: ArtifactIdSchema.parse(`run-bundle:settlement-adjudication:${identity.batchId}:${identity.capsuleVersion}`), digest: await f.events.bundleStore.put(encodeSettlementBundle(bundle)) };
  const oldRecord = rows.find(row => row.type === 'execution.settled' && row.data?.operationId === prior.proof.outerOperationId);
  await f.events.getAppender().decideOnce(outer, digest, tx => ({ streamId: f.capsule.identity.workflowId,
    events: [{ type: 'execution.settled', schemaVersion: '1.0', data: { ...oldRecord?.data, operationId: outer,
      workflowId: identity.workflowId, capsuleVersion: identity.capsuleVersion, definitionVersion: identity.definitionVersion,
      batchId: identity.batchId, requestDigest: digest, acceptedTasks: [taskId], bundleRefs: [bundleRef] } }],
    result: { ...oldReceipt, operationId: outer, capsule: identity, requestDigest: digest, acceptedTasks: [taskId], verification: [trace],
      tailSequence: tx.readStream(f.capsule.identity.workflowId).version + 1, bundleRefs: [bundleRef] } }));
  const current = await f.standing(taskId); expect(current.kind, JSON.stringify(current)).toBe('accepted');
  if (current.kind === 'accepted') expect(current.proof.headCommit).toBe(head);
}

/** Uses the public prepare handler with pinned local commands, then reuses its full compiled capsule. */
async function compiledFixture(dependencies: Readonly<Record<string, readonly string[]>>) {
  const f = await fixture(dependencies);
  const command = `${process.execPath} command.cjs`;
  await writeFile(join(f.repo.checkout, '.exarchos.yml'), JSON.stringify({ verification: { staticAnalysis: { lint: `${command} static` },
    integration: { command: `${command} integration` } }, contract: { codegen: `${command} codegen`, diff: `${command} diff @baseCommit@ @headCommit@` }, typecheck: `${command} types` }));
  await writeFile(join(f.repo.checkout, 'plan.md'), f.text);
  const prepare = () => runAsTrustedCaller(f.stateDir, () => handlePrepare({ featureId: f.capsule.identity.workflowId, repoRoot: f.repo.checkout,
    intent: { mode: 'compile', designRef: 'plan.md', approval: { decision: 'approved', designDigest: createHash('sha256').update(f.text).digest('hex') } } },
    f.stateDir, f.ctx, { compilerVersion: 'exarchos-prepare-8', catalogInvariants: () => [] }));
  const result = await prepare(); expect(result.success, JSON.stringify(result)).toBe(true);
  const receipt = PreparedCapsuleReceiptData.parse(result.data); Object.assign(f.capsule, ExarchosCapsuleV1Schema.parse(receipt.capsule));
  return { ...f, prepare };
}

describe('standing transaction fences', () => {
  /** A changed selected effect cannot commit through an unchanged task-level summary. */
  it('SelectedMember_SameSummary_Conflicts', async () => {
    for (const kind of ['gate.executed', 'task.completed']) {
      const f = await fixture({ a: [] });
      const attempts = beforeCommit(f, tick => changeMember(f, kind, tick));
      const result = await f.call([f.claim('a')]);
      expect(result.success, JSON.stringify(result)).toBe(false); expect(result.error?.code).toBe('CONCURRENCY_CONFLICT'); expect(attempts()).toBe(3);
      const rows = await f.rows();
      expect(rows.filter(row => row.type === 'execution.settled' || (row.type === 'workflow.transition' && row.trigger === 'settle'))).toEqual([]);
      expect(rows.filter(row => row.type === 'orchestrate.intent_executed')).toHaveLength(1);
      expect((await f.commands()).filter(command => command.args[0] === 'static')).toHaveLength(1);
      vi.restoreAllMocks();
    }
  });

  /** A missing actual terminal claim cannot be reconstructed from retained rows or run custody. */
  it('SelectedClaim_Missing_NoOuterAcceptance', async () => {
    const f = await fixture({ a: [] }); let removed = false;
    beforeCommit(f, async () => {
      if (removed) return; removed = true;
      const terminal = (await f.rows()).find(row => row.type === 'orchestrate.intent_executed');
      const operationId = OrchestrateIntentExecutedData.parse(terminal?.data).operationId;
      expect(f.events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(operationId)).toBeDefined();
      const db = new Database(join(f.stateDir, 'exarchos.db'));
      try { expect(db.prepare('DELETE FROM idempotency_claims WHERE streamId=? AND idempotencyKey=?').run(DECIDE_ONCE_CLAIM_STREAM, operationId).changes).toBe(1); } finally { db.close(); }
      expect(f.events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(operationId)).toBeUndefined();
    });
    const result = await f.call([f.claim('a')]); expect(result.success, JSON.stringify(result)).toBe(false);
    expect((await f.rows()).filter(row => row.type === 'execution.settled')).toEqual([]);
    expect((await f.rows()).filter(row => row.type === 'orchestrate.intent_executed')).toHaveLength(1);
    expect((await f.commands()).filter(command => command.args[0] === 'static')).toHaveLength(1);
  });

  /** Loss of an omitted accepted task's actual outer claim forces refresh and prevents graph completion. */
  it('PriorOuterClaimLost_RefreshesWithoutMove', async () => {
    const f = await fixture({ a: [], b: [] });
    const first = SettlementReceiptData.parse((await f.call([f.claim('a')], 'first')).data);
    const attempts = beforeCommit(f, async attempt => {
      if (attempt !== 1) return;
      const db = new Database(join(f.stateDir, 'exarchos.db'));
      try { expect(db.prepare('DELETE FROM idempotency_claims WHERE streamId=? AND idempotencyKey=?').run(DECIDE_ONCE_CLAIM_STREAM, first.operationId).changes).toBe(1); }
      finally { db.close(); }
      expect(f.events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(first.operationId)).toBeUndefined();
    });
    const last = await f.call([f.claim('b')], 'last'); expect(last.success, JSON.stringify(last)).toBe(true);
    expect(last.data).toMatchObject({ acceptedTasks: ['b'], phaseMove: { kind: 'not-decided' } });
    expect(attempts()).toBe(2); expect((await f.commands()).filter(row => row.args[0] === 'static')).toHaveLength(2);
  });

  /** Revisions after a real segment keep its effects but prevent a mixed-revision settlement. */
  it('NewRevisionAfterSegment_NoMixedMove', async () => {
    const f = await fixture({ a: [] }); let injected = false;
    beforeCommit(f, async () => {
      if (injected) return; injected = true;
      const terminal = (await f.rows()).find(row => row.type === 'orchestrate.intent_executed');
      await f.events.append(f.capsule.identity.workflowId, { type: 'design.revised', schemaVersion: '1.0', data: {
        operationId: 'revision:race', workflowId: f.capsule.identity.workflowId, capsuleVersion: f.capsule.identity.capsuleVersion,
        batchId: 'revision', priorDesignVersion: 1, nextDesignVersion: 2, deviationIds: ['change'], affectedTasks: ['a'],
        bundleRefs: terminal?.data?.bundleRefs } });
    });
    const result = await f.call([f.claim('a')]); expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ outcome: 'recompile-required', acceptedTasks: [] });
    expect((await f.rows()).filter(row => row.type === 'workflow.transition' && row.trigger === 'settle')).toEqual([]);
    expect((await f.commands()).filter(command => command.args[0] === 'static')).toHaveLength(1);
  });

  /** Prior accepted standing and the final verified subset permit one atomic phase move. */
  it('FinalSubset_AcceptsAndMovesAtomically', async () => {
    const f = await fixture({ a: [], b: [] });
    await f.events.append(f.capsule.identity.workflowId, { type: 'state.patched', data: { patch: { riskTier: 'low', boundaryTouching: false } } });
    expect((await f.call([f.claim('a')], 'first')).success).toBe(true);
    const result = await f.call([f.claim('b')], 'last'); expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data, JSON.stringify(result)).toMatchObject({ acceptedTasks: ['b'], phaseMove: { kind: 'moved', from: 'delegate', to: 'review' } });
    const rows = await f.rows(); const move = rows.find(row => row.type === 'workflow.transition' && row.data?.from === 'delegate');
    const outer = rows.filter(row => row.type === 'execution.settled').at(-1);
    const receipt = SettlementReceiptData.parse(result.data);
    const claim = f.events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(receipt.operationId);
    expect(move).toBeDefined(); expect(claim?.sequences).toContain(move?.sequence); expect(claim?.sequences).toContain(outer?.sequence);
    expect(claim?.eventIds).toEqual(rows.filter(row => claim?.sequences.includes(row.sequence)).map(row => row.eventId));
    const commands = await f.commands(); const tree = f.trees.get('b'); if (tree === undefined) throw new Error('Missing tree'); await rmrfAsync(tree);
    expect((await f.call([f.claim('b')], 'last')).data).toEqual(result.data);
    expect(await f.commands()).toEqual(commands); expect(await f.rows()).toEqual(rows);
  });

  /** A newer accepted root cannot replace the original blocker inside a committed child input. */
  it('ConflictingBlockerHead_NoSubstitution', async () => {
    const f = await fixture({ a: [], b: ['a'] });
    expect((await f.call([f.claim('a')], 'first')).success).toBe(true);
    let injected = false;
    beforeCommit(f, async () => {
      if (injected) return; injected = true; await competingAcceptance(f, 'a');
    });
    const result = await f.call([f.claim('b')], 'child'); expect(result.success, JSON.stringify(result)).toBe(false);
    expect(result.error?.code).toBe('SEGMENT_INPUT_REFUSED');
    expect((await f.rows()).filter(row => row.type === 'execution.settled').map(row => row.data?.batchId)).toEqual(['first', 'competing']);
    expect((await f.commands()).filter(row => row.cwd === f.trees.get('b') && row.args[0] === 'static')).toHaveLength(1);
  });

  /** Continuations retain graph nodes while the exact accepted proof changes only new result obligations and the prepare key. */
  it('Prepare_RetainsStandingAndBindsNewResults', async () => {
    const f = await compiledFixture({ a: [], b: ['a'], other: [] });
    expect((await f.call([f.claim('a')], 'first')).success).toBe(true);
    const next = await f.prepare(); expect(next.success, JSON.stringify(next)).toBe(true);
    const receipt = PreparedCapsuleReceiptData.parse(next.data); const capsule = ExarchosCapsuleV1Schema.parse(receipt.capsule);
    expect(capsule.graph.tasks.map(task => task.taskId)).toEqual(['a', 'b', 'other']);
    expect(capsule.settlementContract.requiredResults).toEqual(['b', 'other']);
    expect((await f.prepare()).data).toEqual(next.data);
    Object.assign(f.capsule, capsule);
    expect((await f.call([f.claim('b'), f.claim('other')], 'finish')).success).toBe(true);
    expect((await f.prepare()).error?.code).toBe('PHASE_NOT_PREPARABLE');
    await f.events.append(f.capsule.identity.workflowId, { type: 'workflow.transition', data: { from: 'review', to: 'delegate' } });
    const none = await f.prepare(); expect(none.success).toBe(false); expect(none.error?.code).toBe('NOTHING_TO_PREPARE');
  });

  /** Equal result obligations with a different accepted segment require a distinct prepare identity. */
  it('Prepare_ProofIdentityChangesKey', async () => {
    const f = await compiledFixture({ a: [], other: [] });
    expect((await f.call([f.claim('a')], 'first')).success).toBe(true);
    const first = PreparedCapsuleReceiptData.parse((await f.prepare()).data);
    Object.assign(f.capsule, ExarchosCapsuleV1Schema.parse(first.capsule));
    await competingAcceptance(f, 'a');
    const second = PreparedCapsuleReceiptData.parse((await f.prepare()).data);
    expect(ExarchosCapsuleV1Schema.parse(second.capsule).settlementContract.requiredResults).toEqual(['other']);
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.capsuleVersion).toBe(first.capsuleVersion + 1);
    const chained = await compiledFixture({ a: [], b: ['a'], other: [] });
    expect((await chained.call([chained.claim('a'), chained.claim('b')], 'chain')).success).toBe(true);
    const before = PreparedCapsuleReceiptData.parse((await chained.prepare()).data);
    expect(ExarchosCapsuleV1Schema.parse(before.capsule).settlementContract.requiredResults).toEqual(['other']);
    Object.assign(chained.capsule, ExarchosCapsuleV1Schema.parse(before.capsule));
    await competingAcceptance(chained, 'a');
    const after = PreparedCapsuleReceiptData.parse((await chained.prepare()).data);
    expect(ExarchosCapsuleV1Schema.parse(after.capsule).settlementContract.requiredResults).toEqual(['b', 'other']);

  });

  /** A real revision reopens descendants across a completed compatibility row and retains an unrelated accepted branch. */
  it('Prepare_RevisionClosurePreservesUnrelatedStanding', async () => {
    const f = await compiledFixture({ root: [], middle: ['root'], leaf: ['middle'], other: [] });
    const accepted = await f.call([f.claim('other')], 'unrelated'); expect(accepted.success, JSON.stringify(accepted)).toBe(true);
    await f.events.append(f.capsule.identity.workflowId, { type: 'task.completed', data: { taskId: 'middle' } });
    const receipt = SettlementReceiptData.parse(accepted.data); const ref = receipt.bundleRefs?.[0];
    if (ref === undefined) throw new Error('Missing accepted custody');
    const original = decodeSettlementBundle(await f.events.bundleStore.resolve(ref.digest));
    const deviation = { deviationKind: 'implementation', statement: 'Revise root result', affectedTasks: ['root'] };
    const deviationId = deviationIdOf(original.capsule, deviation);
    const revisionBundle = { ...original, deviations: [deviation], decisions: [{ deviationId, decision: 'accepted' as const, actor: 'user', rationale: 'Approved change' }] };
    const revisionRef = { artifactId: ref.artifactId, digest: await f.events.bundleStore.put(encodeSettlementBundle(revisionBundle)) };
    await f.events.append(f.capsule.identity.workflowId, { type: 'design.revised', schemaVersion: '1.0', data: {
      operationId: 'revision:approved', workflowId: f.capsule.identity.workflowId, capsuleVersion: f.capsule.identity.capsuleVersion,
      batchId: 'revision', priorDesignVersion: 1, nextDesignVersion: 2, deviationIds: [deviationId], affectedTasks: ['root'], bundleRefs: [revisionRef] } });
    const next = await f.prepare(); expect(next.success, JSON.stringify(next)).toBe(true);
    const prepared = PreparedCapsuleReceiptData.parse(next.data); const capsule = ExarchosCapsuleV1Schema.parse(prepared.capsule);
    expect(capsule.graph.tasks.map(task => task.taskId)).toEqual(['root', 'middle', 'leaf', 'other']);
    expect(capsule.settlementContract.requiredResults).toEqual(['root', 'middle', 'leaf']);
    const recompile = (await f.rows()).find(row => row.type === 'capsule.recompiled');
    expect(recompile?.data).toMatchObject({ declaredTasks: ['root'], invalidatedTasks: ['root', 'middle', 'leaf'] });
    expect((await f.prepare()).data).toEqual(next.data);
  });

  /** A document stamp cannot replace the latest durable failed status of a previously accepted task. */
  it('LatestStatus_DocumentCannotCompleteGraph', async () => {
    const f = await fixture({ a: [], b: [] });
    expect((await f.call([f.claim('a')], 'first')).success).toBe(true);
    await f.events.append(f.capsule.identity.workflowId, { type: 'task.failed', data: { taskId: 'a', reason: 'later failure' } });
    await f.events.append(f.capsule.identity.workflowId, { type: 'state.patched', data: { patch: { tasks: [{ id: 'a', status: 'complete' }, { id: 'b', status: 'complete' }] } } });
    const result = await f.call([f.claim('b')], 'last'); expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: ['b'], phaseMove: { kind: 'not-decided' } });
    expect((await f.standing('a')).kind).not.toBe('accepted');
  });

  /** Corrupt actual prior acceptance cannot be treated as missing standing and verified again. */
  it('CorruptAcceptedClaim_RefusesBeforeEffects', async () => {
    const f = await fixture({ a: [], b: [] });
    const first = await f.call([f.claim('a')], 'first'); expect(first.success).toBe(true);
    const receipt = SettlementReceiptData.parse(first.data); const commands = await f.commands();
    const db = new Database(join(f.stateDir, 'exarchos.db'));
    try {
      const stored = db.prepare('SELECT events_json FROM idempotency_claims WHERE streamId=? AND idempotencyKey=?').get(DECIDE_ONCE_CLAIM_STREAM, receipt.operationId);
      if (typeof stored !== 'object' || stored === null || !('events_json' in stored) || typeof stored.events_json !== 'string') throw new Error('Missing claim');
      const envelope = JSON.parse(stored.events_json); envelope.requestDigest = 'changed';
      expect(db.prepare('UPDATE idempotency_claims SET events_json=? WHERE streamId=? AND idempotencyKey=?').run(JSON.stringify(envelope), DECIDE_ONCE_CLAIM_STREAM, receipt.operationId).changes).toBe(1);
    } finally { db.close(); }
    const result = await f.call([f.claim('b')], 'next'); expect(result.success).toBe(false); expect(result.error?.code).toBe('SEGMENT_INPUT_REFUSED');
    expect(await f.commands()).toEqual(commands); expect((await f.rows()).filter(row => row.type === 'execution.settled')).toHaveLength(1);
  });

  /** Historical compilers retain completion-based standing and exact outer replay without a checkout. */
  it('Old567_RemainHistorical', async () => {
    for (const compiler of ['exarchos-prepare-5', 'exarchos-prepare-6', 'exarchos-prepare-7']) {
      const f = await fixture({ a: [] }, compiler);
      await f.events.append(f.capsule.identity.workflowId, { type: 'task.completed', data: { taskId: 'a' } });
      const result = await f.call([f.claim('a')]); expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.data).toMatchObject({ verification: [{ taskId: 'a', outcome: 'already-complete' }] });
      const rows = await f.rows(); const tree = f.trees.get('a'); if (tree === undefined) throw new Error('Missing tree'); await rmrfAsync(tree);
      expect((await f.call([f.claim('a')])).data).toEqual(result.data); expect(await f.rows()).toEqual(rows);
      expect(rows.some(row => row.type === 'orchestrate.intent_executed')).toBe(false);
    }
  });

  /** Full-graph reachability crosses completed intermediates while legacy traversal still stops there. */
  it('Recompile_DescendantsOnly', () => {
    const plan = [{ id: 'root', title: 'root', status: 'pending', blockedBy: [] },
      { id: 'middle', title: 'middle', status: 'complete', blockedBy: ['root'] },
      { id: 'leaf', title: 'leaf', status: 'pending', blockedBy: ['middle'] },
      { id: 'other', title: 'other', status: 'complete', blockedBy: [] }];
    expect(recompiledSliceOf(['root'], plan)).toEqual({ declared: ['root'], invalidated: ['root'] });
    expect(recompiledSliceOf(['root'], plan, true)).toEqual({ declared: ['root'], invalidated: ['root', 'middle', 'leaf'] });
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), statuses => {
      const chain = statuses.map((complete, i) => ({ id: `t${i}`, title: `t${i}`, status: complete ? 'complete' : 'pending', blockedBy: i === 0 ? [] : [`t${i - 1}`] }));
      expect(recompiledSliceOf(['t0'], chain, true).invalidated).toEqual(chain.map(task => task.id));
    }), { seed: 192710, numRuns: 40 });
  });
});
