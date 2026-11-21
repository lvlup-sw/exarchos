// @oracle-sources: the real verifier dispositions with operator authorization, Bubblewrap suite children and the private claim database, real Git merges, SQLite segment bindings read directly, and literal historical key digests computed by the build before this change
/**
 * Integration attempts bind one request before the first submit and recover it after a lost delivery, a re-entry and a restart.
 * Each case runs the real verifier dispositions in this process. The verifier authorizes the operator integration pin and runs the suite under Bubblewrap.
 * The exact host execution count is the row count of the private claim database.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import {
  VerificationRequest, checkPlanDigest, verificationDigest, verificationKey, verificationOperation, verifierSignerId,
  type HostedCheckoutIdentity, type VerificationHostConnector, type VerificationKeyTerms, type VerificationRequestTerms,
} from '../../src/contract/verification/harness-verification.js';
import { EventStore } from '../../src/events/store.js';
import { authorizeVerification } from '../../src/runtime/verification-host/authorization.js';
import { createVerificationDispositions } from '../../src/runtime/verification-host/dispositions.js';
import { HostProvisioning } from '../../src/runtime/verification-host/provisioning.js';
import { openVerifierClaimDb } from '../../src/storage/sqlite/verifier-claim-db.js';
import { integrationSuitePlan } from '../../src/verbs/gates/check-integration-suite.js';
import { IntegrationAttemptBindingV1Schema, integrationAttemptId, runIntegrationAttempt, type IntegrationAttemptTerms } from '../../src/verbs/settle/integration-attempts.js';
import type { VerificationProfile } from '../../src/workflow/verification/profile.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { nodeTestProfile } from '../helpers/verification-profile.js';

vi.mock('bun:sqlite', () => import('../../src/storage/__shims__/bun-sqlite-node.js'));

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** Run one Git command in a tree and return its trimmed output. */
async function git(tree: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', tree, ...args])).trim();
}

/**
 * A repository with two task branches, an operator policy with one head-free integration pin, a task pin and a checkout pin, and the real dispositions.
 * `attempt` runs one integration attempt with the governor event store. `restartHost` closes and opens the dispositions on the same claim database.
 * `drop` discards the next completed submit reply. `claims` counts the host claim rows.
 */
async function realHost() {
  const repo = await scopedRepository({ integrationBranch: 'integration', files: {
    'suite.cjs': "process.exit(require('node:fs').existsSync('FAIL') ? 1 : 0);\n" } });
  cleanup.push(() => rmrfAsync(repo.root));
  const treeA = await repo.worktreeFor('a', { 'a.txt': 'a\n' });
  const treeB = await repo.worktreeFor('b', { 'b.txt': 'b\n' });
  const treeC = await repo.worktreeFor('c', { 'c.txt': 'c\n' });
  const heads = { a: await git(treeA, 'rev-parse', 'HEAD'), b: await git(treeB, 'rev-parse', 'HEAD'), c: await git(treeC, 'rev-parse', 'HEAD') };
  const repository = await realpath(join(repo.checkout, '.git'));
  const root = makeTempDir('1928-integration-retry-');
  cleanup.push(() => rmrfAsync(root));
  const control = join(root, 'control');
  const state = join(control, 'state');
  const runtime = join(root, 'runtime');
  await mkdir(control, { mode: 0o700 }); await mkdir(state, { mode: 0o700 }); await mkdir(runtime);
  const node = join(runtime, 'node');
  await copyFile(await realpath(process.execPath), node); await chmod(node, 0o500);
  const runnerDigest = createHash('sha256').update(await readFile(node)).digest('hex');
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const token = 'disposable-integration-retry-fixture-token';
  const tokenPath = join(control, 'token'); const privateKeyPath = join(control, 'key'); const provisioningPath = join(control, 'host.json');
  await writeFile(tokenPath, token, { mode: 0o600 });
  await writeFile(privateKeyPath, signer.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const gitPath = await realpath((await execFileAsync('which', ['git'])).trim());
  const bwrapPath = await realpath((await execFileAsync('which', ['bwrap'])).trim());
  const profile: VerificationProfile = nodeTestProfile();
  profile.integration = { command: { state: 'resolved', source: 'config', argv: ['node', 'suite.cjs'] }, report: 'exit-code',
    failureExitCodes: { codes: [1], source: 'config' } };
  const plan = integrationSuitePlan(profile.integration);
  const gitDirOf = (tree: string) => git(tree, 'rev-parse', '--absolute-git-dir');
  const taskPin = { streamId: 's', phaseAttemptId: 'p', taskId: 'c', leafId: 'l', operationId: 'o', preparedDigest: '1'.repeat(64),
    callerDigest: '2'.repeat(64), segmentDigest: '3'.repeat(64), configDigest: '4'.repeat(64), profileDigest: contentDigest(profile),
    testSelectionDigest: '6'.repeat(64), baseCommit: repo.baseCommit, headCommit: heads.c, blockerHeads: [] };
  const policy = HostProvisioning.parse({
    version: 1, socketPath: join(control, 's'), stateDir: state, tokenPath, privateKeyPath, publicKey, bwrapPath, gitPath, runtimePaths: ['/usr', runtime],
    profiles: [{ id: 'integration', digest: contentDigest(profile), executable: node, args: [], timeoutMs: 30000,
      check: { ...plan, runnerDigest, timeoutMs: 60000, outputBytes: 4 * 1024 * 1024 } }],
    resources: [
      { id: 'integration', checkout: repo.checkout, repository, gitDir: repository, branch: 'refs/heads/integration', subject: { scope: 'integration', profileId: 'integration' } },
      { id: 'task', checkout: treeC, repository, gitDir: await gitDirOf(treeC), branch: 'refs/heads/task/c', subject: taskPin },
      { id: 'checkout', checkout: treeB, repository, gitDir: await gitDirOf(treeB), branch: 'refs/heads/task/b', subject: { scope: 'checkout', profileId: 'integration' } },
    ],
  });
  await writeFile(provisioningPath, JSON.stringify(policy), { mode: 0o600 });
  const config = { policy, token, privateKey: signer.privateKey, signerId: verifierSignerId(publicKey), provisioningPath };
  let service = createVerificationDispositions(config);
  cleanup.push(() => service.close());
  const counts = { retrieve: 0, submit: 0 };
  const order: string[] = [];
  const host = { drop: 0 };
  const stateDir = makeTempDir('1928-integration-retry-store-');
  let events = new EventStore(stateDir); await events.initialize();
  cleanup.push(async () => { events.close(); await rmrfAsync(stateDir); });
  const identity: HostedCheckoutIdentity = { resourceId: 'integration', profileId: 'integration', checkout: repo.checkout, repository,
    branch: 'refs/heads/integration', commandDigest: checkPlanDigest(plan) };
  let watched: string | undefined;
  const connector: VerificationHostConnector = { publicKey, gitPath, resourceId: 'unused', profileId: 'unused', checks: { integration: identity },
    client: {
      async retrieve(key, digest) {
        counts.retrieve += 1;
        order.push(watched !== undefined && events.getAppender().ensureSqliteBackendSync().lookupSegmentInput(watched) !== undefined ? 'retrieve-after-binding' : 'retrieve');
        return service.handle({ version: 1, token, action: 'retrieve', key, digest });
      },
      async submit(request) {
        counts.submit += 1;
        order.push('submit');
        const reply = await service.handle({ version: 1, token, action: 'submit', request });
        if (host.drop > 0) { host.drop -= 1; return { kind: 'unavailable', reason: 'The fixture discarded the completed reply' }; }
        return reply;
      },
    },
  };
  const land = async (branch: string) => { await git(repo.checkout, 'merge', '--no-edit', branch); return git(repo.checkout, 'rev-parse', 'HEAD'); };
  const terms = (outerOperationId: string, tip: string, accepted: readonly string[]): IntegrationAttemptTerms => ({
    eventStore: events, bundles: events.bundleStore, connector, identity, streamId: 'retry-stream', outerOperationId, ref: 'refs/heads/integration',
    tip, heads: [...accepted].sort(), preparedDigest: '1'.repeat(64), scope: { repository, checkout: repo.checkout, configDigest: '4'.repeat(64) }, profile });
  const attempt = async (outerOperationId: string, tip: string, accepted: readonly string[]) => {
    watched = integrationAttemptId(terms(outerOperationId, tip, accepted));
    return runIntegrationAttempt(terms(outerOperationId, tip, accepted));
  };
  const claims = (): number => {
    const db = openVerifierClaimDb(state);
    try {
      const row: unknown = db.one('SELECT COUNT(*) AS n FROM claims');
      if (typeof row !== 'object' || row === null || !('n' in row) || typeof row.n !== 'number') throw new Error('Unreadable claim count');
      return row.n;
    } finally { db.close(); }
  };
  const binding = (outerOperationId: string, tip: string, accepted: readonly string[]) =>
    events.getAppender().ensureSqliteBackendSync().lookupSegmentInput(integrationAttemptId(terms(outerOperationId, tip, accepted)));
  const restartHost = async () => { await service.close(); service = createVerificationDispositions(config); };
  const restartStore = async () => { events.close(); events = new EventStore(stateDir); await events.initialize(); };
  return { repo, heads, repository, profile, plan, policy, provisioningPath, identity, counts, order, host, land, attempt, claims, binding,
    restartHost, restartStore, bundles: () => events.bundleStore, taskPin };
}

/** The request terms of one integration subject on the integration pin, with its canonical key. */
function integrationRequest(f: Awaited<ReturnType<typeof realHost>>, subject: Partial<Extract<VerificationRequestTerms, { operation: 'integration-suite' }>['subject']>,
  resourceId = 'integration'): VerificationRequest {
  const terms: Extract<VerificationRequestTerms, { operation: 'integration-suite' }> = {
    version: 1, operation: 'integration-suite', resourceId, profileId: 'integration', commandDigest: checkPlanDigest(f.plan),
    subject: { scope: 'integration', streamId: 'retry-stream', phaseAttemptId: 'phase', outerOperationId: 'outer', ref: 'refs/heads/integration',
      headCommit: f.heads.a, preparedDigest: '1'.repeat(64), configDigest: '4'.repeat(64), profileDigest: contentDigest(f.profile), acceptedHeads: [], ...subject },
  };
  return VerificationRequest.parse({ ...terms, key: verificationKey(terms) });
}

describe('integration attempts on a real host', () => {
  /**
   * The request binds before the first exchange. A lost delivery leaves one host claim.
   * A re-entry, a duplicate and a restart of the host and of the governor store each recover the original evidence with no second execution.
   */
  it.runIf(process.platform === 'linux')('IntegrationRetry_BindingLostDeliveryReentryAndRestart_ExactExecutionCounts', async () => {
    const f = await realHost();
    const tip = await f.land('task/a');
    expect(f.binding('outer-1', tip, [f.heads.a])).toBeUndefined();
    f.host.drop = 1;
    const lost = await f.attempt('outer-1', tip, [f.heads.a]);
    expect(lost.outcome).toMatchObject({ kind: 'pending', result: { success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } } });
    expect(f.order).toEqual(['retrieve-after-binding', 'submit']);
    expect(f.claims()).toBe(1);
    const bound = f.binding('outer-1', tip, [f.heads.a]);
    const payload = IntegrationAttemptBindingV1Schema.parse(JSON.parse(bound ?? 'null'));
    const stored = VerificationRequest.parse(JSON.parse((await f.bundles().resolve(payload.request)).toString('utf8')));
    expect(stored.subject).toMatchObject({ scope: 'integration', headCommit: tip, acceptedHeads: [f.heads.a], outerOperationId: 'outer-1' });

    const reentry = await f.attempt('outer-1', tip, [f.heads.a]);
    expect(reentry.outcome.kind).toBe('passed');
    expect(f.counts).toEqual({ retrieve: 2, submit: 1 });
    expect(f.claims()).toBe(1);
    const evidence = reentry.outcome.kind === 'passed' ? reentry.outcome.evidenceDigest : '';

    const duplicates = await Promise.all([f.attempt('outer-1', tip, [f.heads.a]), f.attempt('outer-1', tip, [f.heads.a])]);
    expect(duplicates.map(result => result.outcome)).toEqual([reentry.outcome, reentry.outcome]);
    expect(f.counts.submit).toBe(1);
    expect(f.claims()).toBe(1);

    await f.restartHost(); await f.restartStore();
    const restarted = await f.attempt('outer-1', tip, [f.heads.a]);
    expect(restarted.outcome).toEqual({ kind: 'passed', attemptBinding: integrationAttemptId({ outerOperationId: 'outer-1', ref: 'refs/heads/integration',
      tip, heads: [f.heads.a], profile: f.profile }), evidenceDigest: evidence });
    expect(f.counts.submit).toBe(1);
    expect(f.claims()).toBe(1);
    expect(f.binding('outer-1', tip, [f.heads.a])).toBe(bound);
  }, 240000);

  /**
   * Two tips in one phase attempt each claim exactly once. The completed old request returns its original evidence.
   * A new request for the old tip cannot authorize after the head moved, so it runs nothing.
   */
  it.runIf(process.platform === 'linux')('IntegrationRetry_TwoTipsInOnePhaseAttempt_EachClaimsExactlyOnce', async () => {
    const f = await realHost();
    const first = await f.land('task/a');
    const one = await f.attempt('outer-1', first, [f.heads.a]);
    expect(one.outcome.kind).toBe('passed');
    const second = await f.land('task/b');
    const two = await f.attempt('outer-1', second, [f.heads.a, f.heads.b]);
    expect(two.outcome.kind).toBe('passed');
    expect(f.claims()).toBe(2);
    expect(f.counts.submit).toBe(2);
    const stored = async (tip: string, accepted: readonly string[]) => {
      const payload = IntegrationAttemptBindingV1Schema.parse(JSON.parse(f.binding('outer-1', tip, accepted) ?? 'null'));
      return VerificationRequest.parse(JSON.parse((await f.bundles().resolve(payload.request)).toString('utf8')));
    };
    const earlier = await stored(first, [f.heads.a]);
    const later = await stored(second, [f.heads.a, f.heads.b]);
    expect(later.subject).toMatchObject({ phaseAttemptId: earlier.subject.phaseAttemptId, headCommit: second });
    expect(earlier.subject).toMatchObject({ headCommit: first });
    expect(verificationOperation(earlier)).not.toBe(verificationOperation(later));
    const original = await f.attempt('outer-1', first, [f.heads.a]);
    expect(original.outcome).toEqual(one.outcome);
    expect(f.claims()).toBe(2);
    const stale = await f.attempt('outer-2', first, [f.heads.a]);
    expect(stale.outcome).toMatchObject({ kind: 'refused', result: { error: { code: 'HOSTED_VERIFICATION_REFUSED' } } });
    expect(f.claims()).toBe(2);
  }, 240000);

  /** The verifier admits an integration subject only on its pin, for the pinned branch, the operator profile, the observed tip and merged heads. */
  it.runIf(process.platform === 'linux')('IntegrationRetry_HostAuthorization_AdmitsOnlyThePinnedIntegrationSubject', async () => {
    const f = await realHost();
    const tip = await f.land('task/a');
    const authorize = (request: VerificationRequest) => authorizeVerification(f.policy, f.provisioningPath, request);
    await expect(authorize(integrationRequest(f, { headCommit: tip, acceptedHeads: [f.heads.a] }))).resolves.toHaveProperty('hostPolicyDigest');
    const refused = [
      integrationRequest(f, { headCommit: tip, ref: 'refs/heads/main' }),
      integrationRequest(f, { headCommit: tip, profileDigest: '9'.repeat(64) }),
      integrationRequest(f, { headCommit: f.repo.baseCommit }),
      integrationRequest(f, { headCommit: tip, acceptedHeads: [f.heads.a, f.heads.b].sort() }),
      integrationRequest(f, { headCommit: f.heads.c }, 'task'),
      integrationRequest(f, { headCommit: f.heads.b }, 'checkout'),
    ];
    for (const request of refused) await expect(authorize(request), JSON.stringify(request.subject)).rejects.toThrow();
    const taskTerms: Extract<VerificationRequestTerms, { operation: 'integration-suite' }> = { version: 1, operation: 'integration-suite',
      resourceId: 'integration', profileId: 'integration', commandDigest: checkPlanDigest(f.plan), subject: { ...f.taskPin, headCommit: tip } };
    await expect(authorize(VerificationRequest.parse({ ...taskTerms, key: verificationKey(taskTerms) }))).rejects.toThrow('operator policy');
    const onTaskPin = { ...taskTerms, resourceId: 'task', subject: f.taskPin };
    await expect(authorize(VerificationRequest.parse({ ...onTaskPin, key: verificationKey(onTaskPin) }))).resolves.toHaveProperty('hostPolicyDigest');
    const lifecycle: Extract<VerificationRequestTerms, { operation: 'lifecycle' }> = { version: 1, operation: 'lifecycle', resourceId: 'integration',
      profileId: 'integration', commandDigest: checkPlanDigest(f.plan), subject: { scope: 'checkout', headCommit: tip } };
    await expect(authorize(VerificationRequest.parse({ ...lifecycle, key: verificationKey(lifecycle) }))).rejects.toThrow('operator policy');
  }, 240000);
});

describe('verifier key stability', () => {
  const d = (c: string, n: number) => c.repeat(n);
  const taskSubject = { streamId: 's', phaseAttemptId: 'p', taskId: 't', leafId: 'l', operationId: 'o',
    preparedDigest: d('1', 64), callerDigest: d('2', 64), segmentDigest: d('3', 64), configDigest: d('4', 64), profileDigest: d('5', 64),
    testSelectionDigest: d('6', 64), baseCommit: d('a', 40), headCommit: d('b', 40), blockerHeads: [d('c', 40)] };
  const historical: Record<string, { readonly terms: VerificationKeyTerms & Record<string, unknown>; readonly operation: string; readonly key: string; readonly digest: string }> = {
    task: { terms: { version: 1, operation: 'integration-suite', resourceId: 'r', profileId: 'p', commandDigest: d('c', 64), subject: taskSubject },
      operation: '9aa90a78e0645adf1801be4638328599cd78563a811d59a6225e880d60e325ec',
      key: 'f23af71982a852fac492a33bcbbad3bb4a4a009985dd08cb539e0a99dffe98f8',
      digest: 'ed029508e16fd76b086c615d883f67ff1b1b9d0d32176f8ec10bfa11bb55fe3f' },
    probe: { terms: { version: 1, operation: 'probe', resourceId: 'r', profileId: 'p', subject: taskSubject },
      operation: '2817e3fc3cf5aabe0fd0f1507acff362c72febd434255a3856938ae30ea03c87',
      key: '0ef4248ad3533bd8f98cd4ba7acacd53142b08b588a21ccd9fe6df7ad0e9794e',
      digest: 'b4117acbb6003613ead1c48a2e796aecff96a06f6f569f008dd3559c341fbaac' },
    phase: { terms: { version: 1, operation: 'spec-coverage', resourceId: 'r', profileId: 'p', commandDigest: d('c', 64), selection: { tests: ['tests/a.test.ts'] },
      subject: { scope: 'phase', streamId: 's', phaseAttemptId: 'p', preparedDigest: d('1', 64), configDigest: d('4', 64), profileDigest: d('5', 64),
        testSelectionDigest: d('6', 64), headCommit: d('b', 40) } },
      operation: 'a62a76671d8ca3e48a77c413b100a2ae16371bbf0af5c30349b5ab71e2a99b84',
      key: 'ce2d446d496f6c5d4a9c1275ea47618085de658a36d39fdbe495e4646e217e03',
      digest: 'ccddad457e2d85122b1d1bdef650019a75f149ddb1952ee558886d8cafd7d96e' },
    checkout: { terms: { version: 1, operation: 'lifecycle', resourceId: 'r', profileId: 'p', commandDigest: d('c', 64), subject: { scope: 'checkout', headCommit: d('b', 40) } },
      operation: '15d56deef394a52a0815c9b76ebf97da85cc739c27fc5eddb9dbc582a41608e3',
      key: '2f4f0517bdce30a8efad4a24c47296e0c2df1b73f1bd44df05a981947b821e2b',
      digest: 'b026e9864e54a17fffa19f98f5db4ae0efae385ab1fb78555470a7c9609783f5' },
  };

  /** The task, probe, phase and checkout identities, keys and request digests keep the bytes of the build before the integration subject. */
  it('IntegrationRetry_HistoricalTaskPhaseAndCheckoutKeys_KeepTheirBytes', () => {
    for (const [name, entry] of Object.entries(historical)) {
      const key = verificationKey(entry.terms);
      expect(verificationOperation(entry.terms), name).toBe(entry.operation);
      expect(key, name).toBe(entry.key);
      expect(verificationDigest(VerificationRequest.parse({ ...entry.terms, key })), name).toBe(entry.digest);
    }
  });

  /** An integration key binds each subject field, the resource and the command. Another tip or resource gives another operation and key. */
  it('IntegrationRetry_IntegrationKeyBindsEverySubjectFieldResourceAndCommand', () => {
    const subject: Extract<VerificationKeyTerms['subject'], { scope: 'integration' }> = { scope: 'integration', streamId: 's', phaseAttemptId: 'p', outerOperationId: 'o', ref: 'refs/heads/integration',
      headCommit: d('b', 40), preparedDigest: d('1', 64), configDigest: d('4', 64), profileDigest: d('5', 64), acceptedHeads: [d('a', 40)] };
    const base: VerificationKeyTerms = { operation: 'integration-suite', resourceId: 'r', commandDigest: d('c', 64), subject };
    const variants: VerificationKeyTerms[] = [
      { ...base, subject: { ...subject, headCommit: d('d', 40) } }, { ...base, subject: { ...subject, acceptedHeads: [] } },
      { ...base, subject: { ...subject, outerOperationId: 'other' } }, { ...base, subject: { ...subject, phaseAttemptId: 'q' } },
      { ...base, resourceId: 'other' }, { ...base, commandDigest: d('e', 64) },
    ];
    const operations = new Set([base, ...variants].map(terms => verificationOperation(terms)));
    const keys = new Set([base, ...variants].map(terms => verificationKey(terms)));
    expect(operations.size).toBe(variants.length + 1);
    expect(keys.size).toBe(variants.length + 1);
    expect(() => verificationKey({ operation: 'integration-suite', subject })).toThrow('binds its resource and command');
  });

  /** The integration subject binds at most 64 accepted heads, sorted and unique. A longer, unsorted or repeated list refuses. */
  it('IntegrationRetry_IntegrationSubjectBindsAtMost64SortedUniqueHeads', () => {
    const heads = (count: number) => Array.from({ length: count }, (_, index) => index.toString(16).padStart(40, '0'));
    const request = (acceptedHeads: readonly string[]) => {
      const terms: Extract<VerificationRequestTerms, { operation: 'integration-suite' }> = { version: 1, operation: 'integration-suite', resourceId: 'r',
        profileId: 'p', commandDigest: d('c', 64), subject: { scope: 'integration', streamId: 's', phaseAttemptId: 'p', outerOperationId: 'o',
          ref: 'refs/heads/integration', headCommit: d('b', 40), preparedDigest: d('1', 64), configDigest: d('4', 64), profileDigest: d('5', 64),
          acceptedHeads: [...acceptedHeads] } };
      return VerificationRequest.safeParse({ ...terms, key: verificationKey(terms) }).success;
    };
    expect(request(heads(64))).toBe(true);
    expect(request(heads(65))).toBe(false);
    expect(request([d('b', 40), d('a', 40)])).toBe(false);
    expect(request([d('a', 40), d('a', 40)])).toBe(false);
  });
});
