// @oracle-sources: real Git endpoint commits, probe-process source snapshots, persisted SQLite evidence and immutable input custody
/** Immutable leaf measurements retain the selected task delta and legacy calls retain their ref behavior. */
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_HANDLERS, adaptLadderGate } from '../../src/verbs/composite.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { capsuleDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { configDigestAt } from '../../src/verbs/prepare/prepare-scope.js';
import { handleSettle } from '../../src/verbs/settle/handler.js';
import { productionExecuteDeps } from '../../src/verbs/execute/executor.js';
import { decodeExecuteIntentBundle } from '../../src/verbs/execute/run-bundle.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { fixtureWiring } from '../unit/verbs/execute/fixtures.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { EventStore } from '../../src/events/store.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { observeRepository, observeClaimedTree } from '../../src/utils/git-tree.js';
import { nodeTestProfile } from '../helpers/verification-profile.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { runAsTrustedCaller, seedActivePhaseAttempt } from '../../tools/test-helpers/trusted-context.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

/** Executes fixture Git operations only in the isolated repository. */
async function git(tree: string, ...args: string[]) { return (await execFileAsync('git', ['-C', tree, ...args])).trim(); }

/** The real probe runner records source bytes on every baseline, revert and restored run. */
async function setup() {
  const stateDir = makeTempDir('s7-diff-');
  const journal = join(stateDir, 'probe.jsonl');
  const runner = `const fs=require('node:fs');const paths=process.argv.slice(2).filter(x=>x!=='--');const source=fs.readFileSync('src/value.cjs','utf8');const blocker=fs.existsSync('src/blocker.cjs')?fs.readFileSync('src/blocker.cjs','utf8'):null;fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({paths,source,blocker})+'\\n');let ok=true;for(const p of paths){const t=JSON.parse(fs.readFileSync(p,'utf8'));ok=ok&&source===t.source&&(t.blocker===undefined||blocker===t.blocker)}process.exit(ok?0:1);`;
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'src/value.cjs': 'root', 'probe.cjs': runner } });
  closes.push(() => rmrfAsync(repo.root));
  const tree = await repo.worktreeFor('target');
  const events = new EventStore(stateDir); await events.initialize();
  closes.push(async () => { events.close(); await rmrfAsync(stateDir); });
  const identity = profiledValidCapsule().identity;
  await seedActivePhaseAttempt(events, identity.workflowId);
  const repository = await observeRepository(tree); if (repository.kind !== 'repository') throw new Error('Missing Git repository');
  const profile = nodeTestProfile();
  profile.tests.probe = { ...profile.tests.probe, command: { state: 'resolved', argv: [process.execPath, 'probe.cjs'], source: 'config' }, globs: ['**/*.test.json'], files: 'after-separator' };
  profile.tests.globs = { state: 'resolved', globs: ['**/*.test.json', '**/*.test.ts'], source: 'config' };
  const ctx: DispatchContext = { stateDir, eventStore: events, enableTelemetry: false, verificationProfile: { capsuleVersion: identity.capsuleVersion, profile } };
  const coordinate = async (base = repo.baseCommit, head?: string) => TaskVerificationCoordinateSchema.parse({ protocolVersion: '1', taskId: 'target', capsule: identity,
    repository: repository.repository, rootBaseCommit: repo.baseCommit, diffBaseCommit: base, observedHeadCommit: head ?? await git(tree, 'rev-parse', 'HEAD'), blockers: [] });
  const args = { featureId: identity.workflowId, taskId: 'target', repoRoot: tree, worktreePath: tree, baseBranch: 'main', branch: 'task/target', riskTier: 'medium', boundaryTouching: true };
  const call = (action: string, fields: Record<string, unknown>, context: DispatchContext = ctx) => runAsTrustedCaller(stateDir, () => {
    const handler = ACTION_HANDLERS[action]; if (handler === undefined) throw new Error('Missing real gate adapter');
    return handler({ ...args, ...fields }, stateDir, context);
  });
  const trusted = (selected: Awaited<ReturnType<typeof coordinate>>): DispatchContext => ({ ...ctx, verificationInput: { coordinate: selected, segmentOperationId: 'segment:fixture' } });
  const snapshots = async (): Promise<unknown[]> => (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { stateDir, journal, repo, tree, events, identity, ctx, coordinate, args, call, trusted, snapshots };
}

describe('immutable diff leaves', () => {
  /** A landed task still kills under its pinned root while the old moving-ref mode sees no task delta. */
  it('LandedRoot_NotEmptyAgainstMovedRef', async () => {
    const f = await setup();
    await f.repo.commitIn('target', { 'src/value.cjs': 'task', 'value.test.json': JSON.stringify({ source: 'task' }) });
    const selected = await f.coordinate(); await git(f.tree, 'update-ref', 'refs/heads/main', selected.observedHeadCommit);
    const result = await f.call('check_test_adequacy', { coordinate: selected }, f.trusted(selected));
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ passed: true, redObserved: true, restoredClean: true, probedTests: ['value.test.json'] });
    expect(await f.snapshots()).toEqual([
      { paths: ['value.test.json'], source: 'task', blocker: null },
      { paths: ['value.test.json'], source: 'root', blocker: null },
    ]);
    expect(await readFile(join(f.tree, 'src/value.cjs'), 'utf8')).toBe('task');
    expect(await git(f.tree, 'status', '--porcelain')).toBe('');
    const legacy = await f.call('check_test_adequacy', {});
    expect(legacy.data).toMatchObject({ passed: false, discriminant: 'no-new-tests' });
    expect(await f.snapshots()).toHaveLength(2);
  });

  /** The dependent probe retains blocker source and excludes blocker tests while reverting only its own source. */
  it('DependentKillProbe_ExcludesBlocker', async () => {
    const f = await setup();
    await f.repo.commitIn('target', { 'src/blocker.cjs': 'blocker', 'blocker.test.json': JSON.stringify({ source: 'root', blocker: 'blocker' }) });
    const fork = await git(f.tree, 'rev-parse', 'HEAD');
    await f.repo.commitIn('target', { 'src/value.cjs': 'dependent', 'dependent.test.json': JSON.stringify({ source: 'dependent', blocker: 'blocker' }) });
    const selected = await f.coordinate(fork);
    const result = await f.call('check_test_adequacy', { coordinate: selected }, f.trusted(selected));
    expect(result.data, JSON.stringify(result)).toMatchObject({ passed: true, probedTests: ['dependent.test.json'], redObserved: true, restoredClean: true });
    expect(await f.snapshots()).toEqual([
      { paths: ['dependent.test.json'], source: 'dependent', blocker: 'blocker' },
      { paths: ['dependent.test.json'], source: 'root', blocker: 'blocker' },
    ]);
    expect(await git(f.tree, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(f.tree, 'src/value.cjs'), 'utf8')).toBe('dependent');
    expect(await readFile(join(f.tree, 'src/blocker.cjs'), 'utf8')).toBe('blocker');
    const legacy = await f.call('check_test_adequacy', {});
    expect(legacy.data).toMatchObject({ passed: false });
  });

  /** Mock detection uses the selected pair on a clean checkout and refuses changed or dirty endpoints. */
  it('MockBoundary_ExactHeadNotHEAD', async () => {
    const f = await setup();
    await f.repo.commitIn('target', { 'boundary.test.ts': "vi.mock('remote-sdk');\n" });
    const selected = await f.coordinate();
    await git(f.tree, 'update-ref', 'refs/heads/main', selected.observedHeadCommit);
    const result = await f.call('check_mock_boundary', { coordinate: selected }, f.trusted(selected));
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ findings: [expect.objectContaining({ mockedTarget: 'remote-sdk' })] });
    const legacy = await f.call('check_mock_boundary', {}); expect(legacy.data).toMatchObject({ findings: [] });
    await f.repo.commitIn('target', { 'boundary.test.ts': 'export const value = 1;\n' });
    const before = await f.events.query(f.identity.workflowId);
    const moved = await f.call('check_mock_boundary', { coordinate: selected }, f.trusted(selected));
    expect(moved.error?.code).toBe('TASK_COORDINATE_REFUSED');
    expect(await f.events.query(f.identity.workflowId)).toEqual(before);
    const missing = { ...selected, observedHeadCommit: 'f'.repeat(40) };
    const refused = await f.call('check_mock_boundary', { coordinate: missing }, f.trusted(missing));
    expect(refused.success).toBe(false); expect(refused.error?.code).toBe('TASK_COORDINATE_REFUSED');
    const m = await setup();
    await m.repo.commitIn('target', { '.gitattributes': 'payload.bin diff=endpoint\n', 'payload.bin': '\0payload' });
    const script = join(m.stateDir, 'textconv.cjs'); const marker = join(m.stateDir, 'textconv-ran');
    await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'called');fs.writeFileSync(${JSON.stringify(join(m.tree, 'TEXTCONV_DIRTY'))},'leftover');process.stdout.write(fs.readFileSync(process.argv[2]));`);
    await git(m.tree, 'config', 'diff.endpoint.textconv', `"${process.execPath}" "${script}"`);
    const checked = await m.coordinate();
    const endpoint = await m.call('check_mock_boundary', { coordinate: checked }, m.trusted(checked));
    expect(existsSync(marker)).toBe(true); expect(existsSync(join(m.tree, 'TEXTCONV_DIRTY'))).toBe(true);
    expect(endpoint.error?.code).toBe('TASK_COORDINATE_REFUSED');
    const rows = await m.events.query(m.identity.workflowId);
    const evidence = rows.filter(row => row.type === 'admission.evidence-recorded');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.data?.evidence).not.toMatchObject({ verdict: 'pass' });
    expect(rows.filter(row => row.type === 'gate.executed').map(row => row.data?.passed)).toEqual([false]);
  });

  /** Public and mismatched coordinates refuse before provider effects, including a disabled gate. Historical omissions remain admitted. */
  it('CoordinateAdapter_RejectsPublicAndMismatch_PreservesLegacy', async () => {
    const f = await setup(); const selected = await f.coordinate();
    const before = await f.events.query(f.identity.workflowId);
    for (const action of ['check_test_adequacy', 'check_mock_boundary']) {
      const publicResult = await f.call(action, { coordinate: selected });
      expect(publicResult.error?.code).toBe('TASK_COORDINATE_REFUSED');
      const mismatch = await f.call(action, { coordinate: { ...selected, diffBaseCommit: 'f'.repeat(40) } }, f.trusted(selected));
      expect(mismatch.error?.code).toBe('TASK_COORDINATE_REFUSED');
      const omitted = await f.call(action, {}, f.trusted(selected)); expect(omitted.error?.code).toBe('TASK_COORDINATE_REFUSED');
    }
    const disabled = { ...f.ctx, projectConfig: resolveConfig({ review: { gates: { 'mock-boundary': { D1: 'disabled' } } } }) };
    expect((await f.call('check_mock_boundary', { coordinate: selected }, disabled)).error?.code).toBe('TASK_COORDINATE_REFUSED');
    expect(await f.events.query(f.identity.workflowId)).toEqual(before); expect(existsSync(f.journal)).toBe(false);
    const received: unknown[] = [];
    const adapter = adaptLadderGate(async args => { received.push(args); return { success: true }; });
    await adapter({ featureId: f.identity.workflowId, taskId: 'target', baseBranch: 'main' }, f.stateDir, f.ctx);
    expect(received).toEqual([{ featureId: f.identity.workflowId, taskId: 'target', baseBranch: 'main', verificationProfile: f.ctx.verificationProfile }]);
  });

  /** A changed physical checkout refuses before adequacy can revert source or start its probe. */
  it('Adequacy_SelectedCheckoutRequiredBeforeRevert', async () => {
    const f = await setup(); const selected = await f.coordinate();
    await f.repo.commitIn('target', { 'src/value.cjs': 'later', 'later.test.json': JSON.stringify({ source: 'later' }) });
    const before = await f.events.query(f.identity.workflowId);
    const result = await f.call('check_test_adequacy', { coordinate: selected }, f.trusted(selected));
    expect(result.error?.code).toBe('TASK_COORDINATE_REFUSED');
    expect(await f.events.query(f.identity.workflowId)).toEqual(before); expect(existsSync(f.journal)).toBe(false);
    expect(await readFile(join(f.tree, 'src/value.cjs'), 'utf8')).toBe('later');
  });

  /** The real bound executor supplies authority to the production adapter and never invokes fsmonitor during clean-tree checks. */
  it('BoundExecutor_AuthenticatesActualLeaf_AndSuppressesFsmonitor', async () => {
    const f = await setup();
    await f.repo.commitIn('target', { 'src/value.cjs': 'task', 'value.test.json': JSON.stringify({ source: 'task' }), 'check.cjs': 'process.exit(0);' });
    const profile = f.ctx.verificationProfile!.profile;
    const command = { state: 'resolved' as const, argv: [process.execPath, 'check.cjs'], source: 'config' as const };
    profile.staticAnalysis = { state: 'resolved', checks: [{ name: 'lint', command }], source: 'config' };
    profile.integration.command = command;
    profile.contract = { codegen: command, typecheck: command, diff: { ...command, argv: [...command.argv, '@baseCommit@', '@headCommit@'] } };
    const text = textOf([task('target', { riskTier: 'medium', boundaryTouching: true })]);
    const bundle = preparedFixture(text); const capsule = bundle.capsule;
    const read = readDesignRecord(Buffer.from(text), bundle.designRecord?.reference ?? 'plan.md');
    if (read.kind !== 'typed') throw new Error('Invalid approved fixture');
    capsule.provenance.compilerVersion = 'exarchos-prepare-8';
    capsule.graph.tasks = read.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate',
      stage: { kind: 'task-batch', stepId: 'delegate' }, taskContext: {
        taskId: entry.id, title: entry.title, instructions: entry.instructions, files: [...entry.files], testFiles: [...entry.testFiles],
        acceptance: [...entry.acceptance], riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
        blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
        source: { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } },
        knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] },
      } }));
    capsule.graph.dependencies = []; capsule.graph.joins = []; capsule.contracts.taskInputs = {};
    capsule.contracts.taskResults = { target: [{ name: 'worktreePath', type: 'string', required: true }] };
    const selected = await f.coordinate();
    capsule.settlementContract = { ...profiledValidCapsule().settlementContract, requiredResults: ['target'], skipPhases: [],
      verificationProfile: f.ctx.verificationProfile?.profile,
      verificationMode: 'immutable-task-diff-v1', scope: { repository: selected.repository, checkout: f.repo.checkout, configDigest: await configDigestAt(f.repo.checkout) },
      taskVerification: { target: { riskTier: 'medium', boundaryTouching: true, baseRef: 'main', baseCommit: f.repo.baseCommit } } };
    const digest = await f.events.bundleStore.put(encodePreparedBundle(bundle)); const initial = prepared(bundle);
    await f.events.append(capsule.identity.workflowId, { type: 'workflow.prepared', schemaVersion: '1.0', data: {
      ...initial.data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest }] } });
    const hook = join(f.stateDir, 'monitor.sh');
    await writeFile(hook, '#!/bin/sh\nprintf invoked > "$0.invoked"\nprintf "token\\0"\n'); await chmod(hook, 0o700);
    await git(f.tree, 'config', 'core.fsmonitor', hook);
    const refs = await git(f.tree, 'show-ref');
    const execute = productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate');
    const result = await runAsTrustedCaller(f.stateDir, () => handleSettle({ featureId: capsule.identity.workflowId, capsuleVersion: capsule.identity.capsuleVersion,
      batchId: 'bound', claims: [{ taskId: 'target', fields: { worktreePath: f.tree }, evidence: [] }] }, f.stateDir, fixtureWiring(f.stateDir, f.events), { execute }));
    expect(result.success, JSON.stringify(result)).toBe(true);
    const rows = await f.events.query(capsule.identity.workflowId); const terminal = rows.find(row => row.type === 'orchestrate.intent_executed');
    expect(terminal).toBeDefined();
    const refsOfRun = terminal?.data?.bundleRefs;
    if (!Array.isArray(refsOfRun) || refsOfRun[0] === undefined) throw new Error('Missing run custody');
    const run = decodeExecuteIntentBundle(await f.events.bundleStore.resolve(refsOfRun[0].digest));
    expect(run.leaves[0]?.verdict.status).toBe('passed');
    expect(run.input?.args.coordinate).toMatchObject({ diffBaseCommit: f.repo.baseCommit, observedHeadCommit: selected.observedHeadCommit });
    expect(await f.snapshots()).toHaveLength(2);
    expect(existsSync(`${hook}.invoked`)).toBe(false); expect(await git(f.tree, '--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain')).toBe(''); expect(await git(f.tree, 'show-ref')).toBe(refs);
    expect(await readFile(join(f.tree, 'src/value.cjs'), 'utf8')).toBe('task');
    expect(await readFile(join(f.tree, 'value.test.json'), 'utf8')).toBe(JSON.stringify({ source: 'task' }));
    await observeClaimedTree(f.tree, f.repo.baseCommit); expect(existsSync(`${hook}.invoked`)).toBe(true);
  });

});
