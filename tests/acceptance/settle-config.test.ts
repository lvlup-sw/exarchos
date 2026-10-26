/**
 * `settle` runs the segments of a batch under the config of the checkout that the capsule pins.
 *
 * Each call goes through `dispatch` with a real caller identity and capability resolver. Telemetry is at its shipped
 * default, and the observer of a claimed worktree is the shipped one, which runs real git. Each workflow is seeded as
 * rows of the event store only, so no case writes a state document. The repository of each case comes from the scoped
 * repository helper, and the static-analysis gate passes on its green fixture.
 * Each case spawns git, so it sets its own timeout and does not raise the budget of its tier.
 *
 * @oracle-sources: ../../src/verbs/settle/handler.ts, the receipts of each dispatched call, the rows of the real event store, and the config files that each case writes in the checkout
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { DEFAULTS, type ResolvedProjectConfig } from '../../src/config/resolve.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type FixtureFiles, type ScopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 'feat-settle-config-acceptance';
const INTEGRATION_BRANCH = 'feature/settle-config';
/** The budget of one case. A case spawns git, prepares at most twice and runs the static-analysis gate of one task. */
const CASE_TIMEOUT_MS = 120_000 * WIN32_SPAWN_HEADROOM;

/** A real npm script: the cheapest process that exits 0. */
const OK = 'node -e ""';

/** The green fixture: a Node project whose static-analysis scripts each exit 0. */
const GREEN_PROJECT: FixtureFiles = {
  'package.json': JSON.stringify(
    { name: 'settle-config-fixture', version: '1.0.0', private: true, scripts: { lint: OK, typecheck: OK, 'quality-check': OK } },
    null,
    2,
  ),
};

/** A config of the checkout that keeps the shipped severity of each gate. It loads, and it names the mock-boundary gate only. */
const KEEPING_CONFIG = 'review:\n  gates:\n    mock-boundary:\n      enabled: true\n      blocking: false\n';

/** A config of the checkout that disables the kill probe. */
const DISABLING_CONFIG = 'review:\n  gates:\n    check_test_adequacy:\n      enabled: false\n';

/** The config of the server in the case of the disabled gate: the shipped defaults, with the kill probe enabled and blocking. */
const SERVER_CONFIG: ResolvedProjectConfig = {
  ...DEFAULTS,
  review: {
    ...DEFAULTS.review,
    gates: { ...DEFAULTS.review.gates, check_test_adequacy: { enabled: true, blocking: true, params: {} } },
  },
};

let stateDir: string;
let eventStore: EventStore;
let repository: ScopedRepository;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-config-acceptance-'));
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

/**
 * The dispatch context of an agent, as the composition root builds it. It sets no observer of a claimed worktree, and
 * telemetry is at its shipped default. `projectConfig` is the config that the server loaded at its start.
 */
function agentContext(projectConfig?: ResolvedProjectConfig): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'settle-config-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
    ...(projectConfig === undefined ? {} : { projectConfig }),
  };
}

const CallResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
});

type CallResult = z.infer<typeof CallResultSchema>;

async function call(action: string, args: Record<string, unknown>, context: DispatchContext): Promise<CallResult> {
  return CallResultSchema.parse(await dispatch('exarchos_orchestrate', { action, ...args }, context));
}

/** The fields of a prepare receipt that the cases read. */
const PreparedView = z.object({ capsuleVersion: z.number().int() });

/** The fields of a settle receipt that the cases read. */
const SettledView = z.object({
  outcome: z.string(),
  acceptedTasks: z.array(z.string()),
  verification: z
    .array(
      z.object({
        taskId: z.string(),
        outcome: z.string(),
        qualifiers: z
          .array(z.object({ gate: z.string(), mark: z.string(), discriminant: z.string().optional() }).passthrough())
          .optional(),
      }),
    )
    .optional(),
});

type Settled = z.infer<typeof SettledView>;

/** The rows of a plan: each task is ready and off the boundary, at the given tier. */
function planRows(taskIds: readonly string[], riskTier: 'low' | 'medium'): Record<string, unknown>[] {
  return taskIds.map((id) => ({ id, title: id, status: 'pending', blockedBy: [], riskTier, boundaryTouching: false }));
}

/** A feature workflow in `delegate` with the given ready tasks, as rows of the event store only. */
async function seed(taskIds: readonly string[], riskTier: 'low' | 'medium'): Promise<void> {
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks: planRows(taskIds, riskTier) } },
  });
}

/** Prepares the workflow from the checkout, and returns the capsule version. */
async function prepare(context: DispatchContext = agentContext()): Promise<number> {
  const prepared = await call('prepare', { featureId: STREAM, repoRoot: repository.checkout }, context);
  expect(prepared.success, JSON.stringify(prepared)).toBe(true);
  return PreparedView.parse(prepared.data).capsuleVersion;
}

/** A completed claim on a worktree. */
function claimOn(taskId: string, worktreePath: string): Record<string, unknown> {
  return { taskId, fields: { worktreePath }, evidence: [] };
}

/** The settle call of one batch, as dispatch answers it. */
async function settleCall(
  capsuleVersion: number,
  batchId: string,
  claims: readonly Record<string, unknown>[],
  context: DispatchContext = agentContext(),
): Promise<CallResult> {
  return call('settle', { featureId: STREAM, capsuleVersion, batchId, claims }, context);
}

/** The receipt of a settle call that succeeded. */
function settledOf(result: CallResult): Settled {
  expect(result.success, JSON.stringify(result)).toBe(true);
  return SettledView.parse(result.data);
}

/** Writes the config file of the checkout. The file is not committed, and the checkout is the tree of record. */
async function writeCheckoutConfig(text: string): Promise<void> {
  await writeFile(path.join(repository.checkout, '.exarchos.yml'), text, 'utf-8');
}

/** The tasks that the stream records complete. */
async function completedTasks(): Promise<string[]> {
  const rows = await eventStore.query(STREAM, { type: 'task.completed' });
  return rows.map((row) => z.object({ taskId: z.string() }).parse(row.data).taskId);
}

/** The task that each `gate.executed` row of the stream names. A row that names no task, such as a telemetry row, gives nothing. */
async function tasksWithGateRows(): Promise<string[]> {
  const tasks: string[] = [];
  for (const row of await eventStore.query(STREAM, { type: 'gate.executed' })) {
    const parsed = z.object({ details: z.object({ taskId: z.string() }) }).safeParse(row.data);
    if (parsed.success) tasks.push(parsed.data.details.taskId);
  }
  return tasks;
}

describe('settle runs the segments under the config of the checkout', () => {
  /**
   * An edit of the config of the checkout after prepare refuses the settle call, and no gate runs. The text names a new
   * prepare. The new prepare pins the edited config, and the same claim in a new batch under the new capsule settles.
   */
  it('SettleConfig_AConfigEditedAfterPrepare_NeedsANewPrepareThenSettles', async () => {
    await seed(['task-a'], 'low');
    const first = await prepare();
    const worktree = await repository.worktreeFor('task-a');
    await writeCheckoutConfig(KEEPING_CONFIG);

    const refused = await settleCall(first, 'batch-before-the-new-prepare', [claimOn('task-a', worktree)]);
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('CAPSULE_UNRESOLVED');
    expect(refused.error?.message).toContain(`the config files of the checkout '${repository.checkout}' changed after prepare`);
    expect(refused.error?.message).toContain('prepare again');
    expect(await tasksWithGateRows()).toEqual([]);
    expect(await completedTasks()).toEqual([]);

    const second = await prepare();
    expect(second).toBeGreaterThan(first);
    const settled = settledOf(await settleCall(second, 'batch-after-the-new-prepare', [claimOn('task-a', worktree)]));
    expect(settled.outcome).toBe('settled');
    expect(settled.acceptedTasks).toEqual(['task-a']);
    expect(await tasksWithGateRows()).toContain('task-a');
    expect(await completedTasks()).toEqual(['task-a']);
  }, CASE_TIMEOUT_MS);

  /**
   * The checkout config disables the kill probe of a medium-tier task, and the config of the server keeps it enabled and blocking.
   * The segment skips the kill probe, and the trace names the skip as `disabled-by-config`. The task completes on its static-analysis pass.
   */
  it('SettleConfig_AGateThatTheCheckoutDisables_IsSkippedAndTheTraceNamesDisabledByConfig', async () => {
    await writeCheckoutConfig(DISABLING_CONFIG);
    await seed(['task-a'], 'medium');
    const server = agentContext(SERVER_CONFIG);
    const capsuleVersion = await prepare(server);
    const worktree = await repository.worktreeFor('task-a');

    const settled = settledOf(await settleCall(capsuleVersion, 'batch-disabled-kill-probe', [claimOn('task-a', worktree)], server));
    expect(settled.outcome).toBe('settled');
    expect(settled.acceptedTasks).toEqual(['task-a']);
    const [trace] = settled.verification ?? [];
    expect(trace?.outcome).toBe('verified');
    expect((trace?.qualifiers ?? []).map((qualifier) => [qualifier.gate, qualifier.mark, qualifier.discriminant])).toEqual([
      ['test-adequacy', 'skipped', 'disabled-by-config'],
    ]);
    expect(await completedTasks()).toEqual(['task-a']);
  }, CASE_TIMEOUT_MS);
});
