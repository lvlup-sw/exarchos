/**
 * The scope of `prepare` and `settle` holds on real git when a name is ambiguous or a claimed tree is in another repository.
 *
 * A tag with the name of the base makes git resolve that name to the tag, so `prepare` refuses it before the base read.
 * A tag that has the name of the base after `prepare` does not hide a worktree on the base branch from `settle`.
 * A claim on a tree of another repository runs no command that the config of that repository names.
 *
 * Each call goes through `dispatch` with a real caller identity and capability resolver. Telemetry is at its shipped
 * default, and `prepare` and `settle` read each tree with the shipped git reads. Each workflow is seeded as rows of the
 * event store only, so no case writes a state document. Each case spawns git, so it sets its own timeout and does not
 * raise the budget of its tier.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type FixtureFiles, type ScopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 'feat-scope-same-name-tag';
const INTEGRATION_BRANCH = 'feature/same-name-tag';
/** The budget of one case. A case spawns git and runs the static-analysis gate of at most one task. */
const CASE_TIMEOUT_MS = 90_000 * WIN32_SPAWN_HEADROOM;

/** A real npm script: the cheapest process that exits 0. */
const OK = 'node -e ""';

/** The green fixture: a Node project whose static-analysis scripts each exit 0. */
const GREEN_PROJECT: FixtureFiles = {
  'package.json': JSON.stringify(
    { name: 'scope-same-name-tag-fixture', version: '1.0.0', private: true, scripts: { lint: OK, typecheck: OK, 'quality-check': OK } },
    null,
    2,
  ),
};

let stateDir: string;
let eventStore: EventStore;
let repository: ScopedRepository;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'scope-same-name-tag-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  repository = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: GREEN_PROJECT });
  scratchDirs.push(repository.root);
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** The dispatch context of an agent, as the composition root builds it, with telemetry at its shipped default. */
function agentContext(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'scope-same-name-tag' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

const CallResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
});

type CallResult = z.infer<typeof CallResultSchema>;

async function call(action: string, args: Record<string, unknown>): Promise<CallResult> {
  return CallResultSchema.parse(await dispatch('exarchos_orchestrate', { action, ...args }, agentContext()));
}

/** The fields of a prepare receipt that the cases read. */
const PreparedView = z.object({
  capsuleVersion: z.number().int(),
  capsule: z.object({
    settlementContract: z.object({
      scope: z.object({ repository: z.string(), checkout: z.string() }),
      taskVerification: z.record(z.string(), z.object({ baseRef: z.string(), baseCommit: z.string() })),
    }),
  }),
});

type Prepared = z.infer<typeof PreparedView>;

/** The fields of a settle receipt that the cases read. */
const SettledView = z.object({
  outcome: z.string(),
  acceptedTasks: z.array(z.string()),
  unresolved: z.array(z.object({ taskId: z.string(), cause: z.string() })).optional(),
  findings: z.array(z.object({ kind: z.string(), subject: z.string(), message: z.string() })),
  verification: z.array(z.object({ taskId: z.string(), outcome: z.string() })).optional(),
});

type Settled = z.infer<typeof SettledView>;

/** A feature workflow in `delegate` with one ready task, low-risk and off the boundary, as rows of the event store only. */
async function seed(): Promise<void> {
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: {
      patch: {
        'synthesis.integrationBranch': INTEGRATION_BRANCH,
        tasks: [{ id: 'task-a', title: 'task-a', status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false }],
      },
    },
  });
}

/** One prepare of the seeded workflow from `repoRoot`. */
async function prepare(repoRoot: string): Promise<CallResult> {
  return call('prepare', { featureId: STREAM, repoRoot });
}

function preparedOf(result: CallResult): Prepared {
  expect(result.success, JSON.stringify(result)).toBe(true);
  return PreparedView.parse(result.data);
}

/** One settle call of a batch with one completed claim on a worktree, and its receipt. */
async function settle(capsuleVersion: number, worktreePath: string): Promise<Settled> {
  const settled = await call('settle', {
    featureId: STREAM,
    capsuleVersion,
    batchId: 'batch-same-name-tag',
    claims: [{ taskId: 'task-a', fields: { worktreePath }, evidence: [] }],
  });
  expect(settled.success, JSON.stringify(settled)).toBe(true);
  return SettledView.parse(settled.data);
}

/** The task that each `gate.executed` row of the stream names. A row that names no task gives nothing. */
async function tasksWithGateRows(): Promise<string[]> {
  const tasks: string[] = [];
  for (const row of await eventStore.query(STREAM, { type: 'gate.executed' })) {
    const parsed = z.object({ details: z.object({ taskId: z.string() }) }).safeParse(row.data);
    if (parsed.success) tasks.push(parsed.data.details.taskId);
  }
  return tasks;
}

/**
 * Checks the receipt of a batch whose one task is unresolved before verification, and returns the message of the finding.
 * The task is not accepted, and no gate row and no completion row names it.
 */
async function unresolvedBeforeVerification(receipt: Settled, cause: string): Promise<string> {
  expect(receipt.outcome).toBe('corrective-capsule');
  expect(receipt.acceptedTasks).toEqual([]);
  expect(receipt.unresolved).toEqual([{ taskId: 'task-a', cause: 'worktree-out-of-scope' }]);
  expect(receipt.findings.map((finding) => [finding.kind, finding.subject])).toEqual([['worktree-out-of-scope', 'task-a']]);
  const message = receipt.findings[0]?.message ?? '';
  expect(message).toContain(`(${cause})`);
  expect(receipt.verification ?? []).toEqual([]);
  expect(await tasksWithGateRows()).not.toContain('task-a');
  expect(await eventStore.query(STREAM, { type: 'task.completed' })).toEqual([]);
  return message;
}

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd })).trim();
}

/** Writes one file in a tree and commits it on the branch that the tree holds. */
async function commitIn(tree: string, file: string, text: string): Promise<void> {
  await writeFile(path.join(tree, file), text, 'utf-8');
  await git(tree, ['add', '--', file]);
  await git(tree, ['commit', '-q', '-m', `add ${file}`]);
}

describe('prepare refuses a base whose name is also a tag', () => {
  /**
   * The integration branch holds one commit beyond `main`, and a tag of the same name points to `main`.
   * Git resolves the name to the tag, so prepare refuses before it pins a base commit, and nothing is recorded.
   * The recovery works: after the tag is deleted, prepare pins the tip of the branch.
   */
  it('Prepare_ABaseRefThatAlsoNamesATag_IsRefusedBaseUnresolved', async () => {
    await commitIn(repository.checkout, 'notes.md', 'a commit beyond main\n');
    const tip = await git(repository.checkout, ['rev-parse', `refs/heads/${INTEGRATION_BRANCH}`]);
    expect(tip).not.toBe(repository.baseCommit);
    await git(repository.checkout, ['tag', INTEGRATION_BRANCH, 'main']);
    await seed();

    const refused = await prepare(repository.checkout);
    expect(refused.success, JSON.stringify(refused)).toBe(false);
    expect(refused.error?.code).toBe('BASE_UNRESOLVED');
    const message = refused.error?.message ?? '';
    expect(message).toContain(`the tag 'refs/tags/${INTEGRATION_BRANCH}' at ${repository.baseCommit}`);
    expect(message).toContain('Delete or rename the tag, then prepare again');
    expect(await eventStore.query(STREAM, { type: 'workflow.prepared' })).toEqual([]);

    await git(repository.checkout, ['tag', '-d', INTEGRATION_BRANCH]);
    const prepared = preparedOf(await prepare(repository.checkout));
    expect(prepared.capsule.settlementContract.taskVerification['task-a']).toEqual({
      baseRef: INTEGRATION_BRANCH,
      baseCommit: tip,
    });
  }, CASE_TIMEOUT_MS);
});

describe('settle reads the exact branch and no status outside the scope', () => {
  /**
   * The checkout is the primary worktree on `main`, and a linked worktree holds the base branch.
   * After prepare, a tag gets the name of the base branch, so the short form of git prints `heads/<name>` in that worktree.
   * The claim on that worktree is still on the base branch.
   */
  it('Settle_ALinkedWorktreeOnTheBaseBranchWithASameNameTag_IsOnTheBaseBranch', async () => {
    const { primary, linked } = await repository.baseInLinkedWorktree();
    await seed();
    const prepared = preparedOf(await prepare(primary));
    expect(prepared.capsule.settlementContract.scope.checkout).toBe(primary);
    await git(primary, ['tag', INTEGRATION_BRANCH, repository.baseCommit]);
    expect(await git(linked, ['symbolic-ref', '--short', 'HEAD'])).toBe(`heads/${INTEGRATION_BRANCH}`);

    const receipt = await settle(prepared.capsuleVersion, linked);

    const message = await unresolvedBeforeVerification(receipt, 'on-the-base-branch');
    expect(message).toContain(`it is on the base branch ${JSON.stringify(INTEGRATION_BRANCH)}`);
  }, CASE_TIMEOUT_MS);

  /**
   * The other repository sets `core.fsmonitor` to a command that writes a marker file, and a status of its trees runs it.
   * settle refuses the claim on a worktree of that repository as `other-repository`, and the command does not run.
   * Then a status in that worktree writes the marker, so the command is live in the case.
   */
  it('Settle_AClaimInAnotherRepositoryWithAnFsmonitor_IsOtherRepositoryAndRunsNoCommand', async () => {
    const other = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: GREEN_PROJECT });
    scratchDirs.push(other.root);
    const worktree = await other.worktreeFor('task-a');
    const marker = path.posix.join(other.root, 'fsmonitor-ran');
    const hook = path.posix.join(other.root, 'fsmonitor-hook.cjs');
    await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`, 'utf-8');
    await git(other.checkout, ['config', 'core.fsmonitor', `node ${JSON.stringify(hook)}`]);
    await seed();
    const prepared = preparedOf(await prepare(repository.checkout));

    const receipt = await settle(prepared.capsuleVersion, worktree);

    const message = await unresolvedBeforeVerification(receipt, 'other-repository');
    expect(message).toContain(JSON.stringify(`${other.checkout}/.git`));
    expect(existsSync(marker)).toBe(false);
    await git(worktree, ['status', '--porcelain']);
    expect(existsSync(marker)).toBe(true);
  }, CASE_TIMEOUT_MS);
});
