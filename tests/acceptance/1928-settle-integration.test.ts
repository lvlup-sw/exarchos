// @oracle-sources: real Git merges on the integration branch observed by the operator-pinned observer, a disposable signing verifier that runs the suite at the observed tip, and SQLite claims and bindings read directly
/**
 * Settlement of a compiler 8-vcs capsule binds the accepted tasks to the tip of the pinned integration ref.
 * Each case prepares a typed plan through the public prepare handler with the 8-vcs compiler selected through its dependency.
 * The disposable verifier signs each reply with its own key, runs the suite at the observed tip and counts each execution.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { ExarchosCapsuleV1Schema, type ExarchosCapsuleV1 } from '../../src/contract/capsule/exarchos-capsule.js';
import {
  VERIFIER_VERSION, checkPlanDigest, signVerification, signVerificationReply, verificationDigest, verificationOperation,
  verifierSignerId, type HostedCheckoutIdentity, type VerificationHostConnector, type VerificationRequest, type VerificationResponse,
} from '../../src/contract/verification/harness-verification.js';
import { EventStore } from '../../src/events/store.js';
import { WorkflowPreparedData } from '../../src/events/schemas.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { productionExecuteDeps } from '../../src/verbs/execute/executor.js';
import { integrationSuitePlan } from '../../src/verbs/gates/check-integration-suite.js';
import { handlePrepare } from '../../src/verbs/prepare/handler.js';
import { PreparedCapsuleReceiptData } from '../../src/verbs/prepare/schemas.js';
import { handleSettle } from '../../src/verbs/settle/handler.js';
import { integrationAttemptId } from '../../src/verbs/settle/integration-attempts.js';
import { decodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { settlementClaimKey } from '../../src/verbs/settle/settlement-reads.js';
import { resolveTaskStanding } from '../../src/verbs/settle/task-standing.js';
import type { VerificationProfile } from '../../src/workflow/verification/profile.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync, spawnAsync } from '../../tools/test-helpers/spawn.js';
import { runAsTrustedCaller } from '../../tools/test-helpers/trusted-context.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { task, textOf } from '../helpers/capsule/prepared-authority.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';

const cleanup: (() => Promise<void> | void)[] = [];

/** The dispatch context of the fixture: a trusted caller with the capabilities that prepare, settle and the segment leaves need. */
function fixtureWiring(stateDir: string, eventStore: EventStore): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: true, callerIdentity: deriveMcpCallerIdentity({ sessionId: '1928-settle-integration' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence']) };
}
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** The canonical path of the Git executable that the observer and the disposable verifier use. */
const GIT = realpathSync((await execFileAsync('which', ['git'])).trim());

/** Run one Git command in a tree and return its trimmed output. */
async function git(tree: string, ...args: string[]): Promise<string> {
  return (await execFileAsync(GIT, ['-C', tree, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })).trim();
}

/** The identity of one resource, as the verifier signs it. */
function resource(path: string) {
  const info = statSync(path);
  return { path, device: String(info.dev), inode: String(info.ino) };
}

/** What the disposable verifier did: each exchange with its key, its executions and the suite runs with the tip that each run saw. */
interface VerifierLog {
  readonly exchanges: { readonly action: 'retrieve' | 'submit'; readonly key: string }[];
  readonly executions: VerificationRequest[];
  readonly suiteTips: string[];
}

/**
 * A disposable verifier that keeps one claim for each request key and one key for each operation, as the host claim table does.
 * It refuses an integration subject whose tip is not the current tip of the pinned ref, and it runs the suite in the integration checkout.
 * `drop` discards the next completed suite replies, `stale` signs the suite evidence for another checkout and `beforeSuite` runs before each suite run.
 * `integrationExchanges` lists each exchange that is not one of a task static-analysis request.
 */
function disposableVerifier(checkout: string, repository: string, trees: ReadonlyMap<string, string>) {
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signerId = verifierSignerId(publicKey);
  const claims = new Map<string, { readonly digest: string; terminal?: Extract<VerificationResponse, { kind: 'evidence' }> }>();
  const operations = new Map<string, string>();
  const staticKeys = new Set<string>();
  const log: VerifierLog = { exchanges: [], executions: [], suiteTips: [] };
  const control: { drop: number; stale: boolean; beforeSuite: (() => Promise<void>) | undefined } = { drop: 0, stale: false, beforeSuite: undefined };
  const reply = (key: string, digest: string, response: VerificationResponse) => signVerificationReply(key, digest, response, signer.privateKey);
  const run = async (request: VerificationRequest): Promise<VerificationResponse> => {
    const { subject } = request;
    const evidence = (resources: ReturnType<typeof resource>[], outcome: Record<string, unknown>): VerificationResponse => ({ kind: 'evidence',
      signed: signVerification({ version: 1, hostVersion: VERIFIER_VERSION, signerId, request, requestDigest: verificationDigest(request),
        hostPolicyDigest: 'a'.repeat(64), resources, completedAt: new Date().toISOString(),
        outcome: { status: 'passed', exitCode: 0, reason: '', stdoutBase64: '', stderrBase64: '', ...outcome } }, signer.privateKey) });
    const empty = createHash('sha256').update('').digest('hex');
    if (request.operation === 'integration-suite' && 'scope' in subject && subject.scope === 'integration') {
      if (await git(checkout, 'rev-parse', subject.ref) !== subject.headCommit) return { kind: 'refused', reason: 'Registered Git coordinates differ' };
      await control.beforeSuite?.();
      log.suiteTips.push(await git(checkout, 'rev-parse', 'HEAD'));
      const suite = await spawnAsync(process.execPath, ['command.cjs', 'integration'], { cwd: checkout });
      const exitCode = suite.status ?? 1;
      const first = control.stale ? [...trees.values()][0] ?? checkout : checkout;
      return evidence([resource(first), resource(repository)], { status: exitCode === 0 ? 'passed' : 'failed', exitCode,
        check: { operation: 'integration-suite', run: { end: 'exited', exitCode, stdout: '', stderr: '', outputDigest: empty }, report: null } });
    }
    if (request.operation === 'static-analysis' && !('scope' in subject)) {
      const tree = trees.get(subject.taskId);
      if (tree === undefined) return { kind: 'refused', reason: 'Unknown task checkout' };
      return evidence([resource(tree), resource(repository)], { check: { operation: 'static-analysis',
        commands: [{ end: 'exited', exitCode: 0, stdout: '', stderr: '', outputDigest: empty }], boundary: [] } });
    }
    return { kind: 'refused', reason: 'Request does not match protected execution authority' };
  };
  const client: VerificationHostConnector['client'] = {
    async retrieve(key, digest) {
      log.exchanges.push({ action: 'retrieve', key });
      const claim = claims.get(key);
      if (claim === undefined) return reply(key, digest, { kind: 'absent' });
      if (claim.digest !== digest) return reply(key, digest, { kind: 'conflict' });
      return reply(key, digest, claim.terminal ?? { kind: 'incomplete', key, digest });
    },
    async submit(request) {
      if (request.operation === 'static-analysis') staticKeys.add(request.key);
      log.exchanges.push({ action: 'submit', key: request.key });
      const digest = verificationDigest(request);
      const existing = claims.get(request.key);
      if (existing !== undefined) return reply(request.key, digest, existing.digest === digest ? existing.terminal ?? { kind: 'busy' } : { kind: 'conflict' });
      const operation = verificationOperation(request);
      if (operations.has(operation)) return reply(request.key, digest, { kind: 'conflict' });
      const response = await run(request);
      if (response.kind !== 'evidence') return reply(request.key, digest, response);
      log.executions.push(request);
      operations.set(operation, request.key);
      claims.set(request.key, { digest, terminal: response });
      if (control.drop > 0 && request.operation === 'integration-suite') { control.drop -= 1; return { kind: 'unavailable', reason: 'The fixture discarded the completed reply' }; }
      return reply(request.key, digest, response);
    },
  };
  const integrationExchanges = () => log.exchanges.filter(exchange => !staticKeys.has(exchange.key));
  return { publicKey, client, log, control, integrationExchanges };
}

/** The checkout config of the fixture. `suite` resolves the integration term, and without it the term stays unresolved. */
function config(suite: boolean): string {
  return JSON.stringify({ verification: { staticAnalysis: { lint: 'node command.cjs static' },
    tests: { globs: ['tests/**/*.test.cjs'], probe: { command: 'node command.cjs probe', files: 'as-arguments', failureExitCodes: [1] } },
    ...(suite ? { integration: { command: 'node command.cjs integration' } } : {}) } });
}

/** The suite of the fixture fails while the integration checkout holds a FAIL file. */
const COMMAND = "const fs=require('node:fs');if(process.argv[2]==='integration'&&fs.existsSync('FAIL'))process.exit(1);";

/**
 * Prepare a typed plan with the chosen compiler, build each task in its own linked worktree and wire a disposable verifier.
 * `land` merges task branches into the integration checkout, and `settle` claims tasks with their worktree and branch.
 */
async function fixture(edges: Readonly<Record<string, readonly string[]>>, options: { readonly suite?: boolean; readonly compilerVersion?: string } = {}) {
  const suite = options.suite ?? true;
  const compilerVersion = options.compilerVersion ?? 'exarchos-prepare-8-vcs';
  const tasks = Object.entries(edges).map(([id, parents]) => task(id, { blockedBy: [...parents], files: [`src/${id}.cjs`], testFiles: [`tests/${id}.test.cjs`] }));
  const text = textOf(tasks);
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'design.md': text, 'command.cjs': COMMAND, '.exarchos.yml': config(suite) } });
  cleanup.push(() => rmrfAsync(repo.root));
  const stateDir = makeTempDir('1928-settle-integration-');
  let events = new EventStore(stateDir); await events.initialize();
  cleanup.push(async () => { events.close(); await rmrfAsync(stateDir); });
  const stream = 'integration-capsule';
  const prepareCtx = () => fixtureWiring(stateDir, events);
  const args = { featureId: stream, repoRoot: repo.checkout, intent: { mode: 'bootstrap', workflowType: 'feature', baseRef: 'integration', designRef: 'design.md',
    approval: { decision: 'approved', designDigest: createHash('sha256').update(text).digest('hex') } } };
  const prepared = await runAsTrustedCaller(stateDir, () => handlePrepare(args, stateDir, prepareCtx(), { compilerVersion, catalogInvariants: () => [] }));
  expect(prepared.success, JSON.stringify(prepared)).toBe(true);
  const record = WorkflowPreparedData.parse((await events.query(stream)).find(row => row.type === 'workflow.prepared')?.data);
  const receipt = PreparedCapsuleReceiptData.parse(events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(record.operationId)?.result);
  const capsule: ExarchosCapsuleV1 = ExarchosCapsuleV1Schema.parse(receipt.capsule);
  const scope = capsule.settlementContract.scope;
  const profile = capsule.settlementContract.verificationProfile;
  if (scope === undefined || profile === undefined) throw new Error('The prepared capsule lacks its scope or profile');
  const trees = new Map<string, string>(); const heads = new Map<string, string>(); const forks = new Map<string, string>();
  for (const [id, parents] of Object.entries(edges)) {
    const tree = await repo.worktreeFor(id); trees.set(id, tree);
    for (const parent of parents) await git(tree, 'merge', '--no-edit', `task/${parent}`);
    forks.set(id, await git(tree, 'rev-parse', 'HEAD'));
    await repo.commitIn(id, { [`src/${id}.cjs`]: 'module.exports = 1;\n', [`tests/${id}.test.cjs`]: `require('../src/${id}.cjs');\n` });
    heads.set(id, await git(tree, 'rev-parse', 'HEAD'));
  }
  const verifier = disposableVerifier(scope.checkout, scope.repository, trees);
  const resolvedTerm: VerificationProfile['integration'] = { ...profile.integration,
    command: { state: 'resolved', source: 'config', argv: ['node', 'command.cjs', 'integration'] } };
  const identity: HostedCheckoutIdentity = { resourceId: 'integration', profileId: 'integration', checkout: scope.checkout,
    repository: scope.repository, branch: 'refs/heads/integration', commandDigest: checkPlanDigest(integrationSuitePlan(resolvedTerm)) };
  const connector = (overrides: Partial<HostedCheckoutIdentity> | null = {}, gitPath = GIT): VerificationHostConnector => ({
    publicKey: verifier.publicKey, gitPath, resourceId: 'unused', profileId: 'unused', client: verifier.client,
    checks: { 'static-analysis': { resourceId: 'static', profileId: 'static' }, ...(overrides === null ? {} : { integration: { ...identity, ...overrides } }) },
  });
  const settle = (ids: readonly string[], batchId: string, host: VerificationHostConnector | null = connector(), extra: Record<string, unknown> = {}) =>
    runAsTrustedCaller(stateDir, () => handleSettle({ featureId: stream, capsuleVersion: record.capsuleVersion, batchId, ...extra,
      claims: ids.map(taskId => ({ taskId, fields: { worktreePath: trees.get(taskId), branch: `task/${taskId}`,
        ...((edges[taskId]?.length ?? 0) > 0 ? { forkCommit: forks.get(taskId) } : {}) }, evidence: [] })) },
    stateDir, { ...fixtureWiring(stateDir, events), ...(host === null ? {} : { verificationHost: host }) },
    { execute: productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate') }));
  const land = async (...ids: string[]) => {
    for (const id of ids) await git(scope.checkout, 'merge', '--no-edit', `task/${id}`);
    return git(scope.checkout, 'rev-parse', 'HEAD');
  };
  const commitOnIntegration = async (file: string, body = 'x\n') => {
    await writeFile(join(scope.checkout, file), body);
    await git(scope.checkout, 'add', file); await git(scope.checkout, 'commit', '-q', '-m', `add ${file}`);
    return git(scope.checkout, 'rev-parse', 'HEAD');
  };
  const backend = () => events.getAppender().ensureSqliteBackendSync();
  const rows = () => events.query(stream);
  const bundleOf = async (result: { readonly data?: unknown }) => {
    const data = result.data;
    if (typeof data !== 'object' || data === null || !('bundleRefs' in data) || !Array.isArray(data.bundleRefs)) throw new Error('Missing settlement bundle');
    const ref: unknown = data.bundleRefs[0];
    if (typeof ref !== 'object' || ref === null || !('digest' in ref)) throw new Error('Missing settlement bundle reference');
    const digest = ref.digest;
    if (typeof digest !== 'object' || digest === null || !('algorithm' in digest) || !('value' in digest)
      || digest.algorithm !== 'sha256' || typeof digest.value !== 'string') throw new Error('Malformed settlement bundle reference');
    return decodeSettlementBundle(await events.bundleStore.resolve({ algorithm: 'sha256', value: digest.value }));
  };
  const attemptId = (batchId: string, tip: string, ids: readonly string[]) => integrationAttemptId({
    outerOperationId: settlementClaimKey(stream, { ...capsule.identity, batchId }), ref: 'refs/heads/integration', tip,
    heads: ids.map(id => heads.get(id) ?? '').sort(), profile });
  const standing = async (taskId: string) => (await resolveTaskStanding({ streamId: stream, taskId, rows: await rows(), bundles: events.bundleStore,
    lookupClaim: id => backend().lookupOperationClaim(id) })).kind;
  const restart = async () => { events.close(); events = new EventStore(stateDir); await events.initialize(); };
  return { repo, scope, profile, capsule, record, stream, trees, heads, verifier, identity, connector, settle, land, commitOnIntegration,
    backend, rows, bundleOf, attemptId, standing, restart, integrationRequests: () => verifier.log.executions.filter(r => r.operation === 'integration-suite') };
}

/** The settlement records of the stream. */
function settled(rows: readonly { readonly type: string }[]) { return rows.filter(row => row.type === 'execution.settled'); }

describe('compiler 8-vcs settlement', () => {
  /** A real landing on the integration ref accepts at its tip, and the replay reads the receipt before any Git or verifier read. */
  it('SettleIntegration_HarnessLanding_AcceptsAtTheTipAndReplaysTerminally', async () => {
    const f = await fixture({ root: [] });
    expect(f.capsule.provenance.compilerVersion).toBe('exarchos-prepare-8-vcs');
    expect(f.capsule.settlementContract.integration).toEqual({ ref: 'refs/heads/integration' });
    const tip = await f.land('root');
    const result = await f.settle(['root'], 'landed');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: ['root'], findings: [] });
    expect(await f.standing('root')).toBe('accepted');
    const [request] = f.integrationRequests();
    expect(f.integrationRequests()).toHaveLength(1);
    expect(request).toMatchObject({ resourceId: 'integration', profileId: 'integration', commandDigest: f.identity.commandDigest,
      subject: { scope: 'integration', streamId: f.stream, ref: 'refs/heads/integration', headCommit: tip, acceptedHeads: [f.heads.get('root')],
        profileDigest: contentDigest(f.profile), configDigest: f.scope.configDigest } });
    expect(f.verifier.log.suiteTips).toEqual([tip]);
    const bundle = await f.bundleOf(result);
    expect(bundle.integration).toMatchObject({ ref: 'refs/heads/integration', tip, attemptBinding: f.attemptId('landed', tip, ['root']) });
    expect(bundle.integration?.suiteEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.backend().lookupSegmentInput(f.attemptId('landed', tip, ['root']))).toBeDefined();
    const exchanges = f.verifier.log.exchanges.length;
    const before = await f.rows();
    await f.commitOnIntegration('later.txt');
    const replay = await f.settle(['root'], 'landed', f.connector({}, '/nonexistent/git'));
    expect(replay).toEqual(result);
    expect(f.verifier.log.exchanges).toHaveLength(exchanges);
    expect(await f.rows()).toEqual(before);
  }, 120000);

  /** A missing connector, a missing identity and an identity of another branch, checkout, repository or command refuse before any claim. */
  it('SettleIntegration_WrongBranchOrRepository_RefusesBeforeAnyClaim', async () => {
    const f = await fixture({ root: [] });
    await f.land('root');
    const before = await f.rows();
    const unusable: VerificationHostConnector = { publicKey: '', gitPath: '', resourceId: '', profileId: '',
      client: { submit: async () => ({ kind: 'unavailable', reason: 'unusable' }), retrieve: async () => ({ kind: 'unavailable', reason: 'unusable' }) } };
    const cases: [VerificationHostConnector | null, string][] = [
      [null, 'VERIFIER_NOT_PROVISIONED'],
      [unusable, 'HOSTED_VERIFICATION_REFUSED'],
      [f.connector(null), 'HOSTED_VERIFICATION_REFUSED'],
      [f.connector({ branch: 'refs/heads/other' }), 'HOSTED_VERIFICATION_REFUSED'],
      [f.connector({ branch: 'integration' }), 'HOSTED_VERIFICATION_REFUSED'],
      [f.connector({ repository: f.repo.root }), 'HOSTED_VERIFICATION_REFUSED'],
      [f.connector({ checkout: f.trees.get('root') ?? '' }), 'HOSTED_VERIFICATION_REFUSED'],
      [f.connector({ commandDigest: 'b'.repeat(64) }), 'HOSTED_VERIFICATION_REFUSED'],
    ];
    for (const [host, code] of cases) {
      const refused = await f.settle(['root'], 'wrong', host);
      expect(refused, JSON.stringify(refused)).toMatchObject({ success: false, error: { code } });
    }
    expect(await f.rows()).toEqual(before);
    expect(f.verifier.log.exchanges).toEqual([]);
    expect(f.backend().lookupOperationClaim(settlementClaimKey(f.stream, { ...f.capsule.identity, batchId: 'wrong' }))).toBeUndefined();
  }, 120000);

  /** A task head that the tip does not contain gives the verification-failed finding from the observation, with no verifier request. */
  it('SettleIntegration_UnmergedHead_FailsWithNoSuiteRequest', async () => {
    const f = await fixture({ root: [] });
    const tip = await git(f.scope.checkout, 'rev-parse', 'HEAD');
    const result = await f.settle(['root'], 'unmerged');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: [], unresolved: [{ taskId: 'root', cause: 'verification-failed' }],
      findings: [{ kind: 'verification-failed', subject: 'root', at: 'settlementContract.integration.ref' }] });
    expect(JSON.stringify(result.data)).toContain('does not contain the accepted head');
    expect(f.integrationRequests()).toEqual([]);
    expect(f.backend().lookupSegmentInput(f.attemptId('unmerged', tip, ['root']))).toBeUndefined();
    const bundle = await f.bundleOf(result);
    expect(bundle.integration).toMatchObject({ ref: 'refs/heads/integration', tip });
    expect(bundle.integration?.attemptBinding).toBeUndefined();
    expect(bundle.integration?.suiteEvidenceDigest).toBeUndefined();
    expect(await f.standing('root')).not.toBe('accepted');
  }, 120000);

  /**
   * An unresolved capsule suite with a real-digest identity gives the verification-failed finding with the unresolved reason.
   * It makes no verifier request, binds nothing and commits a receipt that a second call replays with no Git or verifier read.
   */
  it('SettleIntegration_UnresolvedSuite_FailsWithNoVerifierRequestAndReplays', async () => {
    const f = await fixture({ root: [] }, { suite: false });
    expect(f.profile.integration.command.state).toBe('unresolved');
    const tip = await f.land('root');
    const result = await f.settle(['root'], 'unresolved');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: [], findings: [{ kind: 'verification-failed', subject: 'root' }] });
    expect(JSON.stringify(result.data)).toContain('profile-unresolved');
    expect(f.integrationRequests()).toEqual([]);
    expect(f.verifier.integrationExchanges()).toEqual([]);
    expect(f.backend().lookupSegmentInput(f.attemptId('unresolved', tip, ['root']))).toBeUndefined();
    expect(settled(await f.rows())).toHaveLength(1);
    const bundle = await f.bundleOf(result);
    expect(bundle.integration).toMatchObject({ ref: 'refs/heads/integration', tip });
    expect(bundle.integration?.attemptBinding).toBeUndefined();
    const exchanges = f.verifier.log.exchanges.length;
    const replay = await f.settle(['root'], 'unresolved', f.connector({}, '/nonexistent/git'));
    expect(replay).toEqual(result);
    expect(f.verifier.log.exchanges).toHaveLength(exchanges);
  }, 120000);

  /** A red suite at the landed tip gives the verification-failed finding and keeps the attempt binding and the evidence digest. */
  it('SettleIntegration_RedSuite_FailsAtTheTip', async () => {
    const f = await fixture({ root: [] });
    await f.land('root');
    const tip = await f.commitOnIntegration('FAIL');
    const result = await f.settle(['root'], 'red');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: [], findings: [{ kind: 'verification-failed', subject: 'root' }] });
    expect(JSON.stringify(result.data)).toContain('verdict fail');
    expect(f.integrationRequests()).toHaveLength(1);
    const bundle = await f.bundleOf(result);
    expect(bundle.integration).toMatchObject({ tip, attemptBinding: f.attemptId('red', tip, ['root']) });
    expect(bundle.integration?.suiteEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  }, 120000);

  /** Signed evidence of another checkout is never read as a verdict. The call commits nothing, and the original result then admits. */
  it('SettleIntegration_StaleProviderResult_CommitsNothing', async () => {
    const f = await fixture({ root: [] });
    await f.land('root');
    f.verifier.control.stale = true;
    const pending = await f.settle(['root'], 'stale');
    expect(pending, JSON.stringify(pending)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(settled(await f.rows())).toEqual([]);
    expect(await f.standing('root')).not.toBe('accepted');
    expect(f.integrationRequests()).toHaveLength(1);
  }, 120000);

  /** A landing during the suite gives one fresh attempt at the new tip. A second move in one call refuses with no commit. */
  it('SettleIntegration_MovedTip_OneFreshAttemptThenRetryableRefusal', async () => {
    const f = await fixture({ root: [] });
    await f.land('root');
    let moves = 0;
    f.verifier.control.beforeSuite = async () => { if (moves < 1) { moves += 1; await f.commitOnIntegration(`move-${moves}.txt`); } };
    const moved = await f.settle(['root'], 'moved');
    expect(moved.success, JSON.stringify(moved)).toBe(true);
    expect(moved.data).toMatchObject({ acceptedTasks: ['root'] });
    const tips = f.integrationRequests().map(request => request.subject.headCommit);
    expect(tips).toHaveLength(2);
    expect(new Set(tips).size).toBe(2);
    expect((await f.bundleOf(moved)).integration?.tip).toBe(tips[1]);

    const g = await fixture({ root: [] });
    await g.land('root');
    let count = 0;
    g.verifier.control.beforeSuite = async () => { count += 1; await g.commitOnIntegration(`again-${count}.txt`); };
    const twice = await g.settle(['root'], 'twice');
    expect(twice, JSON.stringify(twice)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(twice.error?.message).toContain('moved twice');
    expect(settled(await g.rows())).toEqual([]);
    expect(g.integrationRequests()).toHaveLength(2);
    g.verifier.control.beforeSuite = undefined;
    const after = await g.settle(['root'], 'twice');
    expect(after.success, JSON.stringify(after)).toBe(true);
    expect(after.data).toMatchObject({ acceptedTasks: ['root'] });
    expect(g.integrationRequests()).toHaveLength(3);
  }, 180000);

  /**
   * A partial DAG settles its root first. The dependent attempt binds the accepted root head too.
   * A held batch accepts no task and starts no attempt. A rewrite of the ref before the commit commits nothing for the old tip.
   */
  it('SettleIntegration_PartialDagHeldAndCommitFence', async () => {
    const f = await fixture({ root: [], child: ['root'] });
    await f.land('root');
    const first = await f.settle(['root'], 'root-only');
    expect(first.data, JSON.stringify(first)).toMatchObject({ acceptedTasks: ['root'] });
    const held = await f.settle(['child'], 'held', f.connector(), { deviations: [{ deviationKind: 'missing-context', statement: 'The child needs a decision.' }] });
    expect(held.success, JSON.stringify(held)).toBe(true);
    expect(held.data).toMatchObject({ outcome: 'deviation-pending', findings: [{ kind: 'deviation-awaiting-approval' }] });
    expect(f.integrationRequests()).toHaveLength(1);
    expect(await f.standing('child')).not.toBe('accepted');
    const tip = await f.land('child');
    const child = await f.settle(['child'], 'child');
    expect(child.data, JSON.stringify(child)).toMatchObject({ acceptedTasks: ['child'] });
    expect(f.integrationRequests().at(-1)?.subject).toMatchObject({ headCommit: tip,
      acceptedHeads: [f.heads.get('root'), f.heads.get('child')].sort() });

    const g = await fixture({ root: [] });
    const base = await git(g.scope.checkout, 'rev-parse', 'HEAD');
    await g.land('root');
    g.verifier.control.beforeSuite = async () => { await git(g.scope.checkout, 'reset', '-q', '--hard', base); };
    const fenced = await g.settle(['root'], 'fenced');
    expect(fenced.success, JSON.stringify(fenced)).toBe(true);
    expect(fenced.data).toMatchObject({ acceptedTasks: [], findings: [{ kind: 'verification-failed', subject: 'root' }] });
    expect((await g.bundleOf(fenced)).integration).toMatchObject({ tip: base });
    expect((await g.bundleOf(fenced)).integration?.attemptBinding).toBeUndefined();
    expect(g.integrationRequests()).toHaveLength(1);
  }, 240000);

  /** A terminal receipt of compiler 8 replays unchanged with a verifier attached, and its capsule pins no integration term. */
  it('SettleIntegration_OldCompilerEightReceipt_ReplaysUnchanged', async () => {
    const f = await fixture({ root: [] }, { compilerVersion: 'exarchos-prepare-8' });
    expect(f.capsule.provenance.compilerVersion).toBe('exarchos-prepare-8');
    expect(f.capsule.settlementContract.integration).toBeUndefined();
    const original = await f.settle(['root'], 'history', null);
    expect(original.success, JSON.stringify(original)).toBe(true);
    expect(original.data).toMatchObject({ acceptedTasks: ['root'] });
    expect((await f.bundleOf(original)).integration).toBeUndefined();
    expect(await f.settle(['root'], 'history')).toEqual(original);
    expect(await f.settle(['root'], 'history', null)).toEqual(original);
    expect(f.verifier.log.exchanges).toEqual([]);
  }, 120000);

  /**
   * Compiler 8-vcs with no recorded integration branch refuses before any record. It never takes the compile base or the current branch.
   * After the workflow records a short branch name, prepare pins its full ref.
   */
  it('SettleIntegration_PrepareWithoutRecordedIntegrationBranch_RefusesBeforeAnyRecord', async () => {
    const tasks = [task('root', { files: ['src/root.cjs'], testFiles: ['tests/root.test.cjs'] })];
    const text = textOf(tasks);
    const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'design.md': text, 'command.cjs': COMMAND, '.exarchos.yml': config(true) } });
    cleanup.push(() => rmrfAsync(repo.root));
    const stateDir = makeTempDir('1928-settle-integration-prepare-');
    const events = new EventStore(stateDir); await events.initialize();
    cleanup.push(async () => { events.close(); await rmrfAsync(stateDir); });
    const stream = 'integration-unrecorded';
    await events.append(stream, { type: 'workflow.started', schemaVersion: '1.1', data: { featureId: stream, workflowType: 'feature', initialPhase: 'delegate' } });
    const args = { featureId: stream, repoRoot: repo.checkout, intent: { mode: 'compile', designRef: 'design.md', baseRef: 'integration',
      approval: { decision: 'approved', designDigest: createHash('sha256').update(text).digest('hex') } } };
    const prepare = () => runAsTrustedCaller(stateDir, () => handlePrepare(args, stateDir, fixtureWiring(stateDir, events),
      { compilerVersion: 'exarchos-prepare-8-vcs', catalogInvariants: () => [] }));
    const before = await events.query(stream);
    const refused = await prepare();
    expect(refused, JSON.stringify(refused)).toMatchObject({ success: false, error: { code: 'BASE_UNRESOLVED' } });
    expect(refused.error?.message).toContain('synthesis.integrationBranch');
    expect(await events.query(stream)).toEqual(before);
    await events.append(stream, { type: 'state.patched', data: { patch: { 'synthesis.integrationBranch': 'integration' } } });
    const accepted = await prepare();
    expect(accepted.success, JSON.stringify(accepted)).toBe(true);
    const capsule = ExarchosCapsuleV1Schema.parse(PreparedCapsuleReceiptData.parse(accepted.data).capsule);
    expect(capsule.provenance.compilerVersion).toBe('exarchos-prepare-8-vcs');
    expect(capsule.settlementContract.integration).toEqual({ ref: 'refs/heads/integration' });
  }, 120000);

  /** A lost delivery commits nothing. After a restart the same call recomputes the attempt, finds its binding and admits the original result. */
  it('SettleIntegration_RestartRecovery_ResubmitsTheBoundRequest', async () => {
    const f = await fixture({ root: [] });
    const tip = await f.land('root');
    f.verifier.control.drop = 1;
    const lost = await f.settle(['root'], 'restart');
    expect(lost, JSON.stringify(lost)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(settled(await f.rows())).toEqual([]);
    const binding = f.backend().lookupSegmentInput(f.attemptId('restart', tip, ['root']));
    expect(binding).toBeDefined();
    await f.restart();
    const recovered = await f.settle(['root'], 'restart');
    expect(recovered.success, JSON.stringify(recovered)).toBe(true);
    expect(recovered.data).toMatchObject({ acceptedTasks: ['root'] });
    expect(f.integrationRequests()).toHaveLength(1);
    expect(f.backend().lookupSegmentInput(f.attemptId('restart', tip, ['root']))).toBe(binding);
  }, 120000);
});
