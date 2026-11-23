// @oracle-sources: ../../../../src/verbs/settle/integration-attempts.ts, the rows of a real event store and its bundle store, the exit codes that a fake executor gives, and the commits that real Git reports
/**
 * Integration attempts of a compiler 8-vcs settlement, with a fake executor in place of the local check executor.
 * Each case binds its attempt in a real event store, so the binding, the replayed request and the refusal are real.
 * The observation case reads the tip and the ancestry of a real Git checkout.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { capsuleDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../../../src/contract/capsule/prepared-bundle.js';
import { EventStore } from '../../../../src/events/store.js';
import { processObservationalGitPath } from '../../../../src/utils/git-tree.js';
import {
  integrationAttemptId, integrationAttemptIntact, runIntegrationAttempt, unresolvedIntegrationMessage, type IntegrationAttemptTerms,
} from '../../../../src/verbs/settle/integration-attempts.js';
import { observeIntegration } from '../../../../src/verbs/settle/integration-observation.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { fixture as preparedFixture, prepared } from '../../../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../../../helpers/scoped-repository.js';
import { fakeExecutor } from '../../../helpers/verification/check-executor.js';
import { integrationProfile, integrationTerm, unresolvedIntegrationTerm, UNRESOLVED_INTEGRATION_REASON } from '../../../helpers/verification-profile.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** The tip of each attempt. No Git reads it, because the fake executor runs no checkout. */
const TIP = 'a'.repeat(40);

/** The accepted heads of each attempt, sorted. */
const HEADS = ['b'.repeat(40), 'c'.repeat(40)];

/** The scope of the prepared capsule: the repository, the integration checkout and the config digest. */
const SCOPE = { repository: '/fixture/repository/.git', checkout: '/fixture/repository', configDigest: '4'.repeat(64) };

/** A store that holds one prepared workflow, and the terms of one attempt on it with a suite that exits with `exitCode`. */
async function attemptStore(exitCode: number) {
  const stateDir = makeTempDir('integration-attempts-');
  const events = new EventStore(stateDir);
  await events.initialize();
  cleanup.push(async () => { events.close(); await rmrfAsync(stateDir); });
  const bundle = preparedFixture();
  bundle.capsule.settlementContract = { ...bundle.capsule.settlementContract, scope: SCOPE };
  const streamId = bundle.capsule.identity.workflowId;
  const storeDigest = await events.bundleStore.put(encodePreparedBundle(bundle));
  await events.append(streamId, { ...prepared(bundle), data: {
    ...prepared(bundle).data, capsuleDigest: capsuleDigest(bundle.capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest: storeDigest }],
  } });
  const fake = fakeExecutor(() => ({ exitCode, stdout: '', stderr: '' }));
  const terms: IntegrationAttemptTerms = {
    eventStore: events, bundles: events.bundleStore, streamId, outerOperationId: 'outer-1', ref: 'refs/heads/integration', tip: TIP,
    heads: HEADS, preparedDigest: '1'.repeat(64), scope: SCOPE, profile: integrationProfile(integrationTerm(['node', 'suite.cjs'])), executor: fake.executor,
  };
  return { events, terms, fake };
}

describe('integration attempts', () => {
  /** A suite that exits with its red code fails the attempt. The message names the tip and the verdict, and the evidence is the stored observation. */
  it('IntegrationAttempt_ARedSuite_FailsWithTheTipAndTheVerdict', async () => {
    const { terms, fake } = await attemptStore(1);

    const { outcome, binding } = await runIntegrationAttempt(terms);

    expect(fake.legs).toEqual([['node', 'suite.cjs']]);
    expect(outcome).toMatchObject({ kind: 'failed', attemptBinding: integrationAttemptId(terms), evidenceDigest: '0'.repeat(64) });
    expect(outcome.kind === 'failed' ? outcome.message : '').toMatch(new RegExp(`^the integration suite at ${TIP} gave the verdict fail: `));
    expect(binding?.attemptId).toBe(integrationAttemptId(terms));
  });

  /** The binding of an attempt stays intact for its own request. A changed request and an attempt with no binding are not intact. */
  it('IntegrationAttempt_TheBoundRequest_IsIntactAndNoOtherIs', async () => {
    const { events, terms } = await attemptStore(0);

    const { outcome, binding } = await runIntegrationAttempt(terms);

    expect(outcome.kind).toBe('passed');
    if (binding === undefined) throw new Error('A passed attempt has no binding');
    expect(await integrationAttemptIntact(events, events.bundleStore, binding.attemptId, binding.request)).toBe(true);
    expect(await integrationAttemptIntact(events, events.bundleStore, binding.attemptId, binding.request.replace(TIP, 'd'.repeat(40)))).toBe(false);
    expect(await integrationAttemptIntact(events, events.bundleStore, integrationAttemptId({ ...terms, tip: 'd'.repeat(40) }), binding.request)).toBe(false);
  });

  /**
   * The attempt identity holds no checkout. So a later call of the same identity on another checkout reads the bound request, which differs.
   * That call refuses with the integration code, and the executor gets no second request.
   */
  it('IntegrationAttempt_TheSameIdentityOnAnotherCheckout_IsRefused', async () => {
    const { terms, fake } = await attemptStore(0);
    expect((await runIntegrationAttempt(terms)).outcome.kind).toBe('passed');

    const moved = await runIntegrationAttempt({ ...terms, scope: { ...SCOPE, checkout: '/fixture/other-checkout' } });

    expect(moved.outcome).toEqual({ kind: 'refused', result: { success: false, error: {
      code: 'INTEGRATION_REFUSED', message: 'The bound integration request differs from its attempt identity' } } });
    expect(moved.binding).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
  });

  /** A suite term that is not resolved did not run. The message keeps the reason of the unresolved term. */
  it('IntegrationAttempt_AnUnresolvedTerm_NamesTheReasonThatTheSuiteDidNotRun', () => {
    expect(unresolvedIntegrationMessage(SCOPE, integrationProfile(unresolvedIntegrationTerm())))
      .toBe(`the integration suite did not run (profile-unresolved): ${UNRESOLVED_INTEGRATION_REASON}`);
  });
});

describe('integration observation', () => {
  /** The observation reads the tip of the pinned ref on the checkout, and lists each head that the tip does not hold. */
  it('IntegrationObservation_AHeadOutsideTheTip_IsUnmerged', async () => {
    const repository = await scopedRepository({ integrationBranch: 'integration', files: { 'base.txt': 'base\n' } });
    cleanup.push(() => rmrfAsync(repository.root));
    const tree = await repository.worktreeFor('outside', { 'outside.txt': 'outside\n' });
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: tree })).trim();
    const repositoryDir = (await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repository.checkout })).trim();
    const gitPath = processObservationalGitPath();
    if (gitPath === undefined) throw new Error('No Git on PATH');
    const scope = { repository: repositoryDir, checkout: repository.checkout, configDigest: '4'.repeat(64) };

    const observed = await observeIntegration(gitPath, scope, 'refs/heads/integration', [repository.baseCommit, head]);

    expect(observed).toMatchObject({ kind: 'observed', tip: repository.baseCommit, unmerged: [head] });
  });
});
