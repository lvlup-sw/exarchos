// Tests for the `exarchos_workflow` composite and the handlers behind it.
//
// The file-level mocks stub the handlers that `handleWorkflow` calls, so the
// envelope suite checks only the `Envelope<T>` wrapping at the tool boundary:
// `{ success, data, next_actions: [], _meta, _perf: { ms } }`. Most later suites
// call `vi.doUnmock` and `vi.resetModules` in `beforeEach` to run the real handlers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import {
  failSafeVerificationProfile,
  resolveBoundaryTouching,
  resolveRiskTier,
  resolveVerificationPolicy,
  reviewRosterTier,
} from '../../../src/workflow/verification-policy-resolver.js';
import { resolveGateSet } from '../../../src/workflow/phase-kind.js';
import { getRequiredReviews } from '../../../src/workflow/review-contract.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';

vi.mock('../../../src/workflow/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/workflow/tools.js')>();
  return {
    ...actual,
    handleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' }, _meta: { checkpointAdvised: false } }),
    handleGet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate', featureId: 'f' }, _meta: { checkpointAdvised: false } }),
    handleTransition: vi.fn().mockResolvedValue({ success: true, data: { phase: 'plan', updatedAt: 'ts' }, _meta: { checkpointAdvised: false } }),
    handleCheckpoint: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' }, _meta: { checkpointAdvised: false } }),
    handleReconcileState: vi.fn().mockResolvedValue({ success: true, data: { reconciled: true, eventsApplied: 2 } }),
  };
});

vi.mock('../../../src/workflow/cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: { phase: 'cancelled' } }),
}));

vi.mock('../../../src/workflow/cleanup.js', () => ({
  handleCleanup: vi.fn().mockResolvedValue({ success: true, data: { phase: 'completed' } }),
}));

vi.mock('../../../src/describe/handler.js', () => ({
  handleDescribe: vi.fn().mockResolvedValue({ success: true, data: { actions: [] } }),
}));

import { handleWorkflow } from '../../../src/workflow/composite.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

/**
 * Asserts the `Envelope<T>` shape of a result. `success` must be `true`, because the envelope tests mock only
 * successful handler results. `next_actions` must be an empty array.
 */
function assertEnvelopeShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const env = result as Record<string, unknown>;

  expect(env.success).toBe(true);

  expect(Object.hasOwn(env, 'data')).toBe(true);

  expect(Array.isArray(env.next_actions)).toBe(true);
  expect((env.next_actions as unknown[]).length).toBe(0);

  expect(env._meta).toBeTypeOf('object');
  expect(env._meta).not.toBeNull();

  expect(env._perf).toBeTypeOf('object');
  expect(env._perf).not.toBeNull();
  const perf = env._perf as Record<string, unknown>;
  expect(typeof perf.ms).toBe('number');
}

describe('WorkflowToolResponses_AllActions_ReturnEnvelope (T036, DR-7)', () => {
  const stateDir = '/tmp/test-envelope-state';
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx(stateDir);
  });

  it('init action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'init', featureId: 'test', workflowType: 'feature' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('get action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'get', featureId: 'test' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('transition action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'transition', featureId: 'test', target: 'plan' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('cancel action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'cancel', featureId: 'test' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('cleanup action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'cleanup', featureId: 'test', mergeVerified: true },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('reconcile action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'reconcile', featureId: 'test' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('checkpoint action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'checkpoint', featureId: 'test' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('describe action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'describe' },
      ctx,
    );
    assertEnvelopeShape(result);
  });
});

/**
 * This suite runs the real `handleRehydrate` and `handleDescribe`. `beforeEach` un-mocks the describe handler
 * and imports the rehydration index, which registers the reducer that `handleRehydrate` needs.
 */
describe('WorkflowTool_RegistersRehydrateAction (T033, DR-5)', () => {
  let tempDir: string;
  let stateDir: string;
  let store: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    vi.doUnmock('../../../src/describe/handler.js');
    vi.resetModules();

    tempDir = await mkdtemp(path.join(tmpdir(), 'workflow-tool-rehydrate-'));
    stateDir = tempDir;
    store = new EventStore(stateDir);
    ctx = { stateDir, eventStore: store, enableTelemetry: false };

    await import('../../../src/projections/rehydration/index.js');
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('WorkflowTool_DescribeIncludesRehydrate', async () => {
    const compositeMod = await import('../../../src/workflow/composite.js');

    const result = await compositeMod.handleWorkflow(
      { action: 'describe', actions: ['rehydrate'] },
      ctx,
    );

    expect(result.success).toBe(true);
    const env = result as unknown as {
      success: boolean;
      data: { rehydrate?: { description: string; schema: unknown; phases: string[]; roles: string[] } };
    };
    expect(env.data.rehydrate).toBeTypeOf('object');
    expect(typeof env.data.rehydrate?.description).toBe('string');
    expect(env.data.rehydrate?.schema).toBeTypeOf('object');
    expect(Array.isArray(env.data.rehydrate?.phases)).toBe(true);
    expect(Array.isArray(env.data.rehydrate?.roles)).toBe(true);
    const schema = env.data.rehydrate?.schema as {
      properties?: Record<string, unknown>;
      required?: readonly string[];
    };
    expect(schema.properties).toHaveProperty('featureId');
    expect(schema.required).toContain('featureId');
  });

  it('WorkflowTool_RehydrateDispatch_ReturnsEnveloped', async () => {
    const featureId = 'rehydrate-dispatch-test';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const compositeMod = await import('../../../src/workflow/composite.js');

    const result = await compositeMod.handleWorkflow(
      { action: 'rehydrate', featureId },
      ctx,
    );

    const env = result as unknown as Record<string, unknown>;
    expect(env.success).toBe(true);
    expect(Array.isArray(env.next_actions)).toBe(true);
    expect(env._meta).toBeTypeOf('object');
    expect(env._perf).toBeTypeOf('object');

    const { RehydrationDocumentSchema } = await import(
      '../../../src/projections/rehydration/schema.js'
    );
    const parsed = RehydrationDocumentSchema.safeParse(env.data);
    expect(parsed.success).toBe(true);
  });
});

/**
 * `handleCheckpoint` appends a 16-character sha256 prefix of the handoff to the idempotency key. Two
 * checkpoints with different handoffs give two events. A checkpoint without a handoff hashes `{}`, so its key
 * is stable.
 */
describe('HandleCheckpoint_PayloadDigestIdempotencyKey (C3, closes #1241)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.doUnmock('../../../src/workflow/tools.js');
    vi.resetModules();

    tempDir = await mkdtemp(path.join(tmpdir(), 'checkpoint-idem-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /**
   * `writeStateFile` bumps `_version`, so a key without the digest also gives two events here. The test
   * therefore checks the digest segment of each key, not only the event count.
   */
  it('handleCheckpoint_refinementInSamePhase_landsTwoEvents', async () => {
    const { handleInit, handleCheckpoint } = await import('../../../src/workflow/tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-c3-refinement';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    const first = await handleCheckpoint(
      { featureId, handoff: { context: 'first' } } as unknown as Parameters<typeof handleCheckpoint>[0],
      tempDir,
      store,
    );
    expect(first.success).toBe(true);

    const second = await handleCheckpoint(
      { featureId, handoff: { context: 'second' } } as unknown as Parameters<typeof handleCheckpoint>[0],
      tempDir,
      store,
    );
    expect(second.success).toBe(true);

    const { createHash } = await import('node:crypto');
    const firstDigest = createHash('sha256')
      .update(JSON.stringify({ context: 'first' }))
      .digest('hex')
      .slice(0, 16);
    const secondDigest = createHash('sha256')
      .update(JSON.stringify({ context: 'second' }))
      .digest('hex')
      .slice(0, 16);

    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(2);
    const keys = events.map((e) => (e as unknown as { idempotencyKey?: string }).idempotencyKey ?? '');
    expect(keys[0].endsWith(`:${firstDigest}`)).toBe(true);
    expect(keys[1].endsWith(`:${secondDigest}`)).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
  });

  /**
   * Without a handoff, the digest segment is the hash of `{}`. So the same call shape always gives the same
   * key.
   */
  it('handleCheckpoint_noHandoffPayload_legacyKeyShapeStable', async () => {
    const { createHash } = await import('node:crypto');
    const { handleInit, handleCheckpoint } = await import('../../../src/workflow/tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-c3-no-handoff';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    const result = await handleCheckpoint(
      { featureId },
      tempDir,
      store,
    );
    expect(result.success).toBe(true);

    const expectedDigest = createHash('sha256')
      .update(JSON.stringify({}))
      .digest('hex')
      .slice(0, 16);

    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(1);
    const persisted = events[0] as unknown as { idempotencyKey?: string };
    expect(persisted.idempotencyKey).toBeTypeOf('string');
    expect(persisted.idempotencyKey?.endsWith(`:${expectedDigest}`)).toBe(true);
  });
});

/**
 * `handleCheckpoint` adds the phase playbook to its result as `phasePlaybook`, as `handleRehydrate` does. For
 * a phase without a playbook, the field is `null`, not absent.
 */
describe('HandleCheckpoint_PhasePlaybook (T-23, rehydration-machinery-refactor)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.doUnmock('../../../src/workflow/tools.js');
    vi.resetModules();

    tempDir = await mkdtemp(path.join(tmpdir(), 'checkpoint-playbook-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /** The test writes the `delegate` phase to the state file directly, so no HSM guard runs. */
  it('handleCheckpoint_delegatePhase_attachesPhasePlaybookSkillDelegation', async () => {
    const { handleInit, handleCheckpoint } = await import('../../../src/workflow/tools.js');
    const { readStateFile, writeStateFile } = await import('../../../src/workflow/state-store.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-t23-delegate';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    const stateFile = path.join(tempDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    const mutated = { ...state, phase: 'delegate' as const };
    await writeStateFile(stateFile, mutated);

    const result = await handleCheckpoint(
      { featureId },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as { phasePlaybook?: { skill?: string } | null };
    expect(data.phasePlaybook).not.toBeNull();
    expect(data.phasePlaybook).toBeDefined();
    expect(data.phasePlaybook?.skill).toBe('delegate');
  });

  /**
   * The feature, debug and refactor types have a playbook for each phase, and `readStateFile` rejects a phase
   * outside the schema enum. A custom workflow type has no playbook entries, so `composePhasePlaybook` returns
   * `null` for each of its phases.
   */
  it('handleCheckpoint_unregisteredPhase_attachesPhasePlaybookNull', async () => {
    const { handleInit, handleCheckpoint } = await import('../../../src/workflow/tools.js');
    const { registerCustomWorkflows } = await import('../../../src/config/register.js');
    const { unregisterWorkflowType } = await import('../../../src/workflow/state-machine.js');
    const { unextendWorkflowTypeEnum } = await import('../../../src/workflow/schemas.js');
    const customType = 't23-custom-no-playbook';
    registerCustomWorkflows({
      workflows: {
        [customType]: {
          phases: ['start', 'done'],
          initialPhase: 'start',
          transitions: [{ from: 'start', to: 'done', event: 'finish' }],
        },
      },
    });
    try {
      const store = new EventStore(tempDir);
      const featureId = 'wf-t23-terminal';

      const init = await handleInit(
        { featureId, workflowType: customType },
        tempDir,
        store,
      );
      expect(init.success).toBe(true);

      const result = await handleCheckpoint(
        { featureId },
        tempDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as { phasePlaybook?: unknown };
      expect('phasePlaybook' in data).toBe(true);
      expect(data.phasePlaybook).toBeNull();
    } finally {
      unregisterWorkflowType(customType);
      unextendWorkflowTypeEnum(customType);
    }
  });
});

/**
 * `handleCheckpoint` runs `lintHandoff` over the handoff. By default the handler appends the checkpoint event
 * and reports the findings in `data.handoffLintFindings` and `warnings`. With the `hardFail` option, it
 * returns `INVALID_INPUT` with `data.findings` and appends no event.
 */
describe('HandleCheckpoint_HandoffLint (#1244)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.doUnmock('../../../src/workflow/tools.js');
    vi.resetModules();

    tempDir = await mkdtemp(path.join(tmpdir(), 'checkpoint-handoff-lint-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('HandleCheckpoint_AiPaddedContext_EmitsWarning', async () => {
    const { handleInit, handleCheckpoint } = await import('../../../src/workflow/tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-1244-soft';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    const result = await handleCheckpoint(
      {
        featureId,
        handoff: {
          context: 'We delve into the rich tapestry of edge cases and leverage the parser.',
        },
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as { handoffLintFindings?: unknown[] };
    expect(Array.isArray(data.handoffLintFindings)).toBe(true);
    expect((data.handoffLintFindings as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect((result.warnings ?? []).some((w) => w.includes('handoff'))).toBe(true);

    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(1);
  });

  /**
   * For a clean handoff the result has no `handoffLintFindings` field, because the presence of the field is a
   * signal.
   */
  it('HandleCheckpoint_CleanHandoff_NoWarning', async () => {
    const { handleInit, handleCheckpoint } = await import('../../../src/workflow/tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-1244-clean';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    const result = await handleCheckpoint(
      {
        featureId,
        handoff: {
          context: 'Implemented the parser. Tests pass. Ready for review.',
          nextSteps: ['Add docs entry'],
          suggestions: ['Pin parser version'],
        },
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as { handoffLintFindings?: unknown[] };
    expect(data.handoffLintFindings).toBeUndefined();
    const handoffWarnings = (result.warnings ?? []).filter((w) => w.includes('handoff'));
    expect(handoffWarnings).toEqual([]);
  });

  /** The handler lints `context`, `nextSteps` and `suggestions`. It does not stop after the first field with a finding. */
  it('HandoffLint_ScansAllThreeFields_FindingsCoverEachSource', async () => {
    const { handleInit, handleCheckpoint } = await import('../../../src/workflow/tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-1244-allfields';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    const result = await handleCheckpoint(
      {
        featureId,
        handoff: {
          context: 'Delve into the parser internals.',
          nextSteps: ['Examine the rich tapestry of edge cases.'],
          suggestions: ['Leverage the existing reducer hook.'],
        },
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const findings = (result.data as { handoffLintFindings?: { source: string }[] })
      .handoffLintFindings ?? [];
    const sources = findings.map((f) => f.source);
    expect(sources).toContain('context');
    expect(sources).toContain('nextSteps');
    expect(sources).toContain('suggestions');
  });

  /**
   * Production reads `handoffLint` from `.exarchos.yml`. The test passes it as the fourth argument of
   * `handleCheckpoint`.
   */
  it('HandleCheckpoint_HardFailConfig_BlocksWrite', async () => {
    const { handleInit, handleCheckpoint } = await import('../../../src/workflow/tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-1244-hard';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    const result = await handleCheckpoint(
      {
        featureId,
        handoff: { context: 'Delve into the rich tapestry of complexity.' },
      },
      tempDir,
      store,
      { handoffLint: { hardFail: true } },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    const data = result.data as { findings?: unknown[] };
    expect(Array.isArray(data?.findings)).toBe(true);
    expect((data!.findings as unknown[]).length).toBeGreaterThanOrEqual(1);

    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(0);
  });
});

describe('HandleInit_RepoKeyParameter (DR-5)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.doUnmock('../../../src/workflow/tools.js');
    vi.resetModules();
    tempDir = await mkdtemp(path.join(tmpdir(), 'init-reporoot-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /**
   * `handleInit` writes the key as given. The composite derives it from the working directory before the
   * call.
   */
  it('HandleInit_WithRepoKeyParam_EmitsRepoRoot', async () => {
    const { handleInit } = await import('../../../src/workflow/tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-init-reporoot-present';
    const repoKey = '/home/dev/exarchos';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
      repoKey,
    );
    expect(init.success).toBe(true);

    const events = await store.query(featureId, { type: 'workflow.started' });
    expect(events.length).toBe(1);
    const data = events[0]!.data as { repoRoot?: string; featureId?: string };
    expect(data.repoRoot).toBe(repoKey);
  });

  it('HandleInit_NoRepoKey_EmitsLegacyShape', async () => {
    const { handleInit } = await import('../../../src/workflow/tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-init-reporoot-absent';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    const events = await store.query(featureId, { type: 'workflow.started' });
    expect(events.length).toBe(1);
    const data = events[0]!.data as { repoRoot?: string; featureId?: string };
    expect(data.repoRoot).toBeUndefined();
    expect(data.featureId).toBe(featureId);
    const key = (events[0] as unknown as { idempotencyKey?: string }).idempotencyKey;
    expect(key).toBe(`${featureId}:workflow.started`);
  });
});

/**
 * An unresolved risk tier or boundary flag selects a stronger verification obligation, never a weaker one.
 */
describe('requirement resolution is monotonic and fail-safe (DR-10, T-14)', () => {
  /**
   * An absent or invalid tier resolves to `unknown`, never to `low`. A project can bind `low` to an empty gate list in
   * `.exarchos.yml`.
   */
  it('ResolveRiskTier_AbsentTier_DoesNotResolveLow', () => {
    for (const raw of [
      undefined,
      null,
      '',
      'LOW',
      'lo',
      'critical',
      0,
      1,
      true,
      false,
      {},
      [],
      ['high'],
    ]) {
      expect(resolveRiskTier(raw), `raw=${JSON.stringify(raw)}`).toBe('unknown');
      expect(resolveRiskTier(raw)).not.toBe('low');
    }

    expect(resolveRiskTier('low')).toBe('low');
    expect(resolveRiskTier('medium')).toBe('medium');
    expect(resolveRiskTier('high')).toBe('high');
  });

  it('ResolveRiskTier_UnknownTier_SelectsTheStrongestLadderCell', () => {
    expect(failSafeVerificationProfile('unknown', false)).toEqual({
      riskTier: 'high',
      boundaryTouching: true,
    });
    const unknown = resolveVerificationPolicy('unknown', false).sequence;
    expect(unknown).toEqual(resolveVerificationPolicy('high', true).sequence);
    expect(unknown).not.toEqual(resolveVerificationPolicy('low', false).sequence);
  });

  /**
   * A project can set `policy.low: []` to run no gates for trivial work. An unknown tier resolves through the
   * boundary high cell, so that empty override does not apply to it.
   */
  it('ResolveRiskTier_UnknownTier_CannotBindAWeakConfigOverride', () => {
    const config = {
      verification: { policy: { low: [], boundary: { high: ['check_static_analysis'] } } },
    } as unknown as ResolvedProjectConfig;

    expect(resolveVerificationPolicy('low', false, config).sequence).toEqual([]);
    const unknown = resolveVerificationPolicy('unknown', false, config);
    expect(unknown.sequence).toEqual(['check_static_analysis']);
    expect(unknown.sequence).not.toEqual([]);
  });

  /**
   * Only an explicit boolean sets `boundaryTouching`. The string `'false'` resolves to `true`, like every other
   * value that is not a boolean.
   */
  it('ResolveBoundaryTouching_UnknownState_FailsSafeToTrue', () => {
    for (const raw of [undefined, null, '', 'false', 'true', 0, 1, {}, [], NaN]) {
      expect(resolveBoundaryTouching(raw), `raw=${JSON.stringify(raw)}`).toBe(true);
    }

    expect(resolveBoundaryTouching(false)).toBe(false);
    expect(resolveBoundaryTouching(true)).toBe(true);

    expect(
      resolveVerificationPolicy('medium', resolveBoundaryTouching('false')).sequence,
    ).toEqual(resolveVerificationPolicy('medium', true).sequence);
  });

  /** The fail-safe changes only an unknown tier. A stated tier keeps its own ladder cell. */
  it('ResolveRiskTier_KnownTiers_AreUnchangedByTheFailSafe', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      for (const boundary of [false, true]) {
        expect(failSafeVerificationProfile(tier, boundary)).toEqual({
          riskTier: tier,
          boundaryTouching: boundary,
        });
      }
    }
  });

  /**
   * The review roster does not escalate an unknown tier. A `high` tier adds the `mutation-adequacy`
   * dimension, which can block review to synthesize for an untiered workflow.
   */
  it('ReviewRosterTier_UnknownTier_MakesNoTierClaimAndCannotDeadlock', () => {
    expect(reviewRosterTier('unknown')).toBeUndefined();
    expect(reviewRosterTier('low')).toBe('low');
    expect(reviewRosterTier('high')).toBe('high');

    const unknownRoster = resolveGateSet('REVIEW', {
      riskTier: 'unknown',
      boundaryTouching: resolveBoundaryTouching(undefined),
      workflowType: 'feature',
    }).map((g) => g.gate);
    expect(unknownRoster).toEqual(getRequiredReviews('feature'));
    expect(unknownRoster).not.toContain('mutation-adequacy');

    const highRoster = resolveGateSet('REVIEW', {
      riskTier: 'high',
      boundaryTouching: false,
      workflowType: 'feature',
    }).map((g) => g.gate);
    expect(highRoster).toContain('mutation-adequacy');
  });
});
