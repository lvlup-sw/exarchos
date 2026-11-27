// @oracle-sources: the local check executor that runs the suite in the integration checkout, real Git merges, SQLite segment bindings read directly, a suite log outside the checkout, and literal historical key digests computed by the build before this change
/**
 * Integration attempts bind one request before the executor runs, then run the suite in the local check executor.
 * Each case runs the real executor in this process, in the integration checkout of a prepared scope. The suite appends the tip that it sees to a log.
 * A stop before the claim and a stop after the suite leg each leave the attempt retryable. A retry runs once more and a later call replays.
 */
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capsuleDigest, contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import {
  VerificationRequest, verificationDigest, verificationKey, verificationOperation,
  type VerificationKeyTerms, type VerificationRequestTerms,
} from '../../src/contract/verification/harness-verification.js';
import { EventStore } from '../../src/events/store.js';
import { HostedAdequacyPending } from '../../src/verbs/gates/gate-runner.js';
import {
  IntegrationAttemptBindingV1Schema, IntegrationAttemptRequestV1Schema, integrationAttemptId, runIntegrationAttempt, type IntegrationAttemptTerms,
} from '../../src/verbs/settle/integration-attempts.js';
import { runApprovedCheck, type CheckExecutor } from '../../src/verbs/verification/check-executor.js';
import type { VerificationProfile } from '../../src/workflow/verification/profile.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { runAsTrustedCaller } from '../../tools/test-helpers/trusted-context.js';
import { fixture as preparedFixture, prepared } from '../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { nodeTestProfile } from '../helpers/verification-profile.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** Run one Git command in a tree and return its trimmed output. */
async function git(tree: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', tree, ...args])).trim();
}

/** An executor that stops each attempt before its claim, as a crash before the binding does. */
const stopBeforeClaim: CheckExecutor = async () => { throw new HostedAdequacyPending('The fixture stopped the attempt before its claim'); };

/** An executor that runs the real attempt and stops it after its suite leg, as a crash before the terminal observation does. */
const stopAfterSuite: CheckExecutor = (request, body) => runApprovedCheck(request, async (session) => {
  await body(session);
  throw new HostedAdequacyPending('The fixture stopped the attempt after its suite leg');
});

/**
 * A repository with three task branches, a prepared scope that names the integration checkout, and a suite that logs the tip that it sees.
 * `attempt` runs one integration attempt with the governor event store. `restartStore` closes and opens the store.
 */
async function localAttempts() {
  const root = makeTempDir('1928-integration-retry-');
  cleanup.push(() => rmrfAsync(root));
  const log = join(root, 'suite.log');
  const repo = await scopedRepository({ integrationBranch: 'integration', files: {
    'suite.cjs': `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })); process.exit(fs.existsSync('FAIL') ? 1 : 0);\n` } });
  cleanup.push(() => rmrfAsync(repo.root));
  const treeA = await repo.worktreeFor('a', { 'a.txt': 'a\n' });
  const treeB = await repo.worktreeFor('b', { 'b.txt': 'b\n' });
  const treeC = await repo.worktreeFor('c', { 'c.txt': 'c\n' });
  const heads = { a: await git(treeA, 'rev-parse', 'HEAD'), b: await git(treeB, 'rev-parse', 'HEAD'), c: await git(treeC, 'rev-parse', 'HEAD') };
  const repository = await realpath(join(repo.checkout, '.git'));
  const profile: VerificationProfile = nodeTestProfile();
  profile.integration = { command: { state: 'resolved', source: 'config', argv: ['node', 'suite.cjs'] }, report: 'exit-code',
    failureExitCodes: { codes: [1], source: 'config' } };
  const bundle = preparedFixture();
  const scope = { repository, checkout: repo.checkout, configDigest: '4'.repeat(64) };
  bundle.capsule.settlementContract = { ...bundle.capsule.settlementContract, scope };
  const streamId = bundle.capsule.identity.workflowId;
  const stateDir = makeTempDir('1928-integration-retry-store-');
  let events = new EventStore(stateDir); await events.initialize();
  cleanup.push(async () => { events.close(); await rmrfAsync(stateDir); });
  const storeDigest = await events.bundleStore.put(encodePreparedBundle(bundle));
  await events.append(streamId, { ...prepared(bundle), data: {
    ...prepared(bundle).data, capsuleDigest: capsuleDigest(bundle.capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest: storeDigest }],
  } });
  const land = async (branch: string) => { await git(repo.checkout, 'merge', '--no-edit', branch); return git(repo.checkout, 'rev-parse', 'HEAD'); };
  const terms = (outerOperationId: string, tip: string, accepted: readonly string[], extra: Partial<IntegrationAttemptTerms> = {}): IntegrationAttemptTerms => ({
    eventStore: events, bundles: events.bundleStore, streamId, outerOperationId, ref: 'refs/heads/integration',
    tip, heads: [...accepted].sort(), preparedDigest: '1'.repeat(64), scope, profile, ...extra });
  const attempt = (outerOperationId: string, tip: string, accepted: readonly string[], extra: Partial<IntegrationAttemptTerms> = {}) =>
    runAsTrustedCaller(stateDir, () => runIntegrationAttempt(terms(outerOperationId, tip, accepted, extra)));
  const suiteTips = async (): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const binding = (outerOperationId: string, tip: string, accepted: readonly string[]) =>
    events.getAppender().ensureSqliteBackendSync().lookupSegmentInput(integrationAttemptId(terms(outerOperationId, tip, accepted)));
  const restartStore = async () => { events.close(); events = new EventStore(stateDir); await events.initialize(); };
  return { repo, heads, repository, profile, scope, trees: { a: treeA, b: treeB, c: treeC }, land, attempt, suiteTips, binding, restartStore,
    bundles: () => events.bundleStore };
}

describe('integration attempts in the local executor', () => {
  /**
   * The request binds before the executor runs. A stop before the claim runs no suite. A stop after the suite leg leaves the claimed attempt incomplete.
   * The retry runs the suite once more. A re-entry, a duplicate and a restart of the store each replay the stored observation with no run.
   */
  it('IntegrationRetry_CrashesBeforeAndAfterBinding_RunOnceMoreThenReplay', async () => {
    const f = await localAttempts();
    const tip = await f.land('task/a');
    expect(f.binding('outer-1', tip, [f.heads.a])).toBeUndefined();
    const before = await f.attempt('outer-1', tip, [f.heads.a], { executor: stopBeforeClaim });
    expect(before.outcome).toMatchObject({ kind: 'pending', result: { success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } } });
    expect(await f.suiteTips()).toEqual([]);
    const bound = f.binding('outer-1', tip, [f.heads.a]);
    const payload = IntegrationAttemptBindingV1Schema.parse(JSON.parse(bound ?? 'null'));
    const stored = IntegrationAttemptRequestV1Schema.parse(JSON.parse((await f.bundles().resolve(payload.request)).toString('utf8')));
    expect(stored).toMatchObject({ tip, acceptedHeads: [f.heads.a], outerOperationId: 'outer-1', checkout: f.scope.checkout,
      repository: f.repository, profileDigest: contentDigest(f.profile) });

    const after = await f.attempt('outer-1', tip, [f.heads.a], { executor: stopAfterSuite });
    expect(after.outcome).toMatchObject({ kind: 'pending', result: { success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } } });
    expect(await f.suiteTips()).toEqual([tip]);

    const reentry = await f.attempt('outer-1', tip, [f.heads.a]);
    expect(reentry.outcome.kind).toBe('passed');
    expect(await f.suiteTips()).toEqual([tip, tip]);
    const evidence = reentry.outcome.kind === 'passed' ? reentry.outcome.evidenceDigest : '';
    expect(evidence).toMatch(/^[a-f0-9]{64}$/);

    const duplicate = await f.attempt('outer-1', tip, [f.heads.a]);
    expect(duplicate.outcome).toEqual(reentry.outcome);
    await f.restartStore();
    const restarted = await f.attempt('outer-1', tip, [f.heads.a]);
    expect(restarted.outcome).toEqual({ kind: 'passed', attemptBinding: integrationAttemptId({ outerOperationId: 'outer-1', ref: 'refs/heads/integration',
      tip, heads: [f.heads.a], profile: f.profile }), evidenceDigest: evidence });
    expect(await f.suiteTips()).toEqual([tip, tip]);
    expect(f.binding('outer-1', tip, [f.heads.a])).toBe(bound);
  }, 120000);

  /**
   * Two tips in one phase attempt each run the suite exactly once. A moved tip needs a fresh attempt.
   * The attempt of the old tip refuses in the executor, because the checkout no longer holds that tip. A new attempt for the old tip refuses too.
   * Neither runs the suite.
   */
  it('IntegrationRetry_TwoTipsInOnePhaseAttempt_EachClaimsExactlyOnce', async () => {
    const f = await localAttempts();
    const first = await f.land('task/a');
    const one = await f.attempt('outer-1', first, [f.heads.a]);
    expect(one.outcome.kind).toBe('passed');
    const second = await f.land('task/b');
    const two = await f.attempt('outer-1', second, [f.heads.a, f.heads.b]);
    expect(two.outcome.kind).toBe('passed');
    expect(await f.suiteTips()).toEqual([first, second]);
    const stored = async (tip: string, accepted: readonly string[]) => {
      const payload = IntegrationAttemptBindingV1Schema.parse(JSON.parse(f.binding('outer-1', tip, accepted) ?? 'null'));
      return IntegrationAttemptRequestV1Schema.parse(JSON.parse((await f.bundles().resolve(payload.request)).toString('utf8')));
    };
    const earlier = await stored(first, [f.heads.a]);
    const later = await stored(second, [f.heads.a, f.heads.b]);
    expect(later).toMatchObject({ phaseAttemptId: earlier.phaseAttemptId, tip: second });
    expect(earlier).toMatchObject({ tip: first });
    const original = await f.attempt('outer-1', first, [f.heads.a]);
    expect(original.outcome).toMatchObject({ kind: 'refused', result: { error: { code: 'LOCAL_CHECK_REFUSED',
      message: expect.stringContaining('does not hold the integration ref at the observed tip') } } });
    const stale = await f.attempt('outer-2', first, [f.heads.a]);
    expect(stale.outcome).toMatchObject({ kind: 'refused', result: { error: { code: 'LOCAL_CHECK_REFUSED' } } });
    expect(await f.suiteTips()).toEqual([first, second]);
  }, 120000);

  /**
   * The suite runs only in the integration checkout of the prepared scope. A scope that names a task worktree refuses in the executor before any claim.
   * A checkout of the scope on another branch refuses too. Neither runs the suite.
   */
  it('IntegrationRetry_WrongCheckout_RefusesBeforeAnyClaim', async () => {
    const f = await localAttempts();
    const tip = await f.land('task/a');
    const elsewhere = await f.attempt('outer-1', tip, [f.heads.a], { scope: { ...f.scope, checkout: f.trees.a } });
    expect(elsewhere.outcome).toMatchObject({ kind: 'refused', result: { error: { code: 'LOCAL_CHECK_REFUSED',
      message: expect.stringContaining('not the integration checkout of the prepared scope') } } });
    const taskTip = await git(f.trees.c, 'rev-parse', 'HEAD');
    const otherBranch = await f.attempt('outer-1', taskTip, [f.heads.c], { ref: 'refs/heads/task/c' });
    expect(otherBranch.outcome).toMatchObject({ kind: 'refused', result: { error: { code: 'LOCAL_CHECK_REFUSED' } } });
    expect(await f.suiteTips()).toEqual([]);
  }, 120000);
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
