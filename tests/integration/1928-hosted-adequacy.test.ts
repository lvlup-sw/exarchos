// @oracle-sources: actual executor, prepared custody, SQLite binding and signed verifier transport
/** Hosted evidence uses only the immutable winning task segment. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { capsuleDigest, contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { ContentDigestV1Schema } from '../../src/workflow/admission/types.js';
import { canonicalJson, requestDigest } from '../../src/contract/request-context.js';
import {
  VerificationRequest, signVerification, signVerificationReply, verificationValueDigest,
  type VerificationReply,
} from '../../src/contract/verification/harness-verification.js';
import { createVerifierClient } from '../../src/dispatch/core/verifier-client.js';
import { runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../src/events/store.js';
import { observeRepository, observeTree } from '../../src/utils/git-tree.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import { allocatePhaseAttemptId } from '../../src/workflow/phase-attempt-id.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { handleExecuteIntent, productionExecuteDeps, derivedLeafOperationId } from '../../src/verbs/execute/executor.js';
import { SegmentInputBindingV1Schema } from '../../src/verbs/execute/run-bundle.js';
import { settlementClaimKey, verificationOperationId } from '../../src/verbs/settle/settlement-reads.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { fixtureRunbook, fixtureStep, fixtureWiring, fixtureCorrelation } from '../unit/verbs/execute/fixtures.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const execute = promisify(execFile);

/** Start the compiled verifier and observe its readiness before any connector request. */
async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Verifier readiness deadline')), 10000);
    let diagnostic = '';
    child.stderr?.on('data', bytes => { diagnostic += String(bytes); });
    child.once('close', code => { clearTimeout(deadline); reject(new Error(`Verifier exited ${code}: ${diagnostic}`)); });
    let output = '';
    child.stdout?.on('data', bytes => {
      output += String(bytes);
      if (output.includes('VERIFIER_READY')) { clearTimeout(deadline); resolve(); }
    });
  });
}

/** Use real preparation, a compiled verifier and the immutable bound executor. */
async function runBoundAdequacyFixture(
  scenario: 'recover-lost-reply' | 'reenter-after-execution' | 'reenter-before-execution',
): Promise<void> {
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'module.cjs': 'module.exports = 1;' } });
  const root = makeTempDir('1928-bound-');
  const events = new EventStore(root);
  let host: ChildProcess | undefined;
  try {
    await events.initialize();
    const worktree = await repo.worktreeFor('root', { 'module.cjs': 'module.exports = 2;', 'main.test.cjs': [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('fixture assertion', () => { process.stdout.write('fixture {counts:1}\\n'); assert.equal(require('./module.cjs'), 2); });",
    ].join('\n') });
    const repository = await observeRepository(worktree);
    const observed = await observeTree(worktree);
    if (repository.kind !== 'repository' || observed.kind !== 'tree' || observed.head === undefined) throw new Error('Missing fixture Git coordinates');
    const text = textOf([task('root', { riskTier: 'high', testLayer: 'integration', files: ['module.cjs', 'main.test.cjs'], testFiles: ['main.test.cjs'] })]);
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
      taskVerification: { root: { riskTier: 'high', boundaryTouching: false, baseRef: 'main', baseCommit: repo.baseCommit } } };
    const profile = capsule.settlementContract.verificationProfile;
    if (profile === undefined) throw new Error('Missing pinned fixture profile');
    profile.tests.globs = { state: 'resolved', source: 'config', globs: ['**/*.test.cjs'] };
    profile.tests.probe = { ...profile.tests.probe, command: { state: 'resolved', source: 'config', argv: ['node', '--test'] },
      globs: ['**/*.test.cjs'], files: 'as-arguments' };
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
    const args = { taskId: 'root', worktreePath: worktree, branch: 'task/root', baseRef: 'main', riskTier: 'high', boundaryTouching: false,
      capsuleVersion: capsule.identity.capsuleVersion, result: { passed: true } };
    const callerDigest = requestDigest(args);
    const signer = generateKeyPairSync('ed25519');
    const publicKey = signer.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const token = 'disposable-governance-fixture-token';
    const control = join(root, 'control');
    const hostState = join(control, 'state');
    const runtime = join(root, 'runtime');
    await mkdir(control, { mode: 0o700 });
    await mkdir(hostState, { mode: 0o700 });
    await mkdir(runtime);
    const node = join(runtime, 'node');
    await copyFile(await realpath(process.execPath), node);
    await chmod(node, 0o500);
    const runnerDigest = createHash('sha256').update(await readFile(node)).digest('hex');
    const socketPath = join(control, 's');
    const tokenPath = join(control, 'token');
    const privateKeyPath = join(control, 'key');
    const connection = join(control, 'client.json');
    await writeFile(tokenPath, token, { mode: 0o600 });
    await writeFile(privateKeyPath, signer.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await writeFile(connection, JSON.stringify({ version: 1, socketPath, tokenPath, publicKey }), { mode: 0o600 });
    const gitPath = await realpath((await execute('which', ['git'])).stdout.trim());
    const bwrapPath = await realpath((await execute('which', ['bwrap'])).stdout.trim());
    const gitDir = (await execute(gitPath, ['-C', worktree, 'rev-parse', '--absolute-git-dir'])).stdout.trim();
    const marker = join(root, 'fsmonitor-called');
    const hook = join(root, 'fsmonitor.cjs');
    await writeFile(hook, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n'); process.stdout.write('token\\0/\\0');`);
    await execute(gitPath, ['-C', worktree, 'config', 'core.fsmonitor', `"${process.execPath}" "${hook}"`]);
    await execute(gitPath, ['-C', worktree, 'status', '--porcelain']);
    expect(await readFile(marker, 'utf8')).toContain('called');
    await rm(marker);
    const out = join(root, 'binary');
    await execute('bun', ['run', 'tools/release/build-binary.ts', '--component=verifier', '--outdir', out], { timeout: 180000 });
    const binary = join(out, `exarchos-verifier-linux-${process.arch}`);
    const hostConfig = join(control, 'host.json');
    let original: VerificationRequest | undefined;
    let terminal: VerificationReply | undefined;
    let submissions = 0;
    let lookups = 0;
    let delivery: 'original' | 'invalid-signature' | 'other-checkout' = 'original';
    const client = {
      retrieve: async (key: string, digest: string) => {
        lookups++;
        if (scenario === 'reenter-before-execution' && lookups === 1) {
          return { kind: 'unavailable' as const, reason: 'Fixture interrupted before host admission' };
        }
        if (host === undefined) {
          return signVerificationReply(key, digest, { kind: 'absent' }, signer.privateKey);
        }
        if (delivery !== 'original' && terminal?.response.kind === 'evidence') {
          const signed = terminal.response.signed;
          const refused = delivery === 'invalid-signature'
            ? { ...signed, signature: 'A'.repeat(86) + '==' }
            : signVerification({ ...signed.evidence,
              resources: signed.evidence.resources.map(resource => resource.path === worktree ? { ...resource, path: repo.checkout } : resource),
            }, signer.privateKey);
          return signVerificationReply(key, digest, { kind: 'evidence', signed: refused }, signer.privateKey);
        }
        return (await createVerifierClient(connection)).retrieve(key, digest);
      },
      submit: async (request: VerificationRequest) => {
        submissions++;
        original = request;
        if (request.operation !== 'adequacy') throw new Error('Expected closed adequacy request');
        await writeFile(hostConfig, JSON.stringify({
          version: 1, socketPath, stateDir: hostState, tokenPath, privateKeyPath, publicKey, bwrapPath, gitPath,
          runtimePaths: ['/usr', runtime],
          profiles: [{ id: 'node', digest: request.subject.profileDigest, executable: node, args: ['--test'],
            timeoutMs: 5000, adequacy: { command: ['node', '--test'], files: 'as-arguments', selection: request.selection, runnerDigest, controlPaths: [] } }],
          resources: [{ id: 'tree', checkout: worktree, repository: repository.repository, gitDir,
            branch: 'refs/heads/task/root', subject: request.subject }],
        }), { mode: 0o600 });
        host = spawn(binary, ['--config', hostConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
        await ready(host);
        const reply = await (await createVerifierClient(connection)).submit(request);
        if ('kind' in reply || reply.response.kind !== 'evidence') throw new Error(`Expected real signed completion: ${JSON.stringify(reply)}`);
        terminal = reply;
        return { kind: 'unavailable' as const, reason: 'Fixture discarded the completed delivery' };
      },
    };
    const deps = { ...productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'),
      runbookTable: [fixtureRunbook('task-completion', [fixtureStep('check_test_adequacy', 'stop', {
        repoRoot: 'auto', worktreePath: '<worktreePath>', baseBranch: '<baseRef>',
      })])],
      verificationInput: { authority, round: 0 as const, outerOperationId: outer, batchId: 'batch', callerDigest, coordinate },
    };
    const run = (connected: boolean) => runWithDispatchContext(fixtureCorrelation(), () => handleExecuteIntent(
      { intent: 'task-completion', featureId: streamId, operationId, args }, root, {
        ...fixtureWiring(root, events), verificationProfile: { capsuleVersion: capsule.identity.capsuleVersion, profile },
        ...(connected ? { verificationHost: { client, publicKey, gitPath, profileId: 'node', resourceId: 'tree' } } : {}),
      }, deps));
    const backend = events.getAppender().ensureSqliteBackendSync();
    const phaseAttemptId = allocatePhaseAttemptId(streamId, 'plan', 'delegate', undefined, 1);
    await events.append(streamId, {
      type: 'workflow.transition', data: { featureId: streamId, from: 'plan', to: 'delegate', trigger: 'fixture', phaseAttemptId },
    });
    const interrupted = await run(true);
    expect(interrupted, JSON.stringify(interrupted)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(backend.lookupOperationClaim(operationId)).toBeUndefined();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const bound = backend.lookupSegmentInput(operationId);
    const binding = SegmentInputBindingV1Schema.parse(JSON.parse(bound ?? 'null'));
    const leafId = derivedLeafOperationId(operationId, 0, 'check_test_adequacy');
    const requestBindingKey = 'hosted-request:' + verificationValueDigest({ operationId, leafId });
    const requestBinding = backend.lookupSegmentInput(requestBindingKey);
    const requestRef = z.object({ version: z.literal(1), digest: ContentDigestV1Schema }).strict()
      .parse(JSON.parse(requestBinding ?? 'null'));
    const request = VerificationRequest.parse(JSON.parse((await events.bundleStore.resolve(requestRef.digest)).toString('utf8')));
    expect(request.subject).toMatchObject({ operationId, leafId, phaseAttemptId, segmentDigest: binding.inputDigest.value });
    expect(await events.query(streamId, { operationId: leafId })).toEqual([]);
    if (scenario === 'reenter-before-execution') {
      expect(original).toBeUndefined();
      expect(host).toBeUndefined();
      expect(lookups).toBe(1);
      expect(submissions).toBe(0);
    } else {
      expect(original).toMatchObject({ operation: 'adequacy', selection: { tests: ['main.test.cjs'], sources: ['module.cjs'] }, subject: {
        preparedDigest: capsuleDigest(capsule), segmentDigest: binding.inputDigest.value, callerDigest: binding.callerDigest.value,
        leafId, operationId, configDigest: 'c'.repeat(64), profileDigest: contentDigest(profile), headCommit: observed.head,
      } });
      expect(terminal?.response).toMatchObject({ kind: 'evidence', signed: { evidence: { outcome: { status: 'passed' } } } });
    }
    if (scenario !== 'recover-lost-reply') {
      const firstSubmissions = submissions;
      const firstLookups = lookups;
      const review = allocatePhaseAttemptId(streamId, 'delegate', 'review', phaseAttemptId, 1);
      const delegate = allocatePhaseAttemptId(streamId, 'review', 'delegate', review, 1);
      expect(delegate).not.toBe(phaseAttemptId);
      for (const [from, to, phaseAttemptId] of [['delegate', 'review', review], ['review', 'delegate', delegate]]) {
        await events.append(streamId, { type: 'workflow.transition', data: { featureId: streamId, from, to, trigger: 'fixture', phaseAttemptId } });
      }
      const retry = await run(true);
      expect(retry, JSON.stringify(retry)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
      expect(lookups).toBe(firstLookups);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(submissions).toBe(firstSubmissions);
      expect(backend.lookupSegmentInput(operationId)).toBe(bound);
      expect(backend.lookupSegmentInput(requestBindingKey)).toBe(requestBinding);
      expect(backend.lookupOperationClaim(operationId)).toBeUndefined();
      expect(await events.query(streamId, { operationId: leafId })).toEqual([]);
      return;
    }
    const lookupsBeforeDisconnect = lookups;
    expect(await run(false)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(await events.query(streamId, { operationId: leafId })).toEqual([]);
    expect(backend.lookupOperationClaim(operationId)).toBeUndefined();
    expect(backend.lookupSegmentInput(operationId)).toBe(bound);
    expect(backend.lookupSegmentInput(requestBindingKey)).toBe(requestBinding);
    expect(lookups).toBe(lookupsBeforeDisconnect);
    expect(submissions).toBe(1);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const inadmissible of ['invalid-signature', 'other-checkout'] satisfies (typeof delivery)[]) {
      delivery = inadmissible;
      expect(await run(true)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
      expect(await events.query(streamId, { operationId: leafId })).toEqual([]);
      expect(backend.lookupOperationClaim(operationId)).toBeUndefined();
    }
    delivery = 'original';
    const settled = await run(true);
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect(submissions).toBe(1);
    expect(backend.lookupSegmentInput(operationId)).toBe(bound);
    const leaf = await events.query(streamId, { operationId: leafId });
    expect(leaf.map(event => event.type)).toEqual(['admission.evidence-recorded', 'gate.executed']);
    expect(canonicalJson(leaf[0]?.data)).toContain('report');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await rmrfAsync(worktree);
    expect(await run(false)).toEqual(settled);
    expect(submissions).toBe(1);
  } finally {
    if (host?.exitCode === null && host.signalCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
    events.close();
    await rmrfAsync(root);
    await rmrfAsync(repo.root);
  }
}

it.runIf(process.platform === 'linux')('BoundAdequacy_LostSignedDeliveryRetainsOriginalAndColdReplays',
  () => runBoundAdequacyFixture('recover-lost-reply'), 200000);

it.runIf(process.platform === 'linux')('BoundAdequacy_ReenteredPhaseCannotReplaceOriginalHostedRequest',
  async () => {
    await runBoundAdequacyFixture('reenter-after-execution');
    await runBoundAdequacyFixture('reenter-before-execution');
  }, 200000);
