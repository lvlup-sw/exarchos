/**
 * Parity tests for `prepare` and `settle` between the CLI and the MCP transport.
 *
 * Both transports use one state directory, so a call on the second transport is a retry of the call on the first.
 * A retry returns the recorded receipt, and the two envelopes must be equal after `normalize`.
 * The `orchestrate.prepare`, `orchestrate.settle` and `orchestrate.refusal` entries of `PARITY_CONTRACT` name the fields to compare.
 * Each envelope key that the entry does not name fails the test.
 *
 * The fixture is a real repository with one low-tier task on its own worktree, so `settle` runs only the static-analysis gate.
 * The MCP server stops before the CLI starts, so the two processes do not open the store at the same time.
 *
 * The cases test the `exarchos` binary on PATH. `npm run test:files` builds the binary of the tree and puts it first on PATH.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ContentDigestV1Schema } from '../../src/workflow/admission/types.js';
import { RunBundleStore } from '../../src/events/bundle/run-bundle-store.js';
import { decodeExecuteIntentBundle } from '../../src/verbs/execute/run-bundle.js';
import { decodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { SettlementReceiptData } from '../../src/verbs/settle/schemas.js';
import { STORE_DB_FILENAME } from '../../src/utils/paths.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { runCli } from '../helpers/cli-runner.js';
import { withHermeticEnv, type HermeticEnv } from '../helpers/hermetic.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { extractEnvelope } from '../helpers/mcp-envelope.js';
import { normalize } from '../helpers/normalizers.js';
import { PARITY_CONTRACT, assertParity } from '../helpers/parity-contract.js';
import { scopedRepository, type FixtureFiles } from '../helpers/scoped-repository.js';
import { releaseCheckDefinition } from '../helpers/definitions/user-definition.js';
import { task, textOf } from '../helpers/capsule/prepared-authority.js';

const TASK = 'task-1';
const BATCH = 'batch-1';
const INTEGRATION_BRANCH = 'integration';
/** The path of the plan under the checkout. The `plan-review` transition needs it, and `prepare` reads it as the design record. */
const PLAN_PATH = 'docs/specs/plan.md';
/** The cheapest npm script that exits 0. */
const OK = 'node -e ""';
/** A Node project that the static-analysis gate passes. */
const PROJECT: FixtureFiles = {
  'package.json': JSON.stringify(
    { name: 'parity-prepare-settle', private: true, scripts: { lint: OK, typecheck: OK, 'quality-check': OK } },
    null,
    2,
  ),
  [PLAN_PATH]: '# Plan\n',
};
/** A case spawns the server up to three times, and one settle runs the gate. */
const CASE_TIMEOUT_MS = 60_000;

type Envelope = Readonly<Record<string, unknown>>;

/** The facts of one case: the state directory, the workflow and the worktree of its task. */
interface Fixture {
  readonly env: HermeticEnv;
  readonly featureId: string;
  readonly worktree: string;
}

function isRecord(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Starts an MCP server on the state directory, runs `work` and stops the server, also when `work` throws. */
async function withMcp<T>(env: HermeticEnv, work: (call: (tool: string, args: Envelope) => Promise<Envelope>) => Promise<T>): Promise<T> {
  const mcp = await spawnMcpClient({ stateDir: env.stateDir });
  try {
    return await work(async (tool, args) => {
      const envelope = extractEnvelope(await mcp.client.callTool({ name: tool, arguments: { ...args } }));
      if (!isRecord(envelope)) throw new Error(`${tool} returned no object: ${JSON.stringify(envelope)}`);
      return envelope;
    });
  } finally {
    await mcp.terminate();
  }
}

/** Runs one CLI command with `--json` on the state directory and returns its exit code and the envelope on stdout. */
async function cli(env: HermeticEnv, args: readonly string[]): Promise<{ exitCode: number; envelope: Envelope }> {
  const result = await runCli({
    args: [...args, '--json'],
    env: { WORKFLOW_STATE_DIR: env.stateDir, EXARCHOS_STATE_DIR: env.stateDir },
    timeout: CASE_TIMEOUT_MS,
  });
  const envelope: unknown = JSON.parse(result.stdout);
  if (!isRecord(envelope)) throw new Error(`the CLI printed no object: ${result.stdout}`);
  return { exitCode: result.exitCode, envelope };
}

/**
 * Compares two envelopes on the fields of one contract entry, after `normalize`.
 * Each top-level key of the two envelopes must be in the entry, as a field to compare or as a field that can differ.
 */
function expectParity(cliEnvelope: Envelope, mcpEnvelope: Envelope, action: string): void {
  const spec = PARITY_CONTRACT.find((entry) => entry.action === action);
  if (spec === undefined) throw new Error(`PARITY_CONTRACT has no entry for ${action}`);
  const named = new Set([...spec.fieldsRequiringEquality, ...spec.fieldsAllowedToDiffer].map((field) => field.split('.')[0]));
  const unnamed = [...Object.keys(cliEnvelope), ...Object.keys(mcpEnvelope)].filter((key) => !named.has(key));
  expect(unnamed, `envelope keys that ${action} does not name`).toEqual([]);
  assertParity(normalize(cliEnvelope), normalize(mcpEnvelope), spec);
}

/** The `data` of a successful envelope. Any other envelope fails the case and shows the envelope. */
function dataOf(envelope: Envelope): Envelope {
  if (envelope.success !== true || !isRecord(envelope.data)) throw new Error(`the call failed: ${JSON.stringify(envelope)}`);
  return envelope.data;
}

/** Read the immutable operation claims of this isolated stream. */
function operationClaims(fixture: Fixture): unknown[] {
  const database = new Database(path.join(fixture.env.stateDir, STORE_DB_FILENAME), { readonly: true });
  try {
    return database.prepare(
      "SELECT idempotencyKey, eventIds, sequences, timestamps, events_json FROM idempotency_claims WHERE json_extract(events_json, '$.streamId') = ? ORDER BY idempotencyKey",
    ).all(fixture.featureId);
  } finally {
    database.close();
  }
}

/** The claim that the task is complete in its worktree. */
function claimsOf(worktree: string): Envelope[] {
  return [{ taskId: TASK, fields: { worktreePath: worktree, files: [`src/${TASK}.ts`] }, evidence: [] }];
}

/** The arguments of the settle of the batch, for the MCP call. */
function settleCall(fixture: Fixture, capsuleVersion: number): Envelope {
  return { action: 'settle', featureId: fixture.featureId, capsuleVersion, batchId: BATCH, claims: claimsOf(fixture.worktree) };
}

/** The same settle as `settleCall`, as CLI arguments. */
function settleArgs(fixture: Fixture, capsuleVersion: number): string[] {
  const claims = JSON.stringify(claimsOf(fixture.worktree));
  return ['orchestrate', 'settle', '--feature-id', fixture.featureId, '--capsule-version', String(capsuleVersion), '--batch-id', BATCH, '--claims', claims];
}

/**
 * Makes the repository and the worktree of the task. Then it takes a feature workflow to `delegate` over MCP,
 * with the task in the plan. The callback runs after the server stops. The cleanup deletes the repository.
 */
async function withDelegatingWorkflow(work: (fixture: Fixture, checkout: string) => Promise<void>): Promise<void> {
  await withHermeticEnv(async (env) => {
    const repository = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: PROJECT });
    try {
      const fixture: Fixture = { env, featureId: `parity-prepare-settle-${env.testId.slice(0, 8)}`, worktree: await repository.worktreeFor(TASK) };
      await withMcp(env, async (call) => {
        const workflow = async (action: string, fields: Envelope): Promise<void> => {
          dataOf(await call('exarchos_workflow', { action, featureId: fixture.featureId, ...fields }));
        };
        await workflow('init', { workflowType: 'feature' });
        await workflow('update', { updates: { 'artifacts.plan': PLAN_PATH } });
        await workflow('transition', { target: 'plan-review' });
        await workflow('update', { updates: { planReview: { approved: true } } });
        await workflow('transition', { target: 'delegate' });
        await workflow('update', {
          updates: {
            'synthesis.integrationBranch': INTEGRATION_BRANCH,
            tasks: [{ id: TASK, title: 'the task', status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false }],
          },
        });
      });
      await work(fixture, repository.checkout);
    } finally {
      await rmrfAsync(repository.root);
    }
  });
}

/** Prepares the batch of the fixture over MCP and returns the envelope and its capsule version. */
async function prepareOverMcp(fixture: Fixture, checkout: string): Promise<{ envelope: Envelope; capsuleVersion: number }> {
  const envelope = await withMcp(fixture.env, (call) => call('exarchos_orchestrate', { action: 'prepare', featureId: fixture.featureId, repoRoot: checkout }));
  const { capsuleVersion } = dataOf(envelope);
  if (typeof capsuleVersion !== 'number') throw new Error(`prepare returned no capsule version: ${JSON.stringify(envelope)}`);
  return { envelope, capsuleVersion };
}

/** The number of rows of one type on the stream of the workflow, read through the CLI. */
async function rowCount(fixture: Fixture, type: string): Promise<number> {
  const filter = JSON.stringify({ type });
  const { page } = dataOf((await cli(fixture.env, ['event', 'query', '--stream', fixture.featureId, '--filter', filter, '--fields', 'type'])).envelope);
  if (!isRecord(page) || typeof page.total !== 'number') throw new Error(`the event query returned no page: ${JSON.stringify(page)}`);
  return page.total;
}

/** Starts each test with an empty stream and an approved typed file in a real checkout. */
async function withBootstrapRepository(
  work: (env: HermeticEnv, checkout: string, designDigest: string) => Promise<void>,
): Promise<void> {
  await withHermeticEnv(async (env) => {
    const text = textOf([task('T-01', { testFiles: ['tests/task.test.ts'] })]);
    const repository = await scopedRepository({
      integrationBranch: INTEGRATION_BRANCH,
      files: {
        ...PROJECT,
        'package.json': JSON.stringify({
          scripts: { lint: OK, typecheck: OK, 'test:files': OK, 'test:run': OK },
        }),
        [PLAN_PATH]: text,
        '.exarchos/workflows/release-check.json': JSON.stringify({ ...releaseCheckDefinition(), entryStepId: 'build' }),
      },
    });
    try {
      const captured = await readFile(path.join(repository.checkout, PLAN_PATH));
      await work(env, repository.checkout, createHash('sha256').update(captured).digest('hex'));
    } finally {
      await rmrfAsync(repository.root);
    }
  });
}

function bootstrapCalls(featureId: string, checkout: string, designDigest: string, workflowType = 'feature') {
  const intent = {
    mode: 'bootstrap', workflowType, baseRef: INTEGRATION_BRANCH, designRef: PLAN_PATH,
    approval: { decision: 'approved', designDigest },
  };
  return {
    mcp: { action: 'prepare', featureId, repoRoot: checkout, intent },
    cli: ['orchestrate', 'prepare', '--feature-id', featureId, '--repo-root', checkout, '--intent', JSON.stringify(intent)],
  };
}

describe('packaged bootstrap parity', () => {
  it.each(['mcp', 'cli'] as const)('Prepare_BootstrapStartsOn_%s_AndReplaysOnTheOtherTransport', async (firstTransport) => {
    await withBootstrapRepository(async (env, checkout, digest) => {
      const featureId = 'parity-bootstrap';
      const args = bootstrapCalls(featureId, checkout, digest);
      const onMcp = () => withMcp(env, (call) => call('exarchos_orchestrate', args.mcp));
      const onCli = async () => {
        const result = await cli(env, args.cli);
        expect(result.exitCode, JSON.stringify(result.envelope)).toBe(0);
        return result.envelope;
      };
      const first = await (firstTransport === 'mcp' ? onMcp() : onCli());
      const original = dataOf(first);
      expect(original).toMatchObject({
        streamId: featureId, capsuleVersion: 1,
        capsule: {
          graph: { tasks: [{ taskId: 'T-01', stepId: 'delegate' }] },
          provenance: { compilerVersion: 'exarchos-prepare-8' },
        },
      });
      await unlink(path.join(checkout, PLAN_PATH));
      const replay = await (firstTransport === 'mcp' ? onCli() : onMcp());
      expect(dataOf(replay)).toEqual(original);
      expectParity(first, replay, 'orchestrate.prepare');
      const fixture = { env, featureId, worktree: checkout };
      for (const type of ['workflow.started', 'task.assigned', 'workflow.prepared']) {
        expect(await rowCount(fixture, type), type).toBe(1);
      }
      const { events } = dataOf((await cli(env, ['event', 'query', '--stream', featureId, '--filter', '{"type":"workflow.started"}'])).envelope);
      expect(events).toMatchObject([{ schemaVersion: '1.1', data: { initialPhase: 'plan' } }]);
    });
  }, CASE_TIMEOUT_MS);

  it('Prepare_BootstrapApprovalRefusal_MatchesAcrossTransports', async () => {
    await withBootstrapRepository(async (env, checkout) => {
      const featureId = 'parity-refused-bootstrap';
      const args = bootstrapCalls(featureId, checkout, '0'.repeat(64));
      const mcp = await withMcp(env, (call) => call('exarchos_orchestrate', args.mcp));
      const command = await cli(env, args.cli);
      expect(mcp).toMatchObject({ success: false, error: { code: 'DESIGN_APPROVAL_MISMATCH' } });
      expect(command.exitCode).not.toBe(0);
      expectParity(command.envelope, mcp, 'orchestrate.refusal');
      const fixture = { env, featureId, worktree: checkout };
      for (const type of ['workflow.started', 'task.assigned', 'workflow.prepared']) {
        expect(await rowCount(fixture, type), type).toBe(0);
      }
    });
  }, CASE_TIMEOUT_MS);

  it('Prepare_PublicationFailure_RepairsOnTheOtherTransport', async () => {
    await withBootstrapRepository(async (env, checkout, digest) => {
      const featureId = 'parity-publication';
      const args = bootstrapCalls(featureId, checkout, digest);
      const fixture = { env, featureId, worktree: checkout };
      expect(await rowCount(fixture, 'workflow.started')).toBe(0);
      const dbFile = path.join(env.stateDir, STORE_DB_FILENAME);
      const database = new Database(dbFile);
      try {
        database.exec(`
          CREATE TRIGGER reject_bootstrap_document BEFORE INSERT ON workflow_state
          WHEN NEW.featureId = 'parity-publication'
          BEGIN SELECT RAISE(ABORT, 'fixture publication failure'); END
        `);
      } finally {
        database.close();
      }

      const refused = await cli(env, args.cli);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.envelope).toMatchObject({
        success: false, error: { code: 'STATE_SYNC_FAILED', message: expect.stringContaining('fixture publication failure') },
      });
      const inspect = new Database(dbFile);
      let claim: unknown;
      try {
        expect(inspect.prepare('SELECT version FROM workflow_state WHERE featureId = ?').get(featureId)).toBeUndefined();
        const claims = inspect.prepare(
          "SELECT events_json FROM idempotency_claims WHERE json_extract(events_json, '$.streamId') = ?",
        ).all(featureId) as { events_json: string }[];
        expect(claims).toHaveLength(1);
        const [stored] = claims;
        if (stored === undefined) throw new Error('Missing bootstrap operation claim');
        claim = JSON.parse(stored.events_json);
        inspect.exec('DROP TRIGGER reject_bootstrap_document');
      } finally {
        inspect.close();
      }
      if (!isRecord(claim) || !isRecord(claim.result)) throw new Error('Missing bootstrap operation claim');
      const accepted = claim.result;
      expect(accepted).toMatchObject({
        operationId: expect.stringMatching(/^prepare:/), capsuleVersion: 1, capsuleDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      for (const term of [accepted.operationId, accepted.capsuleDigest, featureId]) {
        if (typeof term !== 'string') throw new Error('Missing accepted capsule identity');
        expect(refused.envelope.error).toMatchObject({ message: expect.stringContaining(term) });
      }
      const recovered = await withMcp(env, (call) => call('exarchos_orchestrate', args.mcp));
      expect(dataOf(recovered)).toEqual(accepted);
      const replay = await cli(env, args.cli);
      expect(replay.exitCode).toBe(0);
      expectParity(replay.envelope, recovered, 'orchestrate.prepare');
      for (const type of ['workflow.started', 'task.assigned', 'workflow.prepared']) {
        expect(await rowCount(fixture, type), type).toBe(1);
      }
      const repaired = new Database(dbFile, { readonly: true });
      try {
        const document = repaired.prepare('SELECT state FROM workflow_state WHERE featureId = ?').get(featureId) as { state: string } | undefined;
        if (document === undefined) throw new Error('Missing repaired workflow document');
        const tail = repaired.prepare('SELECT MAX(sequence) AS sequence FROM events WHERE streamId = ?').get(featureId) as { sequence: number };
        const state: unknown = JSON.parse(document.state);
        expect(state).toMatchObject({ phase: 'delegate' });
        if (!isRecord(state) || typeof state._eventSequence !== 'number' || typeof accepted.tailSequence !== 'number') {
          throw new Error('Missing accepted or published sequence');
        }
        expect(state._eventSequence).toBeGreaterThanOrEqual(accepted.tailSequence);
        expect(state._eventSequence).toBeLessThanOrEqual(tail.sequence);
        const later = repaired.prepare('SELECT type, data FROM events WHERE streamId = ? AND sequence > ?').all(
          featureId, state._eventSequence,
        ) as { type: string; data: string }[];
        for (const row of later) {
          expect(row.type).toBe('gate.executed');
          expect(JSON.parse(row.data)).toMatchObject({ gateName: 'event-emissions' });
        }
        const operations = repaired.prepare(
          "SELECT COUNT(*) AS count FROM idempotency_claims WHERE json_extract(events_json, '$.streamId') = ?",
        ).get(featureId);
        expect(operations).toEqual({ count: 1 });
      } finally {
        repaired.close();
      }
    });
  }, CASE_TIMEOUT_MS);

  it('Dispatch_ColdUserType_UsesRecordedEntry', async () => {
    await withBootstrapRepository(async (env, checkout, digest) => {
      const featureId = 'cold-release-check';
      const args = bootstrapCalls(featureId, checkout, digest, 'release-check');
      const prepared = await cli(env, args.cli);
      expect(prepared.exitCode, JSON.stringify(prepared.envelope)).toBe(0);
      expect(dataOf(prepared.envelope)).toMatchObject({
        capsule: { graph: { tasks: [{ taskId: 'T-01', stepId: 'build' }] } },
      });
      await unlink(path.join(checkout, '.exarchos/workflows/release-check.json'));
      const fixture = { env, featureId, worktree: checkout };
      expect(await rowCount(fixture, 'workflow.transition')).toBe(0);
      await withMcp(env, async (call) => {
        const status = await call('exarchos_view', { action: 'workflow_status', workflowId: featureId, asOf: { untilSequence: 1 } });
        expect(dataOf(status)).toMatchObject({ featureId, workflowType: 'release-check', phase: 'build' });
        const pipeline = await call('exarchos_view', { action: 'pipeline', scope: 'all', detail: true });
        expect(dataOf(pipeline)).toMatchObject({ workflows: [{ featureId, workflowType: 'release-check', phase: 'build' }] });
        const rehydrated = await call('exarchos_workflow', { action: 'rehydrate', featureId });
        expect(dataOf(rehydrated)).toMatchObject({ workflowState: { featureId, workflowType: 'release-check', phase: 'build' } });
      });
    });
  }, CASE_TIMEOUT_MS);
});

describe('parity: exarchos orchestrate prepare and settle — CLI ↔ MCP', () => {
  it('Prepare_TypedMcpIntentAndCliFlag_ReplayOneAcceptedCapsule', async () => {
    await withDelegatingWorkflow(async (fixture, checkout) => {
      const text = textOf([task('T-01', { title: 'Misleading task 999' })]);
      await writeFile(path.join(checkout, PLAN_PATH), text);
      const designDigest = createHash('sha256').update(text).digest('hex');
      const intent = { mode: 'compile', designRef: PLAN_PATH, approval: { decision: 'approved', designDigest } };
      const subject = { featureId: fixture.featureId, repoRoot: checkout };
      const prepared = await withMcp(fixture.env, async (call) => {
        const legacyIntent = await call('exarchos_orchestrate', { action: 'prepare', ...subject, intent: 'task-completion' });
        expect(legacyIntent).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
        const typedRunbook = await call('exarchos_orchestrate', { action: 'execute_intent', intent, args: {} });
        expect(typedRunbook).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
        return call('exarchos_orchestrate', { action: 'prepare', ...subject, intent });
      });
      expect(dataOf(prepared)).toMatchObject({
        capsuleVersion: 1,
        capsule: {
          graph: { tasks: [{ taskId: 'T-01' }] },
          provenance: { sources: expect.arrayContaining([{ sourceId: 'design-record', digest: designDigest }]) },
          settlementContract: { skipPhases: [] },
        },
      });
      const retried = await cli(fixture.env, [
        'orchestrate', 'prepare', '--feature-id', fixture.featureId, '--repo-root', checkout, '--intent', JSON.stringify(intent),
      ]);
      expect(retried.exitCode).toBe(0);
      expectParity(retried.envelope, prepared, 'orchestrate.prepare');
      expect(await rowCount(fixture, 'workflow.prepared')).toBe(1);
    });
  }, CASE_TIMEOUT_MS);

  it('Prepare_TypedCliIntent_ReplaysOverMcp', async () => {
    await withDelegatingWorkflow(async (fixture, checkout) => {
      const designFile = path.join(checkout, PLAN_PATH);
      await writeFile(designFile, textOf([task('T-01', { title: 'Compile from the approved record' })]));
      const designDigest = createHash('sha256').update(await readFile(designFile)).digest('hex');
      const intent = { mode: 'compile', designRef: PLAN_PATH, approval: { decision: 'approved', designDigest } };
      const prepared = await cli(fixture.env, [
        'orchestrate', 'prepare', '--feature-id', fixture.featureId, '--repo-root', checkout, '--intent', JSON.stringify(intent),
      ]);
      expect(prepared.exitCode, JSON.stringify(prepared.envelope)).toBe(0);
      expect(dataOf(prepared.envelope)).toMatchObject({
        capsuleVersion: 1,
        capsule: { graph: { tasks: [{ taskId: 'T-01', stepId: 'delegate' }] } },
      });
      const replay = await withMcp(fixture.env, (call) => call('exarchos_orchestrate', {
        action: 'prepare', featureId: fixture.featureId, repoRoot: checkout, intent,
      }));
      expect(dataOf(replay)).toEqual(dataOf(prepared.envelope));
      expectParity(prepared.envelope, replay, 'orchestrate.prepare');
      expect(await rowCount(fixture, 'workflow.started')).toBe(1);
      expect(await rowCount(fixture, 'workflow.prepared')).toBe(1);
    });
  }, CASE_TIMEOUT_MS);

  /**
   * MCP compiles capsule v1. The same request on the CLI replays the claim of that compilation.
   * A second compilation gives capsule v2, so equal `data` shows that the CLI returned the recorded receipt.
   */
  it('prepare_cliRetryOfMcpPrepare_envelopesMatchAfterNormalize', async () => {
    await withDelegatingWorkflow(async (fixture, checkout) => {
      const prepared = await prepareOverMcp(fixture, checkout);
      expect(prepared.capsuleVersion).toBe(1);

      const retried = await cli(fixture.env, ['orchestrate', 'prepare', '--feature-id', fixture.featureId, '--repo-root', checkout]);
      expect(retried.exitCode).toBe(0);
      expectParity(retried.envelope, prepared.envelope, 'orchestrate.prepare');
    });
  }, CASE_TIMEOUT_MS);

  /**
   * The CLI settles the batch and runs its verification. The same request on MCP returns the receipt of the CLI.
   * The test asserts the verdict first, so parity does not pass on two equal refusals.
   */
  it('settle_mcpRetryOfCliSettle_envelopesMatchAfterNormalize', async () => {
    await withDelegatingWorkflow(async (fixture, checkout) => {
      const { capsuleVersion } = await prepareOverMcp(fixture, checkout);

      const settled = await cli(fixture.env, settleArgs(fixture, capsuleVersion));
      expect(settled.exitCode).toBe(0);
      expect(dataOf(settled.envelope)).toMatchObject({ outcome: 'settled', acceptedTasks: [TASK] });

      const retried = await withMcp(fixture.env, (call) => call('exarchos_orchestrate', settleCall(fixture, capsuleVersion)));
      expectParity(settled.envelope, retried, 'orchestrate.settle');
    });
  }, CASE_TIMEOUT_MS);

  /**
   * MCP settles the batch. A duplicate settle on each transport returns that decision.
   * The stream then holds one settlement record and one completion, so neither duplicate decided again.
   */
  it('settle_duplicateOnEachTransport_returnsThePriorDecision', async () => {
    await withDelegatingWorkflow(async (fixture, checkout) => {
      const { capsuleVersion, envelope: preparedEnvelope } = await prepareOverMcp(fixture, checkout);

      const [first, mcpDuplicate] = await withMcp(fixture.env, async (call) => [
        await call('exarchos_orchestrate', settleCall(fixture, capsuleVersion)),
        await call('exarchos_orchestrate', settleCall(fixture, capsuleVersion)),
      ]);
      expect(dataOf(first)).toMatchObject({ outcome: 'settled', acceptedTasks: [TASK] });
      const receipt = SettlementReceiptData.parse(dataOf(first));
      const bundleStore = RunBundleStore.forStateDir(fixture.env.stateDir);
      const ref = receipt.bundleRefs?.[0];
      if (ref === undefined) throw new Error('Missing settlement custody');
      const settlement = decodeSettlementBundle(await bundleStore.resolve(ContentDigestV1Schema.parse(ref.digest)));
      const trace = settlement.verification?.[0];
      const runRef = trace?.bundleRefs?.[0];
      if (trace === undefined || runRef === undefined) throw new Error('Missing segment custody');
      expect(trace).toMatchObject({ taskId: TASK, outcome: 'verified', treeCommit: expect.stringMatching(/^[a-f0-9]{40}$/) });
      const runBytes = await bundleStore.resolve(runRef.digest);
      const run = decodeExecuteIntentBundle(runBytes);
      expect(run).toMatchObject({ kind: 'execute-intent-run', bundleVersion: '1.0', intent: 'task-completion', outcome: 'committed' });
      expect(run.leaves.map(leaf => leaf.action)).toEqual([
        'check_test_adequacy', 'check_contract_drift', 'check_mock_boundary',
        'check_integration_suite', 'check_static_analysis', 'task_complete',
      ]);
      expect(run.leaves.slice(0, 4).map(leaf => leaf.args.baseBranch)).toEqual(Array(4).fill(INTEGRATION_BRANCH));
      expect(run.leaves.at(-1)?.args).toMatchObject({
        taskId: TASK, capsuleVersion, result: { worktreePath: fixture.worktree, files: [`src/${TASK}.ts`] },
      });
      expect(Object.hasOwn(run, 'args')).toBe(false);
      expect(Object.hasOwn(run, 'input')).toBe(false);
      expect(Object.hasOwn(run, 'inputBinding')).toBe(false);
      expect(Object.hasOwn(trace, 'coordinate')).toBe(false);
      const originalClaims = operationClaims(fixture);
      expect(originalClaims).toEqual(expect.arrayContaining([
        expect.objectContaining({ idempotencyKey: dataOf(preparedEnvelope).operationId }),
        expect.objectContaining({ idempotencyKey: receipt.operationId }),
        expect.objectContaining({ idempotencyKey: run.operationId }),
      ]));
      await rmrfAsync(fixture.worktree);
      const replayedSegment = await withMcp(fixture.env, call => call('exarchos_orchestrate', {
        action: 'execute_intent', intent: 'task-completion', featureId: fixture.featureId,
        operationId: run.operationId,
        args: {
          taskId: TASK, worktreePath: fixture.worktree, riskTier: 'low', boundaryTouching: false,
          baseRef: INTEGRATION_BRANCH, result: { worktreePath: fixture.worktree, files: [`src/${TASK}.ts`] }, capsuleVersion,
        },
      }));
      expect(dataOf(replayedSegment)).toMatchObject({ operationId: run.operationId, outcome: 'committed', requestDigest: run.requestDigest });
      expect(await bundleStore.resolve(runRef.digest)).toEqual(runBytes);
      const changedSegment = await withMcp(fixture.env, call => call('exarchos_orchestrate', {
        action: 'execute_intent', intent: 'task-completion', featureId: fixture.featureId,
        operationId: run.operationId,
        args: {
          taskId: TASK, worktreePath: fixture.worktree, riskTier: 'low', boundaryTouching: false,
          baseRef: INTEGRATION_BRANCH, result: { worktreePath: fixture.worktree, files: ['src/changed.ts'] }, capsuleVersion,
        },
      }));
      expect(changedSegment).toMatchObject({ success: false, error: { code: 'INTENT_REPLAY_DIGEST_MISMATCH' } });

      const cliDuplicate = await cli(fixture.env, settleArgs(fixture, capsuleVersion));
      expect(cliDuplicate.exitCode).toBe(0);
      expectParity(first, mcpDuplicate, 'orchestrate.settle');
      expectParity(cliDuplicate.envelope, first, 'orchestrate.settle');
      expect(await rowCount(fixture, 'execution.settled')).toBe(1);
      expect(await rowCount(fixture, 'task.completed')).toBe(1);
      expect(operationClaims(fixture)).toEqual(originalClaims);
    });
  }, CASE_TIMEOUT_MS);

  /**
   * A workflow in `plan` cannot be prepared, and no capsule was prepared for it, so both verbs refuse.
   * Each refusal must carry the same code and message on both transports, and the CLI must exit with an error code.
   */
  it('prepareAndSettle_refusedOnEachTransport_envelopesMatchAfterNormalize', async () => {
    await withHermeticEnv(async (env) => {
      const fixture: Fixture = { env, featureId: `parity-refusal-${env.testId.slice(0, 8)}`, worktree: env.gitDir };
      const prepareCall = { action: 'prepare', featureId: fixture.featureId, repoRoot: env.gitDir };
      const [mcpPrepare, mcpSettle] = await withMcp(env, async (call) => {
        dataOf(await call('exarchos_workflow', { action: 'init', featureId: fixture.featureId, workflowType: 'feature' }));
        return [await call('exarchos_orchestrate', prepareCall), await call('exarchos_orchestrate', settleCall(fixture, 1))];
      });
      expect(mcpPrepare.error).toMatchObject({ code: 'PHASE_NOT_PREPARABLE' });
      expect(mcpSettle.error).toMatchObject({ code: 'CAPSULE_NOT_PREPARED' });

      const cliPrepare = await cli(env, ['orchestrate', 'prepare', '--feature-id', fixture.featureId, '--repo-root', env.gitDir]);
      const cliSettle = await cli(env, settleArgs(fixture, 1));
      expect(cliPrepare.exitCode).not.toBe(0);
      expect(cliSettle.exitCode).not.toBe(0);
      expectParity(cliPrepare.envelope, mcpPrepare, 'orchestrate.refusal');
      expectParity(cliSettle.envelope, mcpSettle, 'orchestrate.refusal');
    });
  }, CASE_TIMEOUT_MS);
});
