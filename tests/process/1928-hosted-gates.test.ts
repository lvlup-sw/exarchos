// @oracle-sources: independently compiled verifier, actual bound executor and prepared custody, real Git worktrees, Bubblewrap check children and signed compact facts
/** Prove that hosted task gate checks and hosted spec coverage run only in the independent verifier. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, it, vi } from 'vitest';
import { capsuleDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { canonicalJson, requestDigest } from '../../src/contract/request-context.js';
import {
  VerificationEvidence, VerificationRequest, checkPlanDigest, signVerification, signVerificationReply, verificationDigest, verificationKey,
  verificationValueDigest as verificationValue,
  type CheckPlan, type VerificationHostConnector, type VerificationReply,
} from '../../src/contract/verification/harness-verification.js';
import { createVerifierClient } from '../../src/dispatch/core/verifier-client.js';
import { runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../src/events/store.js';
import { authorizeVerification, copyPinnedRuntime, measureRuntimeClosure } from '../../src/runtime/verification-host/authorization.js';
import { HostProvisioning } from '../../src/runtime/verification-host/provisioning.js';
import { observeRepository, observeTree } from '../../src/utils/git-tree.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import { allocatePhaseAttemptId } from '../../src/workflow/phase-attempt-id.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import type { VerificationProfile } from '../../src/workflow/verification/profile.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { handleExecuteIntent, productionExecuteDeps, derivedLeafOperationId } from '../../src/verbs/execute/executor.js';
import { contractDriftPlan } from '../../src/verbs/gates/contract-drift-handler.js';
import { integrationSuitePlan } from '../../src/verbs/gates/check-integration-suite.js';
import { specCoveragePlan } from '../../src/verbs/gates/spec-coverage-check.js';
import { staticAnalysisPlan } from '../../src/verbs/gates/static-analysis.js';
import { settlementClaimKey, verificationOperationId } from '../../src/verbs/settle/settlement-reads.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { mintDispatchContext } from '../../src/dispatch/dispatch-context.js';
import type { RunbookDefinition, RunbookStep } from '../../src/runbooks/types.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

vi.mock('bun:sqlite', () => import('../../src/storage/__shims__/bun-sqlite-node.js'));

const execute = promisify(execFile);
const buildRoot = makeTempDir('1928-gates-build-');
let builtVerifier: Promise<string> | undefined;

afterAll(async () => { await rmrfAsync(buildRoot); });

/** Build the independent verifier once for every case in this file. */
function verifierBinary(): Promise<string> {
  builtVerifier ??= (async () => {
    const out = join(buildRoot, 'binary');
    await execute('bun', ['run', 'tools/release/build-binary.ts', '--component=verifier', '--outdir', out], { timeout: 180000 });
    return join(out, `exarchos-verifier-linux-${process.arch}`);
  })();
  return builtVerifier;
}

/** The capabilities of the trusted fixture caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence'];

/** A trusted caller context with a fresh operation identity. */
function correlation() {
  return mintDispatchContext(undefined, snapshotCallerAuthorization(deriveMcpCallerIdentity({ sessionId: 'hosted-gates-fixture' }),
    createInMemoryResolver(CAPABILITIES)));
}

/** The dispatch wiring of one fixture store. */
function wiring(stateDir: string, eventStore: EventStore): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false, callerIdentity: deriveMcpCallerIdentity({ sessionId: 'hosted-gates-fixture' }),
    capabilityResolver: createInMemoryResolver(CAPABILITIES) };
}

/** One orchestrate step of the fixture runbook. */
function step(action: string, params: Readonly<Record<string, unknown>>): RunbookStep {
  return { tool: 'exarchos_orchestrate', action, onFail: 'stop', params };
}

/** The task-completion runbook of the fixture, with only the chosen steps. */
function runbook(steps: readonly RunbookStep[]): RunbookDefinition {
  return { id: 'task-completion', phase: 'delegate', description: 'hosted gate fixture', steps, templateVars: ['taskId', 'featureId'], autoEmits: [] };
}

/** Wait for this exact child to announce readiness. */
async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((done, reject) => {
    const deadline = setTimeout(() => reject(new Error('Verifier readiness deadline')), 10000);
    let diagnostic = '';
    child.stderr?.on('data', bytes => { diagnostic += String(bytes); });
    child.once('close', code => { clearTimeout(deadline); reject(new Error(`Verifier exited ${code}: ${diagnostic}`)); });
    let output = '';
    child.stdout?.on('data', bytes => {
      output += String(bytes);
      if (output.includes('VERIFIER_READY')) { clearTimeout(deadline); done(); }
    });
  });
}

/** True when a marker path exists on the governor host. */
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** A check script that appends an observer-side marker. Inside the verifier the marker directory is not mounted. */
function markerScript(marker: string, body: string): string {
  return `try { require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n'); } catch {}\n${body}\n`;
}

/** Operator control files, a pinned runner, a pinned dependency closure and a restartable verifier for one fixture. */
async function verifierControl(root: string, checkout: string, repository: string, gitDir: string, branch: string) {
  const control = join(root, 'control');
  const state = join(control, 'state');
  const runtime = join(root, 'runtime');
  const deps = join(root, 'deps');
  await mkdir(control, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await mkdir(runtime);
  await mkdir(join(deps, 'fake-cruiser'), { recursive: true });
  await writeFile(join(deps, 'fake-cruiser', 'bin.cjs'), [
    "const padding = 'm'.repeat(150000);",
    "process.stdout.write(JSON.stringify({ modules: [{ source: padding }], summary: { error: 0, totalCruised: 2, violations: [] } }));",
  ].join('\n'));
  const node = join(runtime, 'node');
  await copyFile(await realpath(process.execPath), node);
  await chmod(node, 0o500);
  const runnerDigest = createHash('sha256').update(await readFile(node)).digest('hex');
  const dependencyDigest = await measureRuntimeClosure(deps);
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const tokenPath = join(control, 'token');
  const privateKeyPath = join(control, 'key');
  const socketPath = join(control, 's');
  const clientPath = join(control, 'client.json');
  const hostConfig = join(control, 'host.json');
  await writeFile(tokenPath, 'disposable-hosted-gates-fixture-token', { mode: 0o600 });
  await writeFile(privateKeyPath, signer.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(clientPath, JSON.stringify({ version: 1, socketPath, tokenPath, publicKey, exchangeMs: 1000, pollMs: 120000 }), { mode: 0o600 });
  const gitPath = await realpath((await execute('which', ['git'])).stdout.trim());
  const bwrapPath = await realpath((await execute('which', ['bwrap'])).stdout.trim());
  const binary = await verifierBinary();
  const requests = new Map<string, VerificationRequest>();
  const controls = { version: 1, socketPath, stateDir: state, tokenPath, privateKeyPath, publicKey, bwrapPath, gitPath, runtimePaths: ['/usr', runtime, deps] };
  let checks: (operation: VerificationRequest['operation']) => Record<string, unknown> = () => ({});
  let child: ChildProcess | undefined;
  const placeholder = { streamId: 's', phaseAttemptId: 'p', taskId: 't', leafId: 'l', operationId: 'o',
    preparedDigest: 'a'.repeat(64), callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
    profileDigest: 'e'.repeat(64), testSelectionDigest: 'f'.repeat(64), baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), blockerHeads: [] };
  const policy = () => {
    const known = [...requests.values()];
    return {
      ...controls,
      profiles: known.length === 0
        ? [{ id: 'placeholder', digest: 'e'.repeat(64), executable: node, args: [], timeoutMs: 5000 }]
        : known.map(request => ({ id: request.profileId, digest: request.subject.profileDigest, executable: node, args: [], timeoutMs: 30000,
          check: { runnerDigest, timeoutMs: 60000, outputBytes: 4 * 1024 * 1024, ...checks(request.operation) } })),
      resources: known.length === 0
        ? [{ id: 'placeholder', checkout, repository, gitDir, branch, subject: placeholder }]
        : known.map(request => ({ id: request.resourceId, checkout, repository, gitDir, branch, subject: request.subject })),
    };
  };
  const stop = async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    child = undefined;
  };
  const start = async () => {
    await stop();
    await writeFile(hostConfig, JSON.stringify(policy()), { mode: 0o600 });
    const started = spawn(binary, ['--config', hostConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = started;
    await ready(started);
  };
  return {
    gitPath, publicKey, runnerDigest, dependencyDigest, deps, node, runtime, controls, hostConfig, signer: signer.privateKey, clientPath, requests, start, stop,
    setChecks(next: typeof checks) { checks = next; },
    async admit(request: VerificationRequest) {
      if (requests.has(request.key)) return;
      requests.set(request.key, request);
      await start();
    },
  };
}

type Control = Awaited<ReturnType<typeof verifierControl>>;
type Delivery = 'original' | 'signature' | 'other-checkout' | 'other-key';

/** A connector over the real client. It counts exchanges and can alter the delivered reply. */
async function connectorFor(control: Control, checks: NonNullable<VerificationHostConnector['checks']>, otherCheckout: string) {
  const real = await createVerifierClient(control.clientPath);
  const counts = { retrieve: 0, submit: 0 };
  let delivery: Delivery = 'original';
  let foreign: VerificationReply | undefined;
  const replies: Awaited<ReturnType<typeof real.retrieve>>[] = [];
  const alter = (reply: Awaited<ReturnType<typeof real.retrieve>>, key: string, digest: string): Awaited<ReturnType<typeof real.retrieve>> => {
    if ('kind' in reply || reply.response.kind !== 'evidence') return reply;
    const signed = reply.response.signed;
    switch (delivery) {
      case 'original': return reply;
      case 'signature':
        return signVerificationReply(key, digest, { kind: 'evidence', signed: { ...signed, signature: 'A'.repeat(86) + '==' } }, control.signer);
      case 'other-checkout':
        return signVerificationReply(key, digest, { kind: 'evidence', signed: signVerification({ ...signed.evidence,
          resources: signed.evidence.resources.map((resource, index) => index === 0 ? { ...resource, path: otherCheckout } : resource) }, control.signer) }, control.signer);
      case 'other-key':
        return foreign ?? reply;
    }
  };
  const connector: VerificationHostConnector = {
    publicKey: control.publicKey, gitPath: control.gitPath, resourceId: 'unused', profileId: 'unused', checks,
    client: {
      retrieve: async (key, digest) => { counts.retrieve++; const reply = await real.retrieve(key, digest); replies.push(reply); return alter(reply, key, digest); },
      submit: async request => {
        counts.submit++; await control.admit(request);
        const reply = await real.submit(request); replies.push(reply); return alter(reply, request.key, verificationDigest(request));
      },
      poll: async request => {
        counts.submit++; await control.admit(request);
        const reply = await real.poll(request); replies.push(reply); return alter(reply, request.key, verificationDigest(request));
      },
    },
  };
  return {
    connector, counts, replies,
    deliver(next: Delivery, reply?: VerificationReply) { delivery = next; foreign = reply; },
  };
}

const TASK_STEPS = {
  check_static_analysis: step('check_static_analysis', { repoRoot: 'auto', worktreePath: '<worktreePath>', taskId: '<taskId>' }),
  check_contract_drift: step('check_contract_drift', { repoRoot: 'auto', worktreePath: '<worktreePath>', baseBranch: '<baseRef>' }),
  check_integration_suite: step('check_integration_suite', { repoRoot: 'auto', worktreePath: '<worktreePath>' }),
};
type TaskAction = keyof typeof TASK_STEPS;

/** The pinned checks of the task fixture. Every program is the approved runner or a pinned closure entry. */
function pinnedChecks(profile: VerificationProfile): void {
  profile.staticAnalysis = { state: 'resolved', source: 'config', checks: [
    { name: 'lint', command: { state: 'resolved', source: 'config', argv: ['node', 'lint.cjs'] } },
  ] };
  profile.boundaryChecks = [{ adapter: 'dependency-cruiser', config: '.dependency-cruiser.cjs',
    command: { state: 'resolved', source: 'config', argv: ['depcruise', '--validate', '.dependency-cruiser.cjs', '--output-type', 'json'] } }];
  profile.firstParty = { state: 'resolved', source: 'config', globs: ['src/**'] };
  profile.contract = {
    codegen: { state: 'resolved', source: 'config', argv: ['node', 'codegen.cjs'] },
    typecheck: { state: 'resolved', source: 'config', argv: ['node', 'typecheck.cjs'] },
    diff: { state: 'resolved', source: 'config', argv: ['node', 'diff.cjs', '@baseCommit@', '@headCommit@'] },
  };
  profile.integration = { command: { state: 'resolved', source: 'config', argv: ['node', 'suite.cjs'] }, report: 'vitest-json',
    failureExitCodes: { codes: [1], source: 'config' } };
}

/** Operator check policy that matches the pinned scope, or a changed command when the profile is refused. */
function operatorChecks(profile: VerificationProfile, control: Control, refused = false) {
  return (operation: VerificationRequest['operation']): Record<string, unknown> => {
    const plan: CheckPlan = operation === 'static-analysis' ? staticAnalysisPlan(profile)
      : operation === 'contract-drift' ? contractDriftPlan(profile.contract)
        : operation === 'integration-suite' ? integrationSuitePlan(profile.integration)
          : specCoveragePlan(profile.tests.probe);
    const legs = plan.legs.map(leg => leg.kind === 'dependency-cruiser' ? { ...leg, entry: 'fake-cruiser/bin.cjs' }
      : refused && leg.kind === 'command' ? { ...leg, argv: ['node', 'refused.cjs'] } : leg);
    return { ...plan, legs, ...(operation === 'static-analysis' ? { dependencyRoot: control.deps, dependencyDigest: control.dependencyDigest } : {}) };
  };
}

/** Build a prepared stream whose task segment runs the chosen check leaves on a real linked worktree. */
async function boundFixture(actions: readonly TaskAction[]) {
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'value.cjs': 'module.exports = 1;\n' } });
  const root = makeTempDir('1928-gates-');
  const events = new EventStore(root);
  const markers = join(root, 'markers');
  await mkdir(markers);
  await events.initialize();
  const marker = (name: string) => join(markers, name);
  const worktree = await repo.worktreeFor('root', {
    'value.cjs': 'module.exports = 2;\n',
    'src/index.cjs': 'module.exports = require("../value.cjs");\n',
    '.dependency-cruiser.cjs': 'module.exports = {};\n',
    'lint.cjs': markerScript(marker('lint'), "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); process.stdout.write('lint clean\\n');"),
    'refused.cjs': markerScript(marker('refused'), ''),
    'main.test.cjs': "require('node:test')('task test', () => {});\n",
    'codegen.cjs': markerScript(marker('codegen'), "require('node:fs').writeFileSync('generated.cjs', 'module.exports = 3;\\n');"),
    'typecheck.cjs': markerScript(marker('typecheck'), "if (require('./generated.cjs') !== 3) process.exit(2);"),
    'diff.cjs': markerScript(marker('diff'),
      "const [base, head] = process.argv.slice(2); if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head) || base === head) process.exit(3); process.stdout.write('no breaking changes\\n');"),
    'suite.cjs': markerScript(marker('suite'),
      "process.stdout.write(JSON.stringify({ numTotalTests: 3, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{ name: 'suite', status: 'passed', assertionResults: [{}, {}, {}], padding: 'p'.repeat(120000) }] }));"),
  });
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
  const gitDir = (await execute('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'])).stdout.trim();
  const control = await verifierControl(root, worktree, repository.repository, gitDir, 'refs/heads/task/root');
  const phaseAttemptId = allocatePhaseAttemptId(streamId, 'plan', 'delegate', undefined, 1);
  await events.append(streamId, { type: 'workflow.transition', data: { featureId: streamId, from: 'plan', to: 'delegate', trigger: 'fixture', phaseAttemptId } });
  const run = (connector?: VerificationHostConnector) => runWithDispatchContext(correlation(), () => handleExecuteIntent(
    { intent: 'task-completion', featureId: streamId, operationId, args }, root, {
      ...wiring(root, events), verificationProfile: { capsuleVersion: capsule.identity.capsuleVersion, profile },
      ...(connector === undefined ? {} : { verificationHost: connector }),
    }, deps));
  const leafId = (action: TaskAction) => derivedLeafOperationId(operationId, actions.indexOf(action), action);
  return {
    repo, root, events, worktree, gitDir, repository: repository.repository, streamId, operationId, profile, control, run, leafId, marker,
    observedHead: observed.head,
    async close() { await control.stop(); events.close(); await rmrfAsync(root); await rmrfAsync(repo.root); },
  };
}

const CHECKS = (resource: string) => ({
  'static-analysis': { resourceId: `${resource}-static`, profileId: `${resource}-static` },
  'contract-drift': { resourceId: `${resource}-drift`, profileId: `${resource}-drift` },
  'integration-suite': { resourceId: `${resource}-suite`, profileId: `${resource}-suite` },
  'spec-coverage': { resourceId: `${resource}-coverage`, profileId: `${resource}-coverage` },
});

it.runIf(process.platform === 'linux')('HostedGates_BoundChecksRunOnlyInVerifierAndColdReplayNeedsNoHost', async () => {
  const f = await boundFixture(['check_static_analysis', 'check_contract_drift', 'check_integration_suite']);
  try {
    f.control.setChecks(operatorChecks(f.profile, f.control));
    await f.control.start();
    const wired = await connectorFor(f.control, CHECKS('tree'), f.repo.checkout);
    const { connector, counts } = wired;
    const { replies } = wired;
    const result = await f.run(connector);
    expect(result.success, JSON.stringify({ result, replies })).toBe(true);
    expect([...f.control.requests.values()].map(request => request.operation).sort())
      .toEqual(['contract-drift', 'integration-suite', 'static-analysis']);
    for (const request of f.control.requests.values()) {
      expect(request.subject).toMatchObject({ streamId: f.streamId, operationId: f.operationId, headCommit: f.observedHead, taskId: 'root' });
    }
    expect(counts.submit).toBe(3);
    for (const action of ['check_static_analysis', 'check_contract_drift', 'check_integration_suite'] as const) {
      const leaf = await f.events.query(f.streamId, { operationId: f.leafId(action) });
      expect(leaf.map(event => event.type)).toEqual(['admission.evidence-recorded', 'gate.executed']);
      expect(canonicalJson(leaf[1]?.data)).toContain('"passed":true');
    }
    const facts = replies.flatMap(reply => 'kind' in reply || reply.response.kind !== 'evidence' || !('check' in reply.response.signed.evidence.outcome)
      ? [] : [reply.response.signed.evidence.outcome.check]);
    expect(facts.find(fact => fact.operation === 'integration-suite')).toMatchObject({
      run: { end: 'exited', exitCode: 0, stdout: '' }, report: { passed: true, totalTests: 3, loadFailureFileTotal: 0 } });
    expect(facts.find(fact => fact.operation === 'static-analysis')).toMatchObject({
      commands: [{ end: 'exited', exitCode: 0, stdout: 'lint clean\n' }],
      boundary: [{ adapter: 'dependency-cruiser', result: { status: 'PASS', cruised: 2 } }] });
    expect(facts.find(fact => fact.operation === 'contract-drift')).toMatchObject({ legs: [
      { kind: 'codegen', run: { exitCode: 0 } }, { kind: 'typecheck', run: { exitCode: 0 } },
      { kind: 'diff', run: { exitCode: 0, stdout: 'no breaking changes\n' } }] });
    for (const name of ['lint', 'codegen', 'typecheck', 'diff', 'suite']) expect(await exists(f.marker(name))).toBe(false);
    await expect(access(join(f.worktree, 'generated.cjs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await execute('git', ['-C', f.worktree, 'status', '--porcelain'])).stdout).toBe('');
    await f.control.stop();
    expect(await f.run()).toEqual(result);
    expect(counts.submit).toBe(3);
  } finally { await f.close(); }
}, 300000);

it.runIf(process.platform === 'linux')('HostedGates_NoHostWrongSubjectSignatureAndRefusedProfileNeverRunLocally', async () => {
  const legacy = await boundFixture(['check_static_analysis']);
  try {
    await legacy.run();
    expect(await exists(legacy.marker('lint'))).toBe(true);
  } finally { await legacy.close(); }

  const f = await boundFixture(['check_static_analysis']);
  try {
    f.control.setChecks(operatorChecks(f.profile, f.control));
    const wired = await connectorFor(f.control, CHECKS('tree'), f.repo.checkout);
    const unavailable = await f.run(wired.connector);
    expect(unavailable, JSON.stringify(unavailable)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(await f.run()).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(await f.events.query(f.streamId, { operationId: f.leafId('check_static_analysis') })).toEqual([]);
    await f.control.start();
    const foreignTerms = { version: 1 as const, operation: 'static-analysis' as const, resourceId: 'x', profileId: 'x',
      commandDigest: checkPlanDigest(staticAnalysisPlan(f.profile)),
      subject: { streamId: 'other', phaseAttemptId: 'p', taskId: 't', leafId: 'l', operationId: 'o', preparedDigest: 'a'.repeat(64),
        callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), profileDigest: 'e'.repeat(64),
        testSelectionDigest: 'f'.repeat(64), baseCommit: f.observedHead, headCommit: f.observedHead, blockerHeads: [] } };
    const foreign = VerificationRequest.parse({ ...foreignTerms, key: verificationKey(foreignTerms) });
    const foreignReply = signVerificationReply(foreign.key, verificationDigest(foreign), { kind: 'absent' }, f.control.signer);
    for (const delivery of ['signature', 'other-checkout', 'other-key'] as const) {
      wired.deliver(delivery, foreignReply);
      const refused = await f.run(wired.connector);
      expect(refused, `${delivery}: ${JSON.stringify(refused)}`).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
      expect(await f.events.query(f.streamId, { operationId: f.leafId('check_static_analysis') })).toEqual([]);
    }
    expect(wired.counts.submit).toBe(1);
    wired.deliver('original');
    const settled = await f.run(wired.connector);
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect(wired.counts.submit).toBe(1);
    expect(await exists(f.marker('lint'))).toBe(false);
  } finally { await f.close(); }

  const refusedProfile = await boundFixture(['check_static_analysis']);
  try {
    refusedProfile.control.setChecks(operatorChecks(refusedProfile.profile, refusedProfile.control, true));
    await refusedProfile.control.start();
    const wired = await connectorFor(refusedProfile.control, CHECKS('tree'), refusedProfile.repo.checkout);
    const refused = await refusedProfile.run(wired.connector);
    expect(canonicalJson(refused)).toContain('The verifier refused the request');
    const refusedLeaf = await refusedProfile.events.query(refusedProfile.streamId, { operationId: refusedProfile.leafId('check_static_analysis') });
    expect(refusedLeaf.map(event => event.type)).toEqual(['admission.evidence-recorded', 'gate.executed']);
    expect(canonicalJson(refusedLeaf[0]?.data)).toContain('"verdict":"indeterminate"');
    expect(await exists(refusedProfile.marker('lint'))).toBe(false);
    expect(await exists(refusedProfile.marker('refused'))).toBe(false);
  } finally { await refusedProfile.close(); }
}, 400000);

it.runIf(process.platform === 'linux')('HostedSpecCoverage_PhaseSubjectRunsDeclaredTestsWhilePlanningAndSkipRunMakeNoRequest', async () => {
  const root = makeTempDir('1928-coverage-');
  const marker = join(root, 'markers', 'coverage');
  await mkdir(dirname(marker));
  const repo = await scopedRepository({ integrationBranch: 'integration', files: {
    'module.cjs': 'module.exports = 2;\n',
    'main.test.cjs': markerScript(marker, [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('declared test', () => { assert.equal(require('./module.cjs'), 2); });",
    ].join('\n')),
  } });
  const events = new EventStore(root);
  let stopControl: (() => Promise<void>) | undefined;
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
    const profile = capsule.settlementContract.verificationProfile;
    if (profile === undefined) throw new Error('Missing pinned fixture profile');
    profile.tests.globs = { state: 'resolved', source: 'config', globs: ['**/*.test.cjs'] };
    profile.tests.probe = { ...profile.tests.probe, command: { state: 'resolved', source: 'config', argv: ['node', '--test'] },
      globs: ['**/*.test.cjs'], files: 'as-arguments', failureExitCodes: { codes: [1], source: 'config' } };
    const storeDigest = await events.bundleStore.put(encodePreparedBundle(bundle));
    await events.append(streamId, { ...prepared(bundle), data: {
      ...prepared(bundle).data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest: storeDigest }],
    } });
    const phaseAttemptId = allocatePhaseAttemptId(streamId, 'plan', 'delegate', undefined, 1);
    await events.append(streamId, { type: 'workflow.transition', data: { featureId: streamId, from: 'plan', to: 'delegate', trigger: 'fixture', phaseAttemptId } });
    const branch = (await execute('git', ['-C', repo.checkout, 'symbolic-ref', 'HEAD'])).stdout.trim();
    const control = await verifierControl(root, repo.checkout, repository.repository, repository.repository, branch);
    stopControl = control.stop;
    control.setChecks(operation => {
      const plan = specCoveragePlan(profile.tests.probe);
      return operation === 'spec-coverage' ? { ...plan, selection: { tests: ['main.test.cjs'] } } : {};
    });
    await control.start();
    const wired = await connectorFor(control, CHECKS('primary'), root);
    const coverage = (args: Record<string, unknown>, connected: boolean) => runWithDispatchContext(correlation(), async () => {
      const handler = ACTION_HANDLERS.spec_coverage_check;
      if (handler === undefined) throw new Error('Missing spec coverage action');
      return handler({ featureId: streamId, planFile, repoRoot: repo.checkout, ...args }, root, {
        ...wiring(root, events), ...(connected ? { verificationHost: wired.connector } : {}),
      });
    });
    const planning = await coverage({ coveragePhase: 'plan' }, true);
    expect(planning, JSON.stringify(planning)).toMatchObject({ success: true, data: { phase: 'plan', passed: true } });
    const skipped = await coverage({ coveragePhase: 'post-implementation', skipRun: true }, true);
    expect(skipped, JSON.stringify(skipped)).toMatchObject({ success: true, data: { passed: true } });
    expect(wired.counts).toEqual({ retrieve: 0, submit: 0 });
    const hosted = await coverage({ coveragePhase: 'post-implementation' }, true);
    expect(hosted, JSON.stringify(wired.replies)).toMatchObject({ success: true, data: { phase: 'post-implementation', passed: true } });
    expect(JSON.stringify(hosted)).toContain('Test passes: main.test.cjs');
    const [request] = [...control.requests.values()];
    expect(request).toMatchObject({ operation: 'spec-coverage', selection: { tests: ['main.test.cjs'] },
      subject: { scope: 'phase', streamId, phaseAttemptId, preparedDigest: capsuleDigest(capsule), headCommit: repo.baseCommit } });
    expect(wired.counts.submit).toBe(1);
    expect(await exists(marker)).toBe(false);
    await control.stop();
    const unconnected = await coverage({ coveragePhase: 'post-implementation' }, false);
    expect(unconnected).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(await exists(marker)).toBe(false);
    const taskSubject = { streamId, phaseAttemptId, taskId: 't', leafId: 'l', operationId: 'o', preparedDigest: 'a'.repeat(64),
      callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), profileDigest: 'e'.repeat(64),
      testSelectionDigest: 'f'.repeat(64), baseCommit: repo.baseCommit, headCommit: repo.baseCommit, blockerHeads: [] };
    expect(VerificationRequest.safeParse({ ...request, subject: taskSubject }).success).toBe(false);
    expect(VerificationRequest.safeParse({ version: 1, key: 'a'.repeat(64), resourceId: 'r', profileId: 'p', operation: 'static-analysis',
      commandDigest: 'b'.repeat(64), subject: request?.subject }).success).toBe(false);
    const evidence = wired.replies.flatMap(reply => 'kind' in reply || reply.response.kind !== 'evidence' ? [] : [reply.response.signed.evidence])[0];
    expect(VerificationEvidence.safeParse(evidence).success).toBe(true);
    const foreignFacts = { operation: 'integration-suite', report: null,
      run: { end: 'exited', exitCode: 0, stdout: '', stderr: '', outputDigest: 'a'.repeat(64) } };
    expect(VerificationEvidence.safeParse({ ...evidence, outcome: { ...evidence?.outcome, check: foreignFacts } }).success).toBe(false);
  } finally {
    await stopControl?.();
    events.close();
    await rmrfAsync(root);
    await rmrfAsync(repo.root);
  }
}, 300000);

it('VerifierBundle_ReachesOnlyReportParsersOfConfig', async () => {
  const reached = new Set<string>();
  const pending = [resolve('src/runtime/verification-host/main.ts')];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const specifier = match[1];
      if (specifier !== undefined) pending.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
    }
  }
  const config = [...reached].filter(file => file.includes('/src/config/')).map(file => file.slice(file.indexOf('/src/config/') + 12)).sort();
  expect(config).toEqual(['boundary-adapters.ts', 'exarchos-config-schema.ts', 'suite-reports.ts']);
  for (const forbidden of ['loader.ts', 'register.ts', 'load-exarchos-config.ts', 'verification-profile.ts']) expect(config).not.toContain(forbidden);
});

it.runIf(process.platform === 'linux')('HostedRuntime_RefusesUnsafeSourcesAndRunnerProfilesBeforeAnyClaim', async () => {
  const f = await boundFixture(['check_static_analysis']);
  try {
    const { control } = f;
    const linked = join(f.root, 'linked-node');
    await symlink(control.node, linked);
    await expect(copyPinnedRuntime(linked, join(f.root, 'linked-copy'), control.runnerDigest)).rejects.toThrow('Invalid pinned runtime source');
    const npmRoot = join(control.runtime, 'npm');
    await mkdir(join(npmRoot, 'bin'), { recursive: true });
    await writeFile(join(npmRoot, 'bin', 'npm-cli.js'), 'process.exit(0);\n');
    const npmEntry = join(npmRoot, 'bin', 'npm-cli.js');
    const npmDigest = await measureRuntimeClosure(npmRoot);
    const renamed = join(control.runtime, 'runner');
    await copyFile(control.node, renamed);
    await chmod(renamed, 0o500);
    await writeFile(control.hostConfig, '{}', { mode: 0o600 });
    const subject = { streamId: f.streamId, phaseAttemptId: 'p', taskId: 'root', leafId: 'l', operationId: 'o', preparedDigest: 'a'.repeat(64),
      callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), profileDigest: 'e'.repeat(64),
      testSelectionDigest: 'f'.repeat(64), baseCommit: f.repo.baseCommit, headCommit: f.observedHead, blockerHeads: [] };
    const selection = { tests: ['main.test.cjs'], sources: ['value.cjs'] };
    const authorize = (profile: Record<string, unknown>, operation: 'adequacy' | 'static-analysis', runtimePaths?: readonly string[]) => {
      const terms = operation === 'adequacy'
        ? { version: 1 as const, operation, resourceId: 'tree', profileId: 'profile', selection, subject: { ...subject, testSelectionDigest: verificationValue(selection) },
          commandDigest: verificationValue({ command: profile.command, files: profile.files }) }
        : { version: 1 as const, operation, resourceId: 'tree', profileId: 'profile', subject, commandDigest: checkPlanDigest(staticAnalysisPlan(f.profile)) };
      const request = VerificationRequest.parse({ ...terms, key: verificationKey(terms) });
      const policy = HostProvisioning.parse({ ...control.controls, ...(runtimePaths === undefined ? {} : { runtimePaths }),
        profiles: [{ id: 'profile', digest: subject.profileDigest, executable: profile.executable ?? control.node, args: profile.args ?? [], timeoutMs: 5000,
          ...(operation === 'adequacy' ? { adequacy: profile.adequacy } : { check: profile.check }) }],
        resources: [{ id: 'tree', checkout: f.worktree, repository: f.repository, gitDir: f.gitDir, branch: 'refs/heads/task/root', subject: request.subject }] });
      return authorizeVerification(policy, control.hostConfig, request);
    };
    const node = { command: ['node', '--test'], files: 'as-arguments', args: ['--test'],
      adequacy: { command: ['node', '--test'], files: 'as-arguments', selection, runnerDigest: control.runnerDigest, controlPaths: [] } };
    await expect(authorize(node, 'adequacy')).resolves.toHaveProperty('hostPolicyDigest');
    await expect(authorize({ ...node, adequacy: { ...node.adequacy, npmDigest: npmDigest } }, 'adequacy')).rejects.toThrow('Unsupported hosted adequacy runner');
    await expect(authorize({ ...node, adequacy: { ...node.adequacy, dependencyDigest: control.dependencyDigest } }, 'adequacy'))
      .rejects.toThrow('Unsupported hosted adequacy runner');
    const vitestAdequacy = { command: ['npm', 'run', 'test:files'], files: 'after-separator', selection, reporter: 'vitest',
      runnerDigest: control.runnerDigest, dependencyRoot: control.deps, dependencyDigest: control.dependencyDigest, npmRoot, npmEntry, npmDigest,
      controlPaths: ['package.json', 'tools/test-helpers/run-test-files.mjs', 'vitest.config.mjs'] };
    const vitest = { command: vitestAdequacy.command, files: vitestAdequacy.files, args: [npmEntry, 'run', 'test:files'], adequacy: vitestAdequacy };
    await expect(authorize(vitest, 'adequacy')).resolves.toHaveProperty('hostPolicyDigest');
    await expect(authorize({ ...vitest, executable: renamed }, 'adequacy')).rejects.toThrow('Unsupported hosted adequacy runner');
    const inside = join(f.worktree, 'src');
    await expect(authorize({ ...vitest, adequacy: { ...vitestAdequacy, dependencyRoot: inside } }, 'adequacy', ['/usr', control.runtime, control.deps, inside]))
      .rejects.toThrow('Adequacy dependencies require an explicitly approved canonical runtime directory');
    const check = operatorChecks(f.profile, control)('static-analysis');
    await expect(authorize({ check: { runnerDigest: control.runnerDigest, ...check } }, 'static-analysis')).resolves.toHaveProperty('hostPolicyDigest');
    await expect(authorize({ check: { runnerDigest: control.runnerDigest, ...check, dependencyRoot: inside } }, 'static-analysis',
      ['/usr', control.runtime, control.deps, inside])).rejects.toThrow('Check dependencies require a separate approved canonical runtime directory');
    await expect(authorize({ executable: renamed, check: { runnerDigest: control.runnerDigest, ...check } }, 'static-analysis'))
      .rejects.toThrow('A check runner must be the pinned node executable');
    const plan = staticAnalysisPlan(f.profile);
    await expect(authorize({ check: { runnerDigest: control.runnerDigest, ...check, legs: plan.legs } }, 'static-analysis'))
      .rejects.toThrow('An unmapped check program is refused');
    await expect(authorize({ check: { runnerDigest: control.runnerDigest, ...check, operation: 'contract-drift' } }, 'static-analysis'))
      .rejects.toThrow('Check command policy is not authorized');
    expect(await exists(f.marker('lint'))).toBe(false);
  } finally { await f.close(); }
}, 300000);
