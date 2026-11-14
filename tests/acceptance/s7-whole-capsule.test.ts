// @oracle-sources: authored task graph, real Git ancestry and source-revert process snapshots, SQLite original operation claims
/** Public typed preparation executes its complete approved graph and exposes bounded authentic detail. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { deriveLocalOperatorIdentity } from '../../src/dispatch/caller-identity.js';
import { TELEMETRY_STREAM } from '../../src/dispatch/core/infra-streams.js';
import { estimateOutputTokens } from '../../src/dispatch/core/economy.js';
import { foldWorkflowState } from '../../src/projections/guard-input/fold.js';
import { EventStore } from '../../src/events/store.js';
import { WorkflowPreparedData, type WorkflowEvent } from '../../src/events/schemas.js';
import { PreparedDetailOutputSchema, PreparedCapsuleReceiptData } from '../../src/verbs/prepare/schemas.js';
import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { resolveTaskStanding } from '../../src/verbs/settle/task-standing.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { task, textOf } from '../helpers/capsule/prepared-authority.js';

function emissionAudit(row: WorkflowEvent): boolean { return row.type === 'gate.executed' && row.data?.gateName === 'event-emissions'; }

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function git(tree: string, ...args: string[]) { return (await execFileAsync('git', ['-C', tree, ...args])).trim(); }

/** Each task adds a real assertion over its source. The selected-source revert must make it red. */
async function fixture(edges: Readonly<Record<string, readonly string[]>>, medium = false, large = false) {
  const stateDir = makeTempDir('s7-acceptance-'); cleanup.push(() => rmrfAsync(stateDir));
  const journal = join(stateDir, 'commands.jsonl');
  const tasks = Object.entries(edges).map(([id, parents]) => task(id, { blockedBy: [...parents], files: [`src/${id}.cjs`],
    testFiles: [`tests/${id}.test.cjs`], riskTier: medium ? 'medium' : 'low',
    instructions: large ? 'Implement the approved behavior and preserve its tests. '.repeat(100) : `Implement ${id}.` }));
  const text = textOf(tasks);
  const command = `const fs=require('node:fs'),cp=require('node:child_process');const mode=process.argv[2];const paths=process.argv.slice(3).filter(x=>x!=='--');const sources=Object.fromEntries(fs.readdirSync('src').map(p=>[p,fs.readFileSync('src/'+p,'utf8')]));fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify({mode,paths,sources,cwd:process.cwd()})+'\\n');try{if(mode==='probe'||mode==='integration'){const selected=mode==='probe'?paths:(fs.existsSync('tests')?fs.readdirSync('tests').map(p=>'tests/'+p):[]);for(const p of selected)cp.execFileSync(process.execPath,[p],{stdio:'pipe'});}else{for(const p of fs.readdirSync('src'))cp.execFileSync(process.execPath,['--check','src/'+p],{stdio:'pipe'});}}catch(e){process.exit(1);}`;
  const config = { verification: { tests: { globs: ['tests/**/*.test.cjs'], probe: { command: 'node command.cjs probe', files: 'as-arguments', failureExitCodes: [1] } },
    staticAnalysis: { lint: 'node command.cjs static' }, integration: { command: 'node command.cjs integration' } }, typecheck: 'node command.cjs types' };
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'design.md': text, 'command.cjs': command,
    '.exarchos.yml': JSON.stringify(config), ...Object.fromEntries(tasks.map(t => [`src/${t.id}.cjs`, 'module.exports = 0;\n'])) } });
  cleanup.push(() => rmrfAsync(repo.root));
  const events = new EventStore(stateDir); await events.initialize(); cleanup.push(() => events.close());
  const stream = 'whole-capsule';
  const ctx: DispatchContext = { stateDir, eventStore: events, enableTelemetry: true, callerIdentity: deriveLocalOperatorIdentity(stateDir) };
  const call = async (action: string, args: Record<string, unknown>) => {
    const auditCount = (await events.query(stream)).filter(emissionAudit).length;
    const result = await dispatch('exarchos_orchestrate', { action, ...args }, ctx);
    if (action !== 'read_prepared_capsule') {
      await vi.waitFor(async () => expect((await events.query(stream)).filter(emissionAudit)).toHaveLength(auditCount + 1));
    }
    return result;
  };
  const args = { featureId: stream, repoRoot: repo.checkout, intent: { mode: 'bootstrap', workflowType: 'feature', baseRef: 'integration', designRef: 'design.md',
    approval: { decision: 'approved', designDigest: createHash('sha256').update(text).digest('hex') } } };
  const preparedResult = await call('prepare', args); expect(preparedResult.success, JSON.stringify(preparedResult)).toBe(true);
  const rows = await events.query(stream); const row = rows.find(r => r.type === 'workflow.prepared');
  const record = WorkflowPreparedData.parse(row?.data);
  const claim = events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(record.operationId);
  const receipt = PreparedCapsuleReceiptData.parse(claim?.result); const capsule = ExarchosCapsuleV1Schema.parse(receipt.capsule);
  const trees = new Map<string, string>(); const heads = new Map<string, string>(); const forks = new Map<string, string>();
  const build = async () => {
    const remaining = new Set(tasks.map(t => t.id));
    while (remaining.size > 0) {
      const id = [...remaining].find(id => (edges[id] ?? []).every(parent => heads.has(parent))); if (!id) throw new Error('Cyclic fixture');
      const tree = await repo.worktreeFor(id); trees.set(id, tree);
      for (const parent of edges[id] ?? []) await git(tree, 'merge', '--no-edit', `task/${parent}`);
      forks.set(id, await git(tree, 'rev-parse', 'HEAD'));
      await repo.commitIn(id, { [`src/${id}.cjs`]: 'module.exports = 1;\n', [`tests/${id}.test.cjs`]:
        `const assert=require('node:assert/strict');assert.equal(require('../src/${id}.cjs'),1);` + (edges[id] ?? []).map(parent => `assert.equal(require('../src/${parent}.cjs'),1);`).join('') });
      heads.set(id, await git(tree, 'rev-parse', 'HEAD')); remaining.delete(id);
    }
  };
  const settle = (ids: readonly string[], batchId: string) => call('settle', { featureId: stream, capsuleVersion: record.capsuleVersion, batchId,
    claims: ids.map(taskId => ({ taskId, fields: { worktreePath: trees.get(taskId), ...((edges[taskId]?.length ?? 0) ? { forkCommit: forks.get(taskId) } : {}) }, evidence: [] })) });
  const standing = async (taskId: string) => resolveTaskStanding({ streamId: stream, taskId, rows: await events.query(stream), bundles: events.bundleStore,
    lookupClaim: key => events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(key) });
  return { events, stream, repo, tasks, record, receipt, claim, capsule, preparedResult, call, args, build, settle, standing, trees, heads, forks, journal };
}

describe('activated whole capsule', () => {
  it('Acceptance_ThreeWavesOnePrepare', async () => {
    for (const partial of [false, true]) {
      const f = await fixture({ root: [], left: ['root'], right: ['root'], finish: ['left', 'right'] }); await f.build();
      expect(f.capsule.graph.tasks.map(t => t.taskId)).toEqual(['root', 'left', 'right', 'finish']);
      expect(f.capsule.provenance.compilerVersion).toBe('exarchos-prepare-8');
      if (partial) {
        const first = await f.settle(['root'], 'partial'); expect(first.success, JSON.stringify(first)).toBe(true);
        expect(first.data).toMatchObject({ acceptedTasks: ['root'], phaseMove: { kind: 'not-decided' } });
        expect(foldWorkflowState(await f.events.query(f.stream)).phase).toBe('delegate');
      }
      const result = await f.settle(partial ? ['finish', 'right', 'left'] : ['finish', 'right', 'left', 'root'], 'rest');
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.data).toMatchObject({ acceptedTasks: partial ? ['finish', 'left', 'right'] : ['finish', 'left', 'right', 'root'] });
      for (const task of f.tasks) expect((await f.standing(task.id)).kind).toBe('accepted');
      expect(result.data).toMatchObject({ phaseMove: { kind: 'moved', from: 'delegate', to: 'review' } });
      const rows = await f.events.query(f.stream); expect(foldWorkflowState(rows).phase).toBe('review'); expect(rows.filter(r => r.type === 'workflow.prepared')).toHaveLength(1);
      expect(rows.filter(r => r.type === 'task.completed')).toHaveLength(4);
      const replay = await f.settle(partial ? ['finish', 'right', 'left'] : ['finish', 'right', 'left', 'root'], 'rest');
      expect(replay.data).toEqual(result.data); expect((await f.events.query(f.stream)).filter(row => !emissionAudit(row))).toEqual(rows.filter(row => !emissionAudit(row)));
    }
  }, 60000);

  it('Acceptance_LandedMediumAndDependentDiff', async () => {
    const f = await fixture({ root: [], child: ['root'] }, true); await f.build();
    await git(f.repo.checkout, 'merge', '--no-edit', 'task/root');
    const result = await f.settle(['child', 'root'], 'landed'); expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: ['child', 'root'] });
    for (const id of ['root', 'child']) {
      const standing = await f.standing(id); expect(standing.kind, JSON.stringify(standing)).toBe('accepted');
      if (standing.kind !== 'accepted') throw new Error('Missing actual standing');
      expect(standing.proof.coordinate.diffBaseCommit).toBe(id === 'root' ? f.repo.baseCommit : f.forks.get(id));
      expect(standing.proof.coordinate.observedHeadCommit).toBe(f.heads.get(id));
    }
    const logs: { mode: string; paths: string[]; sources: Record<string, string>; cwd: string }[] = (await readFile(f.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const root = logs.filter(row => row.mode === 'probe' && row.cwd === f.trees.get('root'));
    expect(root.map(row => row.paths)).toEqual([['tests/root.test.cjs'], ['tests/root.test.cjs']]);
    expect(root.map(row => row.sources['root.cjs'])).toEqual(['module.exports = 1;\n', 'module.exports = 0;\n']);
    const child = logs.filter(row => row.mode === 'probe' && row.cwd === f.trees.get('child'));
    expect(child.map(row => row.paths)).toEqual([['tests/child.test.cjs'], ['tests/child.test.cjs']]);
    expect(child.map(row => row.sources['root.cjs'])).toEqual(['module.exports = 1;\n', 'module.exports = 1;\n']);
    expect(child.map(row => row.sources['child.cjs'])).toEqual(['module.exports = 1;\n', 'module.exports = 0;\n']);
  }, 60000);

  it('Acceptance_ThirtyTaskReceipt_ActivationCappedDetail', async () => {
    const edges = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`task-${i}`, i < 10 ? [] : [`task-${i - 10}`]]));
    const f = await fixture(edges, false, true);
    expect(estimateOutputTokens(f.preparedResult)).toBeLessThanOrEqual(8000);
    const data = f.preparedResult.data;
    expect(data).toHaveProperty('detailRead');
    if (!data || typeof data !== 'object' || !('detailRead' in data)) throw new Error('Actual prepare was not capped with a read');
    expect(f.capsule.graph.dependencies).toHaveLength(20);
    expect(f.capsule.provenance.compilerVersion).toBe('exarchos-prepare-8');
    expect(f.capsule.settlementContract.requiredResults).toEqual(f.tasks.map(task => task.id));
    expect(f.capsule.settlementContract.verificationProfile?.tests.probe.command).toMatchObject({ state: 'resolved', argv: ['node', 'command.cjs', 'probe'] });
    const invocation = data.detailRead;
    if (!invocation || typeof invocation !== 'object' || !('arguments' in invocation)) throw new Error('Missing read arguments');
    const before = await f.events.query(f.stream); const telemetryBefore = await f.events.query(TELEMETRY_STREAM);
    expect(telemetryBefore.some(row => row.type === 'tool.invoked' && row.data?.tool === 'exarchos_orchestrate')).toBe(true);
    const items = [];
    let args = invocation.arguments as Record<string, unknown>;
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(30); const response = await f.call('read_prepared_capsule', args);
      expect(estimateOutputTokens(response)).toBeLessThanOrEqual(8000);
      const page = PreparedDetailOutputSchema.parse(response);
      if (!page.success) throw new Error(page.error.message);
      expect(estimateOutputTokens(page)).toBeLessThanOrEqual(8000); expect(page.data.capsuleDigest).toBe(f.record.capsuleDigest);
      expect(page.data.operationId).toBe(f.record.operationId); items.push(...page.data.items);
      if (!page.data.continuation) break; args = page.data.continuation.arguments;
    }
    expect(items.map(item => item.context)).toEqual(f.capsule.graph.tasks.map(task => task.taskContext));
    expect(items.map(item => item.resultContract)).toEqual(f.tasks.map(task => f.capsule.contracts.taskResults[task.id]));
    expect(await f.events.query(f.stream)).toEqual(before);
    expect(await f.events.query(TELEMETRY_STREAM)).toEqual(telemetryBefore);
    expect(f.events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(f.record.operationId)).toEqual(f.claim);
    expect((await f.call('prepare', f.args)).data).toEqual(f.preparedResult.data);
    expect(f.events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(f.record.operationId)).toEqual(f.claim);
    expect(f.capsule.graph.tasks).toHaveLength(30);
  }, 60000);
});
