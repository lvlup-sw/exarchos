// The success replies of the workflow handlers parse against the `outputSchema` of each action.
//
// The MCP adapter replaces a reply that does not parse with an `INTERNAL_ERROR`. Thus a schema that
// is stricter than a real reply breaks the action. Each test parses a real reply of each arm, after
// the wrap that the composite and the MCP adapter apply. A reply with a wrong shape fails the same
// parse, so no schema is vacuous.
//
// The tests call the handlers directly. A dry run of `cancel` or `cleanup` emits no event, and the
// emission contract of the dispatch core refuses that reply before the schema check.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleCheckpoint,
  handleInit,
  handleReconcileState,
  handleTransition,
  handleUpdate,
} from '../../../src/workflow/tools.js';
import { handleCancel } from '../../../src/workflow/cancel.js';
import { handleCleanup } from '../../../src/workflow/cleanup.js';
import { handleFeedback } from '../../../src/workflow/feedback.js';
import { handleRehydrate } from '../../../src/workflow/rehydrate.js';
import { composePhasePlaybook } from '../../../src/workflow/playbooks.js';
import { handleDescribe } from '../../../src/describe/handler.js';
import { DEFAULTS } from '../../../src/config/resolve.js';
import { EventStore } from '../../../src/events/store.js';
import { appendSnapshot } from '../../../src/projections/store.js';
import {
  REHYDRATION_PROJECTION_ID,
  REHYDRATION_PROJECTION_VERSION,
} from '../../../src/projections/rehydration/identity.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import { envelopeWrap } from '../../../src/envelope-wrap.js';
import { toEnvelope, type ToolResult } from '../../../src/format.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const workflowActions = TOOL_REGISTRY.find((tool) => tool.name === 'exarchos_workflow')?.actions ?? [];

/**
 * Parses a handler reply against the `outputSchema` of its `exarchos_workflow` action, after the
 * same wrap that the composite and the MCP adapter apply. It returns `ok`, or the issues as JSON.
 */
function verdict(actionName: string, result: ToolResult): string {
  const action = workflowActions.find((candidate) => candidate.name === actionName);
  if (action === undefined) throw new Error(`exarchos_workflow.${actionName} is not registered`);
  const parsed = action.outputSchema.safeParse(toEnvelope(envelopeWrap(result, Date.now())));
  return parsed.success ? 'ok' : JSON.stringify(parsed.error.issues);
}

/** Returns `data` of a success reply as a record, or throws when the reply holds no object. */
function dataOf(result: ToolResult): Record<string, unknown> {
  expect(result.success, JSON.stringify(result.error)).toBe(true);
  const data: unknown = result.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`expected object data, got ${JSON.stringify(data)}`);
  }
  return Object.fromEntries(Object.entries(data));
}

/** Returns `_meta` of a reply as a record, or throws when the reply holds no object `_meta`. */
function metaOf(result: ToolResult): Record<string, unknown> {
  const meta: unknown = result._meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new Error(`expected object _meta, got ${JSON.stringify(meta)}`);
  }
  return Object.fromEntries(Object.entries(meta));
}

/** Expects each `data` value to fail the declared schema of `actionName`. */
function expectRejected(actionName: string, wrongData: readonly unknown[]): void {
  for (const data of wrongData) {
    expect(verdict(actionName, { success: true, data }), JSON.stringify(data)).not.toBe('ok');
  }
}

let tmpDir: string;
let store: EventStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-output-schemas-'));
  store = new EventStore(tmpDir);
  await store.initialize();
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

/** Reads the raw state file of `featureId` without validation. */
async function readRawState(featureId: string): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await fs.readFile(path.join(tmpDir, `${featureId}.state.json`), 'utf-8'));
  if (typeof raw !== 'object' || raw === null) throw new Error(`state of ${featureId} is not an object`);
  return Object.fromEntries(Object.entries(raw));
}

/** Writes the raw state file of `featureId` without validation. */
async function writeRawState(featureId: string, state: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(tmpDir, `${featureId}.state.json`), JSON.stringify(state, null, 2), 'utf-8');
}

describe('workflow handler replies parse against the declared output schemas', () => {
  /**
   * The paths are a fresh init, an update, a transition and a same-target transition. The update of
   * a state from before v2.12 has no phase attempt id. A reply that has neither a workflow type nor
   * `idempotent: true`, or that lacks the time of the write, fails the same parse.
   */
  it('WorkflowOutputSchemas_InitUpdateAndTransition_ParseAgainstTheDeclaredSchemas', async () => {
    const init = await handleInit({ featureId: 'wf-write', workflowType: 'feature' }, tmpDir, store);
    expect(dataOf(init).phase).toBe('plan');
    expect(verdict('init', init)).toBe('ok');

    const update = await handleUpdate(
      { featureId: 'wf-write', updates: { artifacts: { plan: 'docs/plan.md' } } },
      tmpDir,
      store,
    );
    expect(dataOf(update).workflowType).toBe('feature');
    expect(verdict('update', update)).toBe('ok');

    const transition = await handleTransition({ featureId: 'wf-write', target: 'plan-review' }, tmpDir, store);
    expect(dataOf(transition).phase).toBe('plan-review');
    expect(verdict('transition', transition)).toBe('ok');

    const sameTarget = await handleTransition({ featureId: 'wf-write', target: 'plan-review' }, tmpDir, store);
    expect(dataOf(sameTarget).idempotent).toBe(true);
    expect(dataOf(sameTarget).workflowType).toBeUndefined();
    expect(verdict('transition', sameTarget)).toBe('ok');

    await handleInit({ featureId: 'wf-legacy', workflowType: 'feature' }, tmpDir, null);
    const legacyState = await readRawState('wf-legacy');
    delete legacyState.phaseAttemptId;
    await writeRawState('wf-legacy', legacyState);
    const legacyUpdate = await handleUpdate(
      { featureId: 'wf-legacy', updates: { artifacts: { plan: 'docs/plan.md' } } },
      tmpDir,
      null,
    );
    expect(dataOf(legacyUpdate).phaseAttemptId).toBeUndefined();
    expect(verdict('update', legacyUpdate)).toBe('ok');

    expectRejected('init', [
      'plan',
      { featureId: 'wf', workflowType: 'feature', phase: 'plan' },
      { featureId: 'wf', workflowType: 'feature', phase: 7, phaseAttemptId: 'p' },
    ]);
    const updatedAt = '2026-10-24T00:00:00.000Z';
    for (const actionName of ['transition', 'update']) {
      expectRejected(actionName, [
        'plan',
        null,
        { phase: 'plan' },
        { phase: 'plan', workflowType: 'feature' },
        { phase: 'plan', updatedAt },
        { phase: 'plan', updatedAt, idempotent: false },
        { phase: 'plan', updatedAt, workflowType: 'feature', phaseAttemptId: 7 },
      ]);
    }
  });

  /**
   * A dry run returns the compensation steps and the target phase. A real cancel returns the steps
   * and the phase before it. A dry run that names another target, or a step without a status, fails.
   */
  it('WorkflowOutputSchemas_CancelDryRunAndCancel_ParseAgainstTheDeclaredSchema', async () => {
    await handleInit({ featureId: 'wf-cancel', workflowType: 'feature' }, tmpDir, store);
    await handleUpdate({ featureId: 'wf-cancel', updates: { artifacts: { plan: 'docs/plan.md' } } }, tmpDir, store);
    await handleTransition({ featureId: 'wf-cancel', target: 'plan-review' }, tmpDir, store);

    const dryRun = await handleCancel({ featureId: 'wf-cancel', dryRun: true }, tmpDir, store);
    expect(dataOf(dryRun).dryRun).toBe(true);
    expect(dataOf(dryRun).actions).not.toEqual([]);
    expect(verdict('cancel', dryRun)).toBe('ok');

    const cancelled = await handleCancel({ featureId: 'wf-cancel', reason: 'schema test' }, tmpDir, store);
    expect(dataOf(cancelled).phase).toBe('cancelled');
    expect(verdict('cancel', cancelled)).toBe('ok');

    const step = { actionId: 'synthesize:close-pr', status: 'skipped', message: 'No PR to close' };
    expectRejected('cancel', [
      'cancelled',
      { dryRun: true, actions: [step], currentPhase: 'plan', wouldTransitionTo: 'completed' },
      { dryRun: true, currentPhase: 'plan', wouldTransitionTo: 'cancelled' },
      { phase: 'cancelled', actions: [{ actionId: 'a' }], previousPhase: 'plan', phaseAttemptId: 'p' },
      { phase: 'completed', actions: [step], previousPhase: 'plan', phaseAttemptId: 'p' },
      { phase: 'cancelled', actions: [step], previousPhase: 'plan' },
    ]);
  });

  /**
   * A dry run with a list of PR URLs, a dry run with no backfill inputs and a real cleanup each
   * parse. An absent input is `null`. A dry run without the backfill block fails.
   */
  it('WorkflowOutputSchemas_CleanupDryRunAndCleanup_ParseAgainstTheDeclaredSchema', async () => {
    await handleInit({ featureId: 'wf-cleanup', workflowType: 'feature' }, tmpDir, null);
    const state = await readRawState('wf-cleanup');
    state.phase = 'review';
    state._history = { feature: 'review' };
    state.synthesis = {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: 'https://github.com/test/pr/1',
      prFeedback: [],
    };
    await writeRawState('wf-cleanup', state);

    const listDryRun = await handleCleanup(
      { featureId: 'wf-cleanup', mergeVerified: true, dryRun: true, prUrl: ['https://github.com/test/pr/1'] },
      tmpDir,
      store,
    );
    expect(dataOf(listDryRun).synthesisBackfill).toEqual({
      prUrl: ['https://github.com/test/pr/1'],
      mergedBranches: null,
    });
    expect(verdict('cleanup', listDryRun)).toBe('ok');

    const bareDryRun = await handleCleanup({ featureId: 'wf-cleanup', mergeVerified: true, dryRun: true }, tmpDir, store);
    expect(dataOf(bareDryRun).synthesisBackfill).toEqual({ prUrl: null, mergedBranches: null });
    expect(verdict('cleanup', bareDryRun)).toBe('ok');

    const completed = await handleCleanup(
      {
        featureId: 'wf-cleanup',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/1',
        mergedBranches: ['feature/wf-cleanup'],
      },
      tmpDir,
      store,
    );
    expect(dataOf(completed).phase).toBe('completed');
    expect(verdict('cleanup', completed)).toBe('ok');

    const backfill = { prUrl: null, mergedBranches: null };
    expectRejected('cleanup', [
      'completed',
      { dryRun: true, currentPhase: 'review', wouldTransitionTo: 'completed' },
      { dryRun: true, currentPhase: 'review', wouldTransitionTo: 'cancelled', synthesisBackfill: backfill },
      {
        dryRun: true,
        currentPhase: 'review',
        wouldTransitionTo: 'completed',
        synthesisBackfill: { prUrl: 7, mergedBranches: null },
      },
      { phase: 'cancelled', previousPhase: 'review', phaseAttemptId: 'p' },
      { phase: 'completed', previousPhase: 'review' },
    ]);
  });

  /**
   * The reconcile paths are a fold with no new event and a rebuild of a lost state file. The
   * checkpoint paths are with and without an event store, a handoff with lint findings, and a phase
   * without a playbook. The feedback paths are with and without an upstream endpoint.
   */
  it('WorkflowOutputSchemas_ReconcileCheckpointAndFeedback_ParseAgainstTheDeclaredSchemas', async () => {
    await handleInit({ featureId: 'wf-misc', workflowType: 'feature' }, tmpDir, store);

    const noop = await handleReconcileState({ featureId: 'wf-misc' }, tmpDir, store);
    expect(dataOf(noop)).toEqual({ reconciled: false, eventsApplied: 0 });
    expect(verdict('reconcile', noop)).toBe('ok');

    await handleInit({ featureId: 'wf-rebuilt', workflowType: 'feature' }, tmpDir, store);
    await fs.rm(path.join(tmpDir, 'wf-rebuilt.state.json'));
    const rebuilt = await handleReconcileState({ featureId: 'wf-rebuilt' }, tmpDir, store);
    expect(dataOf(rebuilt).reconciled).toBe(true);
    expect(verdict('reconcile', rebuilt)).toBe('ok');

    const withStore = await handleCheckpoint({ featureId: 'wf-misc', summary: 'schema test' }, tmpDir, store);
    expect(typeof dataOf(withStore).projectionSequence).toBe('number');
    expect(dataOf(withStore).phasePlaybook).not.toBeNull();
    expect(verdict('checkpoint', withStore)).toBe('ok');

    const withoutStore = await handleCheckpoint({ featureId: 'wf-misc' }, tmpDir, null);
    expect(dataOf(withoutStore).projectionSequence).toBeUndefined();
    expect(verdict('checkpoint', withoutStore)).toBe('ok');

    const linted = await handleCheckpoint(
      { featureId: 'wf-misc', handoff: { context: 'We delve into the plan and leverage the spec.' } },
      tmpDir,
      store,
    );
    expect(dataOf(linted).handoffLintFindings).toBeDefined();
    expect(dataOf(linted).handoffLintFindings).not.toEqual([]);
    expect(verdict('checkpoint', linted)).toBe('ok');

    expect(composePhasePlaybook('oneshot', 'cancelled')).toBeNull();
    await handleInit({ featureId: 'wf-oneshot', workflowType: 'oneshot' }, tmpDir, null);
    const oneshotState = await readRawState('wf-oneshot');
    oneshotState.phase = 'cancelled';
    await writeRawState('wf-oneshot', oneshotState);
    const noPlaybook = await handleCheckpoint({ featureId: 'wf-oneshot' }, tmpDir, null);
    expect(dataOf(noPlaybook).phasePlaybook).toBeNull();
    expect(verdict('checkpoint', noPlaybook)).toBe('ok');

    const local = await handleFeedback({ message: 'schema test' }, tmpDir, store, {
      resolveUpstream: () => undefined,
    });
    expect(dataOf(local).configuredEndpoint).toBeNull();
    expect(verdict('feedback', local)).toBe('ok');

    const upstream = await handleFeedback({ message: 'schema test upstream' }, tmpDir, store, {
      resolveUpstream: () => 'https://feedback.example.test/report',
      postUpstream: async () => true,
    });
    expect(dataOf(upstream).upstreamDelivered).toBe(true);
    expect(verdict('feedback', upstream)).toBe('ok');

    expectRejected('reconcile', [
      true,
      { reconciled: 'yes', eventsApplied: 0 },
      { reconciled: true, eventsApplied: -1 },
    ]);
    expectRejected('checkpoint', [
      'plan',
      { phase: 'plan' },
      { phase: 'plan', phasePlaybook: { skill: 'plan' } },
      { phase: 'plan', phasePlaybook: null, projectionSequence: '3' },
    ]);
    const recorded = {
      recorded: true,
      stream: 'meta/feedback',
      sequence: 1,
      message: 'm',
      upstreamConfigured: false,
      configuredEndpoint: null,
      upstreamDelivered: false,
    };
    expect(verdict('feedback', { success: true, data: recorded })).toBe('ok');
    expectRejected('feedback', [
      { ...recorded, configuredEndpoint: undefined },
      { ...recorded, recorded: false },
      { ...recorded, sequence: '1' },
    ]);
  });

  /**
   * The rehydrate paths are a fresh fold and a cold probe of an unknown feature. A corrupt snapshot
   * gives a full replay, and a failed event query falls back to the state file. Each degraded
   * document is a strict v:4 document. An unknown key or an older version fails the parse.
   */
  it('WorkflowOutputSchemas_RehydrateFreshColdAndDegraded_ParseAgainstTheDeclaredSchema', async () => {
    await handleInit({ featureId: 'wf-rehydrate', workflowType: 'feature' }, tmpDir, store);
    const context = { stateDir: tmpDir, eventStore: store };

    const fresh = await handleRehydrate({ featureId: 'wf-rehydrate' }, context);
    expect(dataOf(fresh).v).toBe(4);
    expect(verdict('rehydrate', fresh)).toBe('ok');

    const cold = await handleRehydrate({ featureId: 'wf-unknown' }, context);
    expect(metaOf(cold).workflowExists).toBe(false);
    expect(verdict('rehydrate', cold)).toBe('ok');

    await handleInit({ featureId: 'wf-corrupt', workflowType: 'feature' }, tmpDir, store);
    appendSnapshot(store.getReadBackend(), 'wf-corrupt', {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: 1,
      state: { not: 'a rehydration document' },
      timestamp: new Date().toISOString(),
    });
    const replayed = await handleRehydrate({ featureId: 'wf-corrupt' }, context);
    expect(metaOf(replayed).fallbackSource).toBe('full-replay');
    expect(verdict('rehydrate', replayed)).toBe('ok');

    const failingStore = new EventStore(tmpDir);
    await failingStore.initialize();
    failingStore.query = async () => {
      throw new Error('event stream unavailable');
    };
    const stateOnly = await handleRehydrate(
      { featureId: 'wf-rehydrate' },
      { stateDir: tmpDir, eventStore: failingStore },
    );
    expect(metaOf(stateOnly).degraded).toBe(true);
    expect(metaOf(stateOnly).fallbackSource).toBe('state-store-only');
    expect(verdict('rehydrate', stateOnly)).toBe('ok');

    const noStateFile = await handleRehydrate(
      { featureId: 'wf-missing' },
      { stateDir: tmpDir, eventStore: failingStore },
    );
    expect(metaOf(noStateFile).degraded).toBe(true);
    expect(verdict('rehydrate', noStateFile)).toBe('ok');

    const degraded = dataOf(stateOnly);
    expectRejected('rehydrate', [
      'document',
      { ...degraded, unknownKey: 1 },
      { ...degraded, v: 3 },
      { ...degraded, workflowState: undefined },
      { ...degraded, phasePlaybook: undefined },
    ]);
  });

  /**
   * The describe paths are every workflow action and each topology and playbook form. The config
   * paths are with and without a project config, and one request asks for each part. The entry of
   * every registered action of every tool parses too. An empty object, a bare string, an action entry
   * without its schema, or a topology that is not an object fails the parse.
   */
  it('WorkflowOutputSchemas_DescribeRequests_ParseAgainstTheDeclaredSchema', async () => {
    const actionNames = workflowActions.map((action) => action.name);
    expect(actionNames).toContain('describe');
    const actionRequests = Array.from({ length: Math.ceil(actionNames.length / 10) }, (_, index) => ({
      actions: actionNames.slice(index * 10, index * 10 + 10),
    }));
    const requests = [
      ...actionRequests,
      { topology: 'all' },
      { topology: 'feature' },
      { playbook: 'all' },
      { playbook: 'feature' },
      { config: true },
      { actions: ['update'], topology: 'oneshot', playbook: 'debug', config: true },
    ];
    for (const request of requests) {
      const result = await handleDescribe(request, workflowActions, { includeStateSchema: true });
      expect(result.success, JSON.stringify(request)).toBe(true);
      expect(verdict('describe', result), JSON.stringify(request)).toBe('ok');
    }

    const configured = await handleDescribe({ config: true }, workflowActions, { projectConfig: DEFAULTS });
    expect(dataOf(configured).config).toBeDefined();
    expect(verdict('describe', configured)).toBe('ok');

    const entries: Record<string, unknown> = {};
    for (const tool of TOOL_REGISTRY) {
      const described = await handleDescribe({ actions: tool.actions.map((action) => action.name) }, tool.actions);
      for (const [name, entry] of Object.entries(dataOf(described))) {
        entries[`${tool.name}.${name}`] = entry;
      }
    }
    expect(Object.keys(entries).length).toBe(
      TOOL_REGISTRY.reduce((count, tool) => count + tool.actions.length, 0),
    );
    expect(verdict('describe', { success: true, data: entries })).toBe('ok');

    expectRejected('describe', [
      {},
      'catalog',
      [],
      { init: 'x' },
      { init: { description: 'x' } },
      { topology: 'feature' },
      { playbook: 7 },
      { config: 'yes' },
    ]);
  });
});
