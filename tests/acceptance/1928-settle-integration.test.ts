// @oracle-sources: real Git merges on the integration branch observed by the constrained observer, the local check executor that runs the suite at the observed tip, a suite log outside the checkout, and SQLite claims and bindings read directly
/**
 * Settlement of a compiler 8-vcs capsule binds the accepted tasks to the tip of the pinned integration ref.
 * Each case prepares a typed plan through the public prepare handler with the 8-vcs compiler selected through its dependency.
 * Settle runs the suite at the observed tip in its own local executor, in the integration checkout of the capsule scope, with no connector.
 * The suite appends the tip that it saw to a log outside the checkout, so a case counts each suite run.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { ExarchosCapsuleV1Schema, type ExarchosCapsuleV1 } from '../../src/contract/capsule/exarchos-capsule.js';
import { canonicalJson } from '../../src/contract/request-context.js';
import {
  VerificationRequest, verificationDigest, verificationJson, verificationKey, verificationValueDigest, type VerificationRequestTerms,
} from '../../src/contract/verification/harness-verification.js';
import { EventStore } from '../../src/events/store.js';
import { WorkflowPreparedData } from '../../src/events/schemas.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { productionExecuteDeps } from '../../src/verbs/execute/executor.js';
import { handlePrepare } from '../../src/verbs/prepare/handler.js';
import { PreparedCapsuleReceiptData } from '../../src/verbs/prepare/schemas.js';
import { handleSettle } from '../../src/verbs/settle/handler.js';
import { IntegrationAttemptBindingV1Schema, IntegrationAttemptRequestV1Schema, integrationAttemptId } from '../../src/verbs/settle/integration-attempts.js';
import { decodeSettlementBundle, encodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { DECIDE_ONCE_CLAIM_STREAM, SEGMENT_INPUT_CLAIM_STREAM } from '../../src/storage/sqlite/constants.js';
import { handleRehydrate } from '../../src/workflow/rehydrate.js';
import { settlementClaimKey } from '../../src/verbs/settle/settlement-reads.js';
import { resolveTaskStanding } from '../../src/verbs/settle/task-standing.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { runAsTrustedCaller } from '../../tools/test-helpers/trusted-context.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { task, textOf } from '../helpers/capsule/prepared-authority.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';

/** The crash switch of the executor. While it holds true, each integration attempt throws after its suite leg and before its terminal observation. */
const crash = vi.hoisted(() => ({ afterSuite: false }));

vi.mock('../../src/verbs/verification/check-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/verbs/verification/check-executor.js')>();
  const runApprovedCheck: typeof actual.runApprovedCheck = (request, body) => request.integration !== undefined && crash.afterSuite
    ? actual.runApprovedCheck(request, async (session) => {
      await body(session);
      throw new Error('The fixture stopped the attempt after its suite leg');
    })
    : actual.runApprovedCheck(request, body);
  return { ...actual, runApprovedCheck };
});

const cleanup: (() => Promise<void> | void)[] = [];

/** The dispatch context of the fixture: a trusted caller with the capabilities that prepare, settle and the segment leaves need. */
function fixtureWiring(stateDir: string, eventStore: EventStore): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: true, callerIdentity: deriveMcpCallerIdentity({ sessionId: '1928-settle-integration' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence']) };
}
afterEach(async () => {
  crash.afterSuite = false;
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** The canonical path of the Git executable of the fixture. */
const GIT = realpathSync((await execFileAsync('which', ['git'])).trim());

/** The Git identity of each fixture commit. */
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

/** Run one Git command in a tree and return its trimmed output. */
async function git(tree: string, ...args: string[]): Promise<string> {
  return (await execFileAsync(GIT, ['-C', tree, ...args], { env: { ...process.env, ...IDENTITY } })).trim();
}

/** The checkout config of the fixture. `suite` resolves the integration term, and without it the term stays unresolved. */
function config(suite: boolean): string {
  return JSON.stringify({ verification: { staticAnalysis: { lint: 'node command.cjs static' },
    tests: { globs: ['tests/**/*.test.cjs'], probe: { command: 'node command.cjs probe', files: 'as-arguments', failureExitCodes: [1] } },
    ...(suite ? { integration: { command: 'node command.cjs integration' } } : {}) } });
}

/**
 * The command of the fixture. The suite appends the tip that it sees to the log that `FIXTURE_SUITE_LOG` names.
 * Then it runs the next action of the queue that `FIXTURE_SUITE_ACTIONS` names: a `commit` adds an empty commit, and `reset <sha>` resets the checkout.
 * The suite fails while the integration checkout holds a FAIL file.
 */
const COMMAND = [
  "const fs=require('node:fs');const cp=require('node:child_process');",
  "if(process.argv[2]==='integration'){",
  "const log=process.env.FIXTURE_SUITE_LOG;if(log)fs.appendFileSync(log,cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()+'\\n');",
  "const queue=process.env.FIXTURE_SUITE_ACTIONS;",
  "if(queue&&fs.existsSync(queue)){const lines=fs.readFileSync(queue,'utf8').split('\\n').filter(Boolean);const next=lines.shift();",
  "fs.writeFileSync(queue,lines.join('\\n')+(lines.length?'\\n':''));const id=['-c','user.name=Fixture','-c','user.email=fixture@example.invalid'];",
  "if(next==='commit')cp.execFileSync('git',[...id,'commit','-q','--allow-empty','-m','moved during the suite']);",
  "else if(next&&next.startsWith('reset '))cp.execFileSync('git',['reset','-q','--hard',next.slice(6)]);}",
  "if(fs.existsSync('FAIL'))process.exit(1);}",
].join('');

/**
 * Prepare a typed plan with the chosen compiler and build each task in its own linked worktree.
 * `land` merges task branches into the integration checkout, and `settle` claims tasks with their worktree and branch.
 * `suiteTips` reads the tip of each suite run, and `queue` adds the actions that the next suite runs take.
 */
async function fixture(edges: Readonly<Record<string, readonly string[]>>, options: { readonly suite?: boolean; readonly compilerVersion?: string } = {}) {
  const suite = options.suite ?? true;
  const compilerVersion = options.compilerVersion ?? 'exarchos-prepare-8-vcs';
  const tasks = Object.entries(edges).map(([id, parents]) => task(id, { blockedBy: [...parents], files: [`src/${id}.cjs`], testFiles: [`tests/${id}.test.cjs`] }));
  const text = textOf(tasks);
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'design.md': text, 'command.cjs': COMMAND, '.exarchos.yml': config(suite) } });
  cleanup.push(() => rmrfAsync(repo.root));
  const stateDir = makeTempDir('1928-settle-integration-');
  const outside = makeTempDir('1928-settle-integration-log-');
  cleanup.push(() => rmrfAsync(outside));
  const log = join(outside, 'suite.log');
  const actions = join(outside, 'actions');
  vi.stubEnv('FIXTURE_SUITE_LOG', log);
  vi.stubEnv('FIXTURE_SUITE_ACTIONS', actions);
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
  const settle = (ids: readonly string[], batchId: string, extra: Record<string, unknown> = {}) =>
    runAsTrustedCaller(stateDir, () => handleSettle({ featureId: stream, capsuleVersion: record.capsuleVersion, batchId, ...extra,
      claims: ids.map(taskId => ({ taskId, fields: { worktreePath: trees.get(taskId), branch: `task/${taskId}`,
        ...((edges[taskId]?.length ?? 0) > 0 ? { forkCommit: forks.get(taskId) } : {}) }, evidence: [] })) },
    stateDir, fixtureWiring(stateDir, events),
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
  const suiteTips = async (): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const queue = (...steps: string[]) => writeFile(actions, steps.map(step => `${step}\n`).join(''));
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
  const boundRequest = async (batchId: string, tip: string, ids: readonly string[]) => {
    const payload = IntegrationAttemptBindingV1Schema.parse(JSON.parse(backend().lookupSegmentInput(attemptId(batchId, tip, ids)) ?? 'null'));
    return IntegrationAttemptRequestV1Schema.parse(JSON.parse((await events.bundleStore.resolve(payload.request)).toString('utf8')));
  };
  const standing = async (taskId: string) => (await resolveTaskStanding({ streamId: stream, taskId, rows: await rows(), bundles: events.bundleStore,
    lookupClaim: id => backend().lookupOperationClaim(id) })).kind;
  const restart = async () => { events.close(); events = new EventStore(stateDir); await events.initialize(); };
  return { repo, scope, profile, capsule, record, stream, stateDir, trees, heads, settle, land, commitOnIntegration, suiteTips, queue,
    backend, rows, bundleOf, attemptId, boundRequest, standing, restart, events: () => events };
}

/** The settlement records of the stream. */
function settled(rows: readonly { readonly type: string }[]) { return rows.filter(row => row.type === 'execution.settled'); }

/** Every durable row and claim of a store, with its exact serialized payload. */
function durableSnapshot(stateDir: string): { readonly events: unknown[]; readonly claims: unknown[] } {
  const db = new Database(join(stateDir, 'exarchos.db'));
  try {
    return { events: db.prepare('SELECT * FROM events ORDER BY streamId,sequence').all(),
      claims: db.prepare('SELECT * FROM idempotency_claims ORDER BY streamId,idempotencyKey').all() };
  } finally { db.close(); }
}

/** The serialized result of a read with its read time removed, so two reads of the same rows compare byte for byte. */
function withoutReadClock(result: unknown): string {
  return JSON.stringify(result).replace(/"projectionAsOf":"[^"]*"/, '"projectionAsOf":""');
}

/**
 * Rewrite one local settlement of the batch into the records that the retired verifier host wrote at the same tip.
 * The host attempt identity has no route term, and its binding holds the canonical verifier request.
 * The settlement bundle names that binding and the digest of the signed suite evidence. The governor never stored the evidence body.
 * The local binding, the local executor rows and the local suite observation leave the store. Then the store opens again.
 */
async function toHostEra(f: Awaited<ReturnType<typeof fixture>>, local: { readonly data?: unknown }, batchId: string, tip: string) {
  const outerOperationId = settlementClaimKey(f.stream, { ...f.capsule.identity, batchId });
  const bound = await f.boundRequest(batchId, tip, ['root']);
  const heads = [f.heads.get('root') ?? ''];
  const profileDigest = contentDigest(f.profile);
  const attempt = `settle-integration:${verificationValueDigest({ outerOperationId, ref: 'refs/heads/integration', tip, profileDigest, heads })}`;
  const terms: Extract<VerificationRequestTerms, { operation: 'integration-suite' }> = {
    version: 1, operation: 'integration-suite', resourceId: 'integration-checkout', profileId: 'integration-suite', commandDigest: bound.planDigest,
    subject: { scope: 'integration', streamId: f.stream, phaseAttemptId: bound.phaseAttemptId, outerOperationId, ref: 'refs/heads/integration',
      headCommit: tip, preparedDigest: bound.preparedDigest, configDigest: bound.configDigest, profileDigest, acceptedHeads: heads },
  };
  const request = VerificationRequest.parse({ ...terms, key: verificationKey(terms) });
  const localBundle = await f.bundleOf(local);
  const integration = localBundle.integration;
  if (integration === undefined) throw new Error('The local settlement has no integration record');
  const signed = { signature: `${'A'.repeat(86)}==`, evidence: { version: 1, hostVersion: 'exarchos-verifier/1', signerId: '5'.repeat(64), request,
    requestDigest: verificationDigest(request), hostPolicyDigest: '6'.repeat(64), completedAt: integration.observedAt,
    resources: [{ path: f.scope.checkout, device: '64768', inode: '1835041' }, { path: f.scope.repository, device: '64768', inode: '1835044' }],
    outcome: { status: 'passed', exitCode: 0, reason: '', stdoutBase64: '', stderrBase64: '', check: { operation: 'integration-suite',
      run: { end: 'exited', exitCode: 0, stdout: '', stderr: '', outputDigest: createHash('sha256').update('').digest('hex') }, report: null } } } };
  const evidenceDigest = verificationValueDigest(signed);
  const events = f.events();
  const hostRef = await events.bundleStore.put(encodeSettlementBundle({ ...localBundle,
    integration: { ref: integration.ref, tip: integration.tip, observedAt: integration.observedAt, attemptBinding: attempt, suiteEvidenceDigest: evidenceDigest } }));
  const requestRef = await events.bundleStore.put(Buffer.from(verificationJson(request)));
  const binding = f.backend().bindSegmentInput(attempt, canonicalJson(IntegrationAttemptBindingV1Schema.parse({ version: 1, kind: 'settle-integration', request: requestRef })));
  const localRef = z.object({ bundleRefs: z.array(z.object({ digest: z.object({ value: z.string() }) })).min(1) }).parse(local.data).bundleRefs[0];
  const localDigest = localRef?.digest.value ?? '';
  const localEvidence = integration.suiteEvidenceDigest ?? '';
  const db = new Database(join(f.stateDir, 'exarchos.db'));
  try {
    const result = z.object({ idempotencyKey: z.string() }).parse(db.prepare('SELECT idempotencyKey FROM idempotency_claims WHERE streamId=? AND events_json=?')
      .get(SEGMENT_INPUT_CLAIM_STREAM, canonicalJson({ version: 1, digest: { algorithm: 'sha256', value: localEvidence } })));
    const prefix = result.idempotencyKey.replace(/:result:[0-9]+$/, '');
    expect(db.prepare('DELETE FROM idempotency_claims WHERE streamId=? AND (idempotencyKey=? OR idempotencyKey LIKE ?)')
      .run(SEGMENT_INPUT_CLAIM_STREAM, f.attemptId(batchId, tip, ['root']), `${prefix}:%`).changes).toBe(3);
    expect(db.prepare('UPDATE idempotency_claims SET events_json=replace(events_json,?,?) WHERE streamId=? AND idempotencyKey=? AND instr(events_json,?)>0')
      .run(localDigest, hostRef.value, DECIDE_ONCE_CLAIM_STREAM, outerOperationId, localDigest).changes).toBe(1);
    expect(db.prepare("UPDATE events SET data=replace(data,?,?),payload=replace(payload,?,?) WHERE streamId=? AND type='execution.settled' AND instr(data,?)>0")
      .run(localDigest, hostRef.value, localDigest, hostRef.value, f.stream, localDigest).changes).toBe(1);
  } finally { db.close(); }
  await unlink(join(f.stateDir, 'run-bundles', 'sha256', localEvidence.slice(0, 2), localEvidence.slice(2)));
  await f.restart();
  return { attempt, binding, evidenceDigest, observedAt: integration.observedAt, localDigest, hostDigest: hostRef.value };
}

describe('compiler 8-vcs settlement', () => {
  /**
   * A real landing on the integration ref accepts at its tip, and the replay reads the receipt before any Git read or suite run.
   * The bundle names the attempt binding and the digest of the stored local suite observation.
   */
  it('SettleIntegration_HarnessLanding_AcceptsAtTheTipAndReplaysTerminally', async () => {
    const f = await fixture({ root: [] });
    expect(f.capsule.provenance.compilerVersion).toBe('exarchos-prepare-8-vcs');
    expect(f.capsule.settlementContract.integration).toEqual({ ref: 'refs/heads/integration' });
    const tip = await f.land('root');
    const result = await f.settle(['root'], 'landed');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: ['root'], findings: [] });
    expect(await f.standing('root')).toBe('accepted');
    expect(await f.suiteTips()).toEqual([tip]);
    expect(await f.boundRequest('landed', tip, ['root'])).toMatchObject({ streamId: f.stream, ref: 'refs/heads/integration', tip,
      acceptedHeads: [f.heads.get('root')], checkout: f.scope.checkout, repository: f.scope.repository, configDigest: f.scope.configDigest });
    const bundle = await f.bundleOf(result);
    expect(bundle.integration).toMatchObject({ ref: 'refs/heads/integration', tip, attemptBinding: f.attemptId('landed', tip, ['root']) });
    const evidence = bundle.integration?.suiteEvidenceDigest;
    expect(evidence).toMatch(/^[a-f0-9]{64}$/);
    const observation = JSON.parse((await f.events().bundleStore.resolve({ algorithm: 'sha256', value: evidence ?? '' })).toString('utf8'));
    expect(observation).toMatchObject({ version: 1, root: f.scope.checkout, tree: 'unchanged',
      legs: [{ argv: ['node', 'command.cjs', 'integration'], end: 'exited', exitCode: 0 }] });
    const before = await f.rows();
    await f.commitOnIntegration('later.txt');
    const replay = await f.settle(['root'], 'landed');
    expect(replay).toEqual(result);
    expect(await f.suiteTips()).toEqual([tip]);
    expect(await f.rows()).toEqual(before);
  }, 120000);

  /**
   * The integration checkout of the capsule scope must hold the integration ref. A checkout on another branch refuses before any claim, segment or row.
   * A checkout with uncommitted changes refuses in the executor before the suite starts. Neither records a settlement or runs the suite.
   */
  it('SettleIntegration_WrongCheckoutOrDirtyCheckout_RefusesBeforeAnyClaim', async () => {
    const f = await fixture({ root: [] });
    const tip = await f.land('root');
    const before = await f.rows();
    await git(f.scope.checkout, 'checkout', '-q', '-b', 'elsewhere');
    const wrong = await f.settle(['root'], 'wrong');
    expect(wrong, JSON.stringify(wrong)).toMatchObject({ success: false, error: { code: 'INTEGRATION_REFUSED' } });
    expect(wrong.error?.message).toContain('does not hold refs/heads/integration');
    expect(await f.rows()).toEqual(before);
    expect(f.backend().lookupSegmentInput(f.attemptId('wrong', tip, ['root']))).toBeUndefined();
    await git(f.scope.checkout, 'checkout', '-q', 'integration');
    await writeFile(join(f.scope.checkout, 'stray.txt'), 'not committed\n');
    const dirty = await f.settle(['root'], 'dirty');
    expect(dirty, JSON.stringify(dirty)).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED' } });
    expect(dirty.error?.message).toContain('uncommitted changes');
    expect(settled(await f.rows())).toEqual([]);
    expect(await f.suiteTips()).toEqual([]);
    for (const batchId of ['wrong', 'dirty']) {
      expect(f.backend().lookupOperationClaim(settlementClaimKey(f.stream, { ...f.capsule.identity, batchId }))).toBeUndefined();
    }
  }, 120000);

  /** A task head that the tip does not contain gives the verification-failed finding from the observation, with no suite run. */
  it('SettleIntegration_UnmergedHead_FailsWithNoSuiteRequest', async () => {
    const f = await fixture({ root: [] });
    const tip = await git(f.scope.checkout, 'rev-parse', 'HEAD');
    const result = await f.settle(['root'], 'unmerged');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: [], unresolved: [{ taskId: 'root', cause: 'verification-failed' }],
      findings: [{ kind: 'verification-failed', subject: 'root', at: 'settlementContract.integration.ref' }] });
    expect(JSON.stringify(result.data)).toContain('does not contain the accepted head');
    expect(await f.suiteTips()).toEqual([]);
    expect(f.backend().lookupSegmentInput(f.attemptId('unmerged', tip, ['root']))).toBeUndefined();
    const bundle = await f.bundleOf(result);
    expect(bundle.integration).toMatchObject({ ref: 'refs/heads/integration', tip });
    expect(bundle.integration?.attemptBinding).toBeUndefined();
    expect(bundle.integration?.suiteEvidenceDigest).toBeUndefined();
    expect(await f.standing('root')).not.toBe('accepted');
  }, 120000);

  /**
   * An unresolved capsule suite gives the verification-failed finding with the unresolved reason.
   * It runs no suite, binds nothing and commits a receipt that a second call replays with no Git read or suite run.
   */
  it('SettleIntegration_UnresolvedSuite_FailsWithNoSuiteRunAndReplays', async () => {
    const f = await fixture({ root: [] }, { suite: false });
    expect(f.profile.integration.command.state).toBe('unresolved');
    const tip = await f.land('root');
    const result = await f.settle(['root'], 'unresolved');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: [], findings: [{ kind: 'verification-failed', subject: 'root' }] });
    expect(JSON.stringify(result.data)).toContain('profile-unresolved');
    expect(await f.suiteTips()).toEqual([]);
    expect(f.backend().lookupSegmentInput(f.attemptId('unresolved', tip, ['root']))).toBeUndefined();
    expect(settled(await f.rows())).toHaveLength(1);
    const bundle = await f.bundleOf(result);
    expect(bundle.integration).toMatchObject({ ref: 'refs/heads/integration', tip });
    expect(bundle.integration?.attemptBinding).toBeUndefined();
    const replay = await f.settle(['root'], 'unresolved');
    expect(replay).toEqual(result);
    expect(await f.suiteTips()).toEqual([]);
  }, 120000);

  /** A red suite at the landed tip gives the verification-failed finding and keeps the attempt binding and the observation digest. */
  it('SettleIntegration_RedSuite_FailsAtTheTip', async () => {
    const f = await fixture({ root: [] });
    await f.land('root');
    const tip = await f.commitOnIntegration('FAIL');
    const result = await f.settle(['root'], 'red');
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ acceptedTasks: [], findings: [{ kind: 'verification-failed', subject: 'root' }] });
    expect(JSON.stringify(result.data)).toContain('verdict fail');
    expect(await f.suiteTips()).toEqual([tip]);
    const bundle = await f.bundleOf(result);
    expect(bundle.integration).toMatchObject({ tip, attemptBinding: f.attemptId('red', tip, ['root']) });
    expect(bundle.integration?.suiteEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  }, 120000);

  /**
   * A suite that leaves the integration checkout changed is no evidence of the tip. The call commits nothing, and a retry of the attempt replays the refusal.
   * A new batch binds a new attempt and accepts.
   */
  it('SettleIntegration_ASuiteThatChangesTheCheckout_CommitsNothing', async () => {
    const f = await fixture({ root: [] });
    await f.land('root');
    await writeFile(join(f.scope.checkout, 'command.cjs'), `${COMMAND}if(process.argv[2]==='integration')fs.writeFileSync('leftover.txt','x');`);
    await git(f.scope.checkout, 'commit', '-q', '-am', 'a suite that leaves a file');
    const tip = await git(f.scope.checkout, 'rev-parse', 'HEAD');
    const changed = await f.settle(['root'], 'changed');
    expect(changed, JSON.stringify(changed)).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED' } });
    expect(changed.error?.message).toContain('changed the working directory');
    expect(settled(await f.rows())).toEqual([]);
    expect(await f.standing('root')).not.toBe('accepted');
    await rmrfAsync(join(f.scope.checkout, 'leftover.txt'));
    const again = await f.settle(['root'], 'changed');
    expect(again).toEqual(changed);
    expect(await f.suiteTips()).toEqual([tip]);
  }, 120000);

  /** A landing during the suite gives one fresh attempt at the new tip. A second move in one call refuses with no commit. */
  it('SettleIntegration_MovedTip_OneFreshAttemptThenRetryableRefusal', async () => {
    const f = await fixture({ root: [] });
    await f.land('root');
    await f.queue('commit');
    const moved = await f.settle(['root'], 'moved');
    expect(moved.success, JSON.stringify(moved)).toBe(true);
    expect(moved.data).toMatchObject({ acceptedTasks: ['root'] });
    const tips = await f.suiteTips();
    expect(tips).toHaveLength(2);
    expect(new Set(tips).size).toBe(2);
    expect((await f.bundleOf(moved)).integration?.tip).toBe(tips[1]);

    const g = await fixture({ root: [] });
    await g.land('root');
    await g.queue('commit', 'commit');
    const twice = await g.settle(['root'], 'twice');
    expect(twice, JSON.stringify(twice)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(twice.error?.message).toContain('moved twice');
    expect(settled(await g.rows())).toEqual([]);
    expect(await g.suiteTips()).toHaveLength(2);
    const after = await g.settle(['root'], 'twice');
    expect(after.success, JSON.stringify(after)).toBe(true);
    expect(after.data).toMatchObject({ acceptedTasks: ['root'] });
    expect(await g.suiteTips()).toHaveLength(3);
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
    const held = await f.settle(['child'], 'held', { deviations: [{ deviationKind: 'missing-context', statement: 'The child needs a decision.' }] });
    expect(held.success, JSON.stringify(held)).toBe(true);
    expect(held.data).toMatchObject({ outcome: 'deviation-pending', findings: [{ kind: 'deviation-awaiting-approval' }] });
    expect(await f.suiteTips()).toHaveLength(1);
    expect(await f.standing('child')).not.toBe('accepted');
    const tip = await f.land('child');
    const child = await f.settle(['child'], 'child');
    expect(child.data, JSON.stringify(child)).toMatchObject({ acceptedTasks: ['child'] });
    expect((await f.suiteTips()).at(-1)).toBe(tip);
    expect(await f.boundRequest('child', tip, ['root', 'child'])).toMatchObject({ tip,
      acceptedHeads: [f.heads.get('root'), f.heads.get('child')].sort() });

    const g = await fixture({ root: [] });
    const base = await git(g.scope.checkout, 'rev-parse', 'HEAD');
    await g.land('root');
    await g.queue(`reset ${base}`);
    const fenced = await g.settle(['root'], 'fenced');
    expect(fenced.success, JSON.stringify(fenced)).toBe(true);
    expect(fenced.data).toMatchObject({ acceptedTasks: [], findings: [{ kind: 'verification-failed', subject: 'root' }] });
    expect((await g.bundleOf(fenced)).integration).toMatchObject({ tip: base });
    expect((await g.bundleOf(fenced)).integration?.attemptBinding).toBeUndefined();
    expect(await g.suiteTips()).toHaveLength(1);
  }, 240000);

  /** A terminal receipt of compiler 8 replays unchanged, and its capsule pins no integration term, so no suite runs at a tip. */
  it('SettleIntegration_OldCompilerEightReceipt_ReplaysUnchanged', async () => {
    const f = await fixture({ root: [] }, { compilerVersion: 'exarchos-prepare-8' });
    expect(f.capsule.provenance.compilerVersion).toBe('exarchos-prepare-8');
    expect(f.capsule.settlementContract.integration).toBeUndefined();
    const original = await f.settle(['root'], 'history');
    expect(original.success, JSON.stringify(original)).toBe(true);
    expect(original.data).toMatchObject({ acceptedTasks: ['root'] });
    expect((await f.bundleOf(original)).integration).toBeUndefined();
    expect(await f.settle(['root'], 'history')).toEqual(original);
    expect(await f.settle(['root'], 'history')).toEqual(original);
    expect(await f.suiteTips()).toEqual([]);
  }, 120000);

  /**
   * A settlement that the retired verifier host judged reads with its original result. Its bundle names the host attempt and the host evidence digest.
   * The replay returns the stored receipt and records nothing. It runs no suite, starts no claim and reads no evidence body.
   * The stored task standing and the rehydrated document read the same as the local settlement at the same tip.
   */
  it('SettleIntegration_HostEraReceipt_ReplaysUnchanged', async () => {
    const f = await fixture({ root: [] });
    const tip = await f.land('root');
    const local = await f.settle(['root'], 'host-era');
    expect(local.success, JSON.stringify(local)).toBe(true);
    const localDocument = await handleRehydrate({ featureId: f.stream }, { eventStore: f.events(), stateDir: f.stateDir });
    const host = await toHostEra(f, local, 'host-era', tip);
    await f.commitOnIntegration('later.txt');
    const before = durableSnapshot(f.stateDir);
    const put = vi.spyOn(f.events().bundleStore, 'put');
    const replay = await f.settle(['root'], 'host-era');
    expect(replay).toEqual(JSON.parse(JSON.stringify(local).split(host.localDigest).join(host.hostDigest)));
    expect(await f.settle(['root'], 'host-era')).toEqual(replay);
    const bundle = await f.bundleOf(replay);
    expect(bundle.integration).toEqual({ ref: 'refs/heads/integration', tip, observedAt: host.observedAt, attemptBinding: host.attempt, suiteEvidenceDigest: host.evidenceDigest });
    expect(await f.events().bundleStore.has({ algorithm: 'sha256', value: host.evidenceDigest })).toBe('missing');
    expect(f.backend().lookupSegmentInput(host.attempt)).toBe(host.binding);
    expect(f.backend().lookupSegmentInput(f.attemptId('host-era', tip, ['root']))).toBeUndefined();
    expect(await f.standing('root')).toBe('accepted');
    expect(durableSnapshot(f.stateDir)).toEqual(before);
    expect(put).not.toHaveBeenCalled();
    expect(await f.suiteTips()).toEqual([tip]);
    const hostDocument = await handleRehydrate({ featureId: f.stream }, { eventStore: f.events(), stateDir: f.stateDir });
    expect(withoutReadClock(hostDocument)).toBe(withoutReadClock(localDocument));
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

  /**
   * An attempt that stops after its suite leg and before its terminal observation commits nothing and stays incomplete.
   * After a restart of the store, the same call finds the binding, records the attempt as incomplete, runs the suite once more and admits.
   * A third call replays the receipt with no suite run.
   */
  it('SettleIntegration_CrashAfterTheClaim_RunsTheIncompleteAttemptAgainAfterARestart', async () => {
    const f = await fixture({ root: [] });
    const tip = await f.land('root');
    crash.afterSuite = true;
    const crashed = await f.settle(['root'], 'restart').catch((error: unknown) => error);
    expect(JSON.stringify(crashed) + String(crashed)).toContain('stopped the attempt after its suite leg');
    expect(settled(await f.rows())).toEqual([]);
    const binding = f.backend().lookupSegmentInput(f.attemptId('restart', tip, ['root']));
    expect(binding).toBeDefined();
    expect(await f.suiteTips()).toEqual([tip]);
    crash.afterSuite = false;
    await f.restart();
    const recovered = await f.settle(['root'], 'restart');
    expect(recovered.success, JSON.stringify(recovered)).toBe(true);
    expect(recovered.data).toMatchObject({ acceptedTasks: ['root'] });
    expect(await f.suiteTips()).toEqual([tip, tip]);
    expect(f.backend().lookupSegmentInput(f.attemptId('restart', tip, ['root']))).toBe(binding);
    expect(await f.settle(['root'], 'restart')).toEqual(recovered);
    expect(await f.suiteTips()).toEqual([tip, tip]);
  }, 120000);
});
