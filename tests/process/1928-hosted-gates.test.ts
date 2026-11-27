// @oracle-sources: actual bound executor and prepared custody, real Git worktrees, the local approved-check executor and real check children
/** Prove that the task gate checks and spec coverage run only in the local approved-check executor, with or without a verifier. */
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { capsuleDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { canonicalJson, requestDigest } from '../../src/contract/request-context.js';
import type { CheckPlan, VerificationHostConnector } from '../../src/contract/verification/harness-verification.js';
import { runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../src/events/store.js';
import { observeRepository, observeTree } from '../../src/utils/git-tree.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import { allocatePhaseAttemptId } from '../../src/workflow/phase-attempt-id.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import type { VerificationProfile } from '../../src/workflow/verification/profile.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { handleExecuteIntent, productionExecuteDeps, derivedLeafOperationId } from '../../src/verbs/execute/executor.js';
import { runApprovedCheck, type ApprovedCheckRequest, type CheckSession, type LegObservation } from '../../src/verbs/verification/check-executor.js';
import { settlementClaimKey, verificationOperationId } from '../../src/verbs/settle/settlement-reads.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { mintDispatchContext } from '../../src/dispatch/dispatch-context.js';
import type { RunbookDefinition, RunbookStep } from '../../src/runbooks/types.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

vi.mock('bun:sqlite', () => import('../../src/storage/__shims__/bun-sqlite-node.js'));

/** The capabilities of the trusted fixture caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence'];

/** A trusted caller context with a fresh operation identity. */
function correlation() {
  return mintDispatchContext(undefined, snapshotCallerAuthorization(deriveMcpCallerIdentity({ sessionId: 'local-gates-fixture' }),
    createInMemoryResolver(CAPABILITIES)));
}

/** The dispatch wiring of one fixture store. */
function wiring(stateDir: string, eventStore: EventStore): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false, callerIdentity: deriveMcpCallerIdentity({ sessionId: 'local-gates-fixture' }),
    capabilityResolver: createInMemoryResolver(CAPABILITIES) };
}

/** One orchestrate step of the fixture runbook. */
function step(action: string, params: Readonly<Record<string, unknown>>): RunbookStep {
  return { tool: 'exarchos_orchestrate', action, onFail: 'stop', params };
}

/** The task-completion runbook of the fixture, with only the chosen steps. */
function runbook(steps: readonly RunbookStep[]): RunbookDefinition {
  return { id: 'task-completion', phase: 'delegate', description: 'local gate fixture', steps, templateVars: ['taskId', 'featureId'], autoEmits: [] };
}

/** A check script that appends a marker outside the checkout, then runs its body. */
function markerScript(marker: string, body: string): string {
  return `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n${body}\n`;
}

/** The number of runs that a marker records. */
async function runsOf(marker: string): Promise<number> {
  return existsSync(marker) ? (await readFile(marker, 'utf8')).split('\n').filter(Boolean).length : 0;
}

/** A connector whose client fails and counts each call. No check gate calls it. */
function unusedConnector(): { readonly connector: VerificationHostConnector; readonly calls: string[] } {
  const calls: string[] = [];
  const unused = async (): Promise<never> => { calls.push('client'); throw new Error('The verifier client must not be called'); };
  return { calls, connector: { publicKey: '', gitPath: '/usr/bin/git', resourceId: 'r', profileId: 'p', client: { submit: unused, retrieve: unused } } };
}

const TASK_STEPS = {
  check_static_analysis: step('check_static_analysis', { repoRoot: 'auto', worktreePath: '<worktreePath>', taskId: '<taskId>' }),
  check_contract_drift: step('check_contract_drift', { repoRoot: 'auto', worktreePath: '<worktreePath>', baseBranch: '<baseRef>' }),
  check_integration_suite: step('check_integration_suite', { repoRoot: 'auto', worktreePath: '<worktreePath>' }),
};
type TaskAction = keyof typeof TASK_STEPS;

/** The pinned checks of the task fixture. Each program is `node` on PATH or the cruiser runner in node_modules/.bin of the worktree. */
function pinnedChecks(profile: VerificationProfile): void {
  profile.staticAnalysis = { state: 'resolved', source: 'config', checks: [
    { name: 'lint', command: { state: 'resolved', source: 'config', argv: ['node', 'lint.cjs'] } },
  ] };
  profile.boundaryChecks = [{ adapter: 'dependency-cruiser', config: '.dependency-cruiser.cjs',
    command: { state: 'resolved', source: 'config', argv: ['node_modules/.bin/depcruise', '--validate', '.dependency-cruiser.cjs', '--output-type', 'json'] } }];
  profile.firstParty = { state: 'resolved', source: 'config', globs: ['src/**'] };
  profile.contract = {
    codegen: { state: 'resolved', source: 'config', argv: ['node', 'codegen.cjs'] },
    typecheck: { state: 'resolved', source: 'config', argv: ['node', 'typecheck.cjs'] },
    diff: { state: 'resolved', source: 'config', argv: ['node', 'diff.cjs', '@baseCommit@', '@headCommit@'] },
  };
  profile.integration = { command: { state: 'resolved', source: 'config', argv: ['node', 'suite.cjs'] }, report: 'vitest-json',
    failureExitCodes: { codes: [1], source: 'config' } };
}

/** Build a prepared stream whose task segment runs the chosen check leaves on a real linked worktree with a project-local cruiser. */
async function boundFixture(actions: readonly TaskAction[]) {
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { '.gitignore': 'node_modules\n', 'value.cjs': 'module.exports = 1;\n' } });
  const root = makeTempDir('local-gates-');
  const events = new EventStore(root);
  const markers = join(root, 'markers');
  await mkdir(markers);
  await events.initialize();
  const marker = (name: string) => join(markers, name);
  const worktree = await repo.worktreeFor('root', {
    'value.cjs': 'module.exports = 2;\n',
    'src/index.cjs': 'module.exports = require("../value.cjs");\n',
    'main.test.cjs': "require('node:test')('task test', () => {});\n",
    '.dependency-cruiser.cjs': 'module.exports = {};\n',
    '.exarchos.yml': 'verification:\n  staticAnalysis:\n    lint: node lint.cjs\n',
    'lint.cjs': markerScript(marker('lint'), "process.stdout.write('lint clean\\n');"),
    'codegen.cjs': markerScript(marker('codegen'), "require('node:fs').writeFileSync('generated.cjs', 'module.exports = 3;\\n');"),
    'typecheck.cjs': markerScript(marker('typecheck'), "if (require('./generated.cjs') !== 3) process.exit(2);"),
    'diff.cjs': markerScript(marker('diff'),
      "const [base, head] = process.argv.slice(2); if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head) || base === head) process.exit(3); process.stdout.write('no breaking changes\\n');"),
    'suite.cjs': markerScript(marker('suite'),
      "process.stdout.write(JSON.stringify({ numTotalTests: 3, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{ name: 'suite', status: 'passed', assertionResults: [{}, {}, {}] }] }));"),
  });
  await mkdir(join(worktree, 'node_modules', '.bin'), { recursive: true });
  const cruiser = join(worktree, 'node_modules', '.bin', 'depcruise');
  await writeFile(cruiser, `#!/usr/bin/env node\n${markerScript(marker('cruise'),
    "process.stdout.write(JSON.stringify({ modules: [], summary: { error: 0, totalCruised: 2, violations: [] } }));")}`);
  await chmod(cruiser, 0o755);
  const repository = await observeRepository(worktree);
  const observed = await observeTree(worktree);
  if (repository.kind !== 'repository' || observed.kind !== 'tree' || observed.head === undefined) throw new Error('Missing fixture Git coordinates');
  const text = textOf([task('root', { riskTier: 'high', boundaryTouching: true, testLayer: 'integration', files: ['value.cjs', 'main.test.cjs'], testFiles: ['main.test.cjs'] })]);
  const bundle = preparedFixture(text);
  const capsule = bundle.capsule;
  const streamId = capsule.identity.workflowId;
  const design = readDesignRecord(Buffer.from(text), bundle.designRecord?.reference ?? 'plan.md');
  if (design.kind !== 'typed') throw new Error(JSON.stringify(design));
  capsule.provenance.compilerVersion = 'exarchos-prepare-8';
  capsule.graph.tasks = design.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate',
    stage: { kind: 'task-batch', stepId: 'delegate' }, taskContext: {
      taskId: entry.id, title: entry.title, instructions: entry.instructions, files: [...entry.files], testFiles: [...entry.testFiles],
      acceptance: [...entry.acceptance], riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
      blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
      source: { reference: design.snapshot.reference, digest: design.snapshot.digest, span: { ...entry.span } },
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] },
    } }));
  capsule.graph.dependencies = []; capsule.graph.joins = [];
  capsule.contracts.taskInputs = {};
  capsule.contracts.taskResults = { root: [{ name: 'passed', type: 'boolean', required: true }] };
  capsule.settlementContract = { ...profiledValidCapsule().settlementContract, requiredResults: ['root'], skipPhases: [],
    verificationMode: 'immutable-task-diff-v1', scope: { repository: repository.repository, checkout: repo.checkout, configDigest: 'c'.repeat(64) },
    taskVerification: { root: { riskTier: 'high', boundaryTouching: true, baseRef: 'main', baseCommit: repo.baseCommit } } };
  const profile = capsule.settlementContract.verificationProfile;
  if (profile === undefined) throw new Error('Missing pinned fixture profile');
  pinnedChecks(profile);
  const storeDigest = await events.bundleStore.put(encodePreparedBundle(bundle));
  await events.append(streamId, { ...prepared(bundle), data: {
    ...prepared(bundle).data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest: storeDigest }],
  } });
  const selection = selectPreparedAuthority(await events.query(streamId), streamId);
  if (selection === undefined) throw new Error('Missing approved authority');
  const authority = await loadPreparedCustody(selection, events.bundleStore);
  const outer = settlementClaimKey(streamId, { ...capsule.identity, batchId: 'batch' });
  const operationId = verificationOperationId(outer, 'root');
  const coordinate = TaskVerificationCoordinateSchema.parse({ protocolVersion: '1', taskId: 'root', capsule: capsule.identity,
    repository: repository.repository, rootBaseCommit: repo.baseCommit, diffBaseCommit: repo.baseCommit,
    observedHeadCommit: observed.head, blockers: [] });
  const args = { taskId: 'root', worktreePath: worktree, branch: 'task/root', baseRef: 'main', riskTier: 'high', boundaryTouching: true,
    capsuleVersion: capsule.identity.capsuleVersion, result: { passed: true } };
  const deps = { ...productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'),
    runbookTable: [runbook(actions.map(action => TASK_STEPS[action]))],
    verificationInput: { authority, round: 0 as const, outerOperationId: outer, batchId: 'batch', callerDigest: requestDigest(args), coordinate },
  };
  const phaseAttemptId = allocatePhaseAttemptId(streamId, 'plan', 'delegate', undefined, 1);
  await events.append(streamId, { type: 'workflow.transition', data: { featureId: streamId, from: 'plan', to: 'delegate', trigger: 'fixture', phaseAttemptId } });
  const run = (connector?: VerificationHostConnector) => runWithDispatchContext(correlation(), () => handleExecuteIntent(
    { intent: 'task-completion', featureId: streamId, operationId, args }, root, {
      ...wiring(root, events), verificationProfile: { capsuleVersion: capsule.identity.capsuleVersion, profile },
      ...(connector === undefined ? {} : { verificationHost: connector }),
    }, deps));
  const leafId = (action: TaskAction) => derivedLeafOperationId(operationId, actions.indexOf(action), action);
  return {
    repo, root, events, worktree, streamId, operationId, profile, run, leafId, marker,
    async close() { events.close(); await rmrfAsync(root); await rmrfAsync(repo.root); },
  };
}

/** The tracked and untracked changes of the worktree, with ignored paths left out. */
async function trackedStatus(worktree: string): Promise<string> {
  return execFileAsync('git', ['-C', worktree, 'status', '--porcelain']);
}

it.runIf(process.platform === 'linux')('LocalGates_BoundChecksRunInTheLocalExecutorWithOrWithoutAVerifier', async () => {
  const f = await boundFixture(['check_static_analysis', 'check_contract_drift', 'check_integration_suite']);
  try {
    const { connector, calls } = unusedConnector();
    const result = await f.run(connector);
    expect(result.success, JSON.stringify(result)).toBe(true);
    for (const action of ['check_static_analysis', 'check_contract_drift', 'check_integration_suite'] as const) {
      const leaf = await f.events.query(f.streamId, { operationId: f.leafId(action) });
      expect(leaf.map(event => event.type), action).toEqual(['admission.evidence-recorded', 'gate.executed']);
      expect(canonicalJson(leaf[1]?.data), action).toContain('"passed":true');
    }
    for (const name of ['lint', 'cruise', 'codegen', 'typecheck', 'diff', 'suite']) expect(await runsOf(f.marker(name)), name).toBe(1);
    expect(existsSync(join(f.worktree, 'generated.cjs'))).toBe(false);
    expect(await trackedStatus(f.worktree)).toBe('');
    expect(calls).toEqual([]);
    expect(await f.run()).toEqual(result);
    for (const name of ['lint', 'cruise', 'codegen', 'typecheck', 'diff', 'suite']) expect(await runsOf(f.marker(name)), name).toBe(1);
  } finally { await f.close(); }
}, 300000);

it.runIf(process.platform === 'linux')('LocalGates_ARetryOfTheSameOperation_ReplaysTheStoredObservationWithoutARerun', async () => {
  const f = await boundFixture([]);
  try {
    const handler = ACTION_HANDLERS.check_static_analysis;
    if (handler === undefined) throw new Error('Missing static analysis action');
    const context = correlation();
    const call = () => runWithDispatchContext(context, () => handler({ featureId: f.streamId, repoRoot: f.worktree }, f.root, wiring(f.root, f.events)));
    const first = await call();
    const retried = await call();
    expect(first.success, JSON.stringify(first)).toBe(true);
    expect(retried).toEqual(first);
    expect(await runsOf(f.marker('lint'))).toBe(1);

    const evidence = await f.events.query(f.streamId, { operationId: context.operationId });
    expect(evidence.filter(event => event.type === 'admission.evidence-recorded')).toHaveLength(1);
  } finally { await f.close(); }
}, 300000);

it.runIf(process.platform === 'linux')('LocalGates_AWrongWorkingDirectoryAndADirtyCheckout_RefuseWithARecordedOutcome', async () => {
  const f = await boundFixture([]);
  try {
    const handler = ACTION_HANDLERS.check_static_analysis;
    if (handler === undefined) throw new Error('Missing static analysis action');
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, '.exarchos.yml'), 'verification:\n  staticAnalysis:\n    lint: node lint.cjs\n');
    await writeFile(join(outside, 'lint.cjs'), markerScript(f.marker('outside'), ''));
    const context = correlation();
    const refused = await runWithDispatchContext(context, () => handler({ featureId: f.streamId, repoRoot: outside }, f.root, wiring(f.root, f.events)));
    expect(refused).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED' } });
    const recorded = await f.events.query(f.streamId, { operationId: context.operationId });
    expect(recorded.map(event => event.type)).toEqual(['admission.evidence-recorded', 'gate.executed']);
    expect(canonicalJson(recorded[0]?.data)).toContain('"verdict":"indeterminate"');
    await appendFile(join(f.worktree, 'value.cjs'), '// dirty\n');
    const dirty = await runWithDispatchContext(correlation(), () => handler({ featureId: f.streamId, repoRoot: f.worktree }, f.root, wiring(f.root, f.events)));
    expect(dirty).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: expect.stringContaining('uncommitted changes') } });
    expect(await runsOf(f.marker('outside'))).toBe(0);
    expect(await runsOf(f.marker('lint'))).toBe(0);
  } finally { await f.close(); }
}, 300000);

it.runIf(process.platform === 'linux')('LocalGates_AllowlistTimeCapOutputCapAndIncompleteAttempts_StopWithARecordedOutcome', async () => {
  const f = await boundFixture([]);
  try {
    const late = f.marker('grandchild');
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'late'), 3000);`;
    const plan: CheckPlan = { operation: 'static-analysis', legs: [
      { name: 'inside', kind: 'command', argv: ['./lint.cjs'] },
      { name: 'slow', kind: 'command', argv: ['node', '-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 60000);`] },
      { name: 'loud', kind: 'command', argv: ['node', '-e', 'process.stdout.write(Buffer.alloc(80 * 1024 * 1024, 120)); setTimeout(() => {}, 60000);'] },
      { name: 'count', kind: 'command', argv: ['node', '-e', markerScript(f.marker('attempt'), '')] },
    ] };
    const request: ApprovedCheckRequest = { eventStore: f.events, operation: 'static-analysis', streamId: f.streamId, plan, profileDigest: 'a'.repeat(64),
      checkout: f.worktree, workspace: 'checkout', legTimeoutMs: 1500 };
    const every = async (session: CheckSession): Promise<readonly LegObservation[]> => {
      const runs: LegObservation[] = [];
      for (const [leg] of plan.legs.entries()) runs.push(await session.run({ leg }));
      return runs;
    };
    const context = correlation();
    const outcomes = await runWithDispatchContext(context, async () => {
      const crashed = await runApprovedCheck(request, async (session) => {
        await session.run({ leg: 3 });
        throw new Error('crash before the terminal observation');
      }).catch((error: unknown) => error);
      const retried = await runApprovedCheck(request, every);
      const replayed = await runApprovedCheck(request, every);
      return { crashed, retried, replayed };
    });
    expect(outcomes.crashed).toBeInstanceOf(Error);
    expect(outcomes.retried).toMatchObject({ kind: 'ran', replayed: false, attempt: 2 });
    expect(outcomes.replayed).toMatchObject({ kind: 'ran', replayed: true, attempt: 2 });
    if (outcomes.retried.kind !== 'ran') return;
    expect(outcomes.retried.value.map(leg => leg.end)).toEqual(['refused', 'timeout', 'output-limit', 'exited']);
    expect(await runsOf(f.marker('attempt'))).toBe(2);
    expect(await runsOf(f.marker('lint'))).toBe(0);
    await new Promise((settle) => setTimeout(settle, 2000));
    expect(existsSync(late)).toBe(false);
    expect(await trackedStatus(f.worktree)).toBe('');
  } finally { await f.close(); }
}, 300000);

it.runIf(process.platform === 'linux')('LocalSpecCoverage_PostImplementationRunsTheDeclaredTestsInTheCheckoutAndPlanningRunsNone', async () => {
  const root = makeTempDir('local-coverage-');
  const marker = join(root, 'markers', 'coverage');
  await mkdir(join(root, 'markers'));
  const repo = await scopedRepository({ integrationBranch: 'integration', files: {
    'module.cjs': 'module.exports = 2;\n',
    'main.test.cjs': markerScript(marker, [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('declared test', () => { assert.equal(require('./module.cjs'), 2); });",
    ].join('\n')),
  } });
  const events = new EventStore(root);
  try {
    await events.initialize();
    const repository = await observeRepository(repo.checkout);
    if (repository.kind !== 'repository') throw new Error('Missing fixture repository');
    const text = textOf([task('root', { files: ['module.cjs'], testFiles: ['main.test.cjs'] })]);
    const planFile = join(root, 'plan.md');
    await writeFile(planFile, text);
    const bundle = preparedFixture(text);
    const capsule = bundle.capsule;
    const streamId = capsule.identity.workflowId;
    capsule.settlementContract = { ...profiledValidCapsule().settlementContract, skipPhases: [],
      scope: { repository: repository.repository, checkout: repo.checkout, configDigest: 'c'.repeat(64) } };
    const storeDigest = await events.bundleStore.put(encodePreparedBundle(bundle));
    await events.append(streamId, { ...prepared(bundle), data: {
      ...prepared(bundle).data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest: storeDigest }],
    } });
    const phaseAttemptId = allocatePhaseAttemptId(streamId, 'plan', 'delegate', undefined, 1);
    await events.append(streamId, { type: 'workflow.transition', data: { featureId: streamId, from: 'plan', to: 'delegate', trigger: 'fixture', phaseAttemptId } });
    const profile = profiledValidCapsule().settlementContract.verificationProfile;
    if (profile === undefined) throw new Error('Missing fixture profile');
    profile.tests.globs = { state: 'resolved', source: 'config', globs: ['**/*.test.cjs'] };
    profile.tests.probe = { ...profile.tests.probe, command: { state: 'resolved', source: 'config', argv: ['node', '--test'] },
      globs: ['**/*.test.cjs'], files: 'as-arguments', failureExitCodes: { codes: [1], source: 'config' } };
    const { connector, calls } = unusedConnector();
    const coverage = (args: Record<string, unknown>) => runWithDispatchContext(correlation(), async () => {
      const handler = ACTION_HANDLERS.spec_coverage_check;
      if (handler === undefined) throw new Error('Missing spec coverage action');
      return handler({ featureId: streamId, planFile, repoRoot: repo.checkout, verificationProfile: { capsuleVersion: 1, profile }, ...args }, root, {
        ...wiring(root, events), verificationHost: connector,
      });
    });
    expect(await coverage({ coveragePhase: 'plan' })).toMatchObject({ success: true, data: { phase: 'plan', passed: true } });
    expect(await coverage({ coveragePhase: 'post-implementation', skipRun: true })).toMatchObject({ success: true, data: { passed: true } });
    expect(await runsOf(marker)).toBe(0);
    const local = await coverage({ coveragePhase: 'post-implementation' });
    expect(local, JSON.stringify(local)).toMatchObject({ success: true, data: { phase: 'post-implementation', passed: true } });
    expect(JSON.stringify(local)).toContain('Test passes: main.test.cjs');
    expect(await runsOf(marker)).toBe(1);
    expect(calls).toEqual([]);
    await appendFile(join(repo.checkout, 'module.cjs'), '// dirty\n');
    const dirty = await coverage({ coveragePhase: 'post-implementation' });
    expect(dirty).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED' } });
    expect(await runsOf(marker)).toBe(1);
  } finally {
    events.close();
    await rmrfAsync(root);
    await rmrfAsync(repo.root);
  }
}, 300000);
