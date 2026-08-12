// ─── T036: Envelope Conformance for exarchos_workflow Tool ──────────────────
//
// Verifies that every action dispatched through `handleWorkflow` (the
// composite `exarchos_workflow` MCP tool surface) returns a response
// conforming to the HATEOAS `Envelope<T>` shape introduced in T014:
//
//   { success: boolean, data: unknown, next_actions: [], _meta: {}, _perf: { ms: number, ... } }
//
// Handler internals are mocked so this suite only asserts the wrapping
// contract at the tool boundary. `next_actions` defaults to an empty array
// until T040/T041 populate it from HSM transitions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { EventStore } from '../events/store.js';
import {
  failSafeVerificationProfile,
  resolveBoundaryTouching,
  resolveRiskTier,
  resolveVerificationPolicy,
  reviewRosterTier,
} from './verification-policy-resolver.js';
import { resolveGateSet } from './phase-kind.js';
import { getRequiredReviews } from './review-contract.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

// Mock every handler invoked by `handleWorkflow` so we exercise only the
// envelope-wrapping behavior at the composite boundary, not the handler
// internals (which have their own dedicated tests).
vi.mock('./tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools.js')>();
  return {
    ...actual,
    handleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' }, _meta: { checkpointAdvised: false } }),
    handleGet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate', featureId: 'f' }, _meta: { checkpointAdvised: false } }),
    // T5a.1/DR-4 (#1259, v2.11): `handleSet` is no longer dispatched from
    // the composite. `handleTransition` covers phase mutation; mock it here
    // so the canonical action's envelope shape is witnessed.
    handleTransition: vi.fn().mockResolvedValue({ success: true, data: { phase: 'plan', updatedAt: 'ts' }, _meta: { checkpointAdvised: false } }),
    handleCheckpoint: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' }, _meta: { checkpointAdvised: false } }),
    handleReconcileState: vi.fn().mockResolvedValue({ success: true, data: { reconciled: true, eventsApplied: 2 } }),
  };
});

vi.mock('./cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: { phase: 'cancelled' } }),
}));

vi.mock('./cleanup.js', () => ({
  handleCleanup: vi.fn().mockResolvedValue({ success: true, data: { phase: 'completed' } }),
}));

vi.mock('../describe/handler.js', () => ({
  handleDescribe: vi.fn().mockResolvedValue({ success: true, data: { actions: [] } }),
}));

import { handleWorkflow } from './composite.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

function assertEnvelopeShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const env = result as Record<string, unknown>;

  // success: must be the literal `true`, not just any boolean. The
  // happy-path tests below mock only successful handler results, so a
  // wrapped error envelope reaching this assertion is a bug — the caller
  // should branch and assert the error shape instead. (CodeRabbit on PR
  // #1178: prior `typeof env.success === 'boolean'` accepted both
  // `success: true` and `success: false` envelopes silently.)
  expect(env.success).toBe(true);

  // data: any (must be present as own key, not undefined)
  expect(Object.hasOwn(env, 'data')).toBe(true);

  // next_actions: [] (empty array by default — populated in T040/T041)
  expect(Array.isArray(env.next_actions)).toBe(true);
  expect((env.next_actions as unknown[]).length).toBe(0);

  // _meta: object
  expect(env._meta).toBeTypeOf('object');
  expect(env._meta).not.toBeNull();

  // _perf: { ms: number, ... }
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

  // T5a.1/DR-4 (#1259, v2.11): the prior `set action returns Envelope`
  // case is replaced with `transition`. `set` no longer dispatches through
  // a handler; it returns a structured `UNKNOWN_ACTION` error envelope
  // (covered by `composite.test.ts` and `composite.dr4-removal.test.ts`).
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

// ─── T033: Register `rehydrate` action on exarchos_workflow ─────────────────
//
// T031 landed `handleRehydrate(args, ctx): Promise<ToolResult>` on
// `workflow/rehydrate.ts`. T036 landed the composite's `envelopeWrap`.
// T033 wires `"rehydrate"` into the action enum and the composite's
// dispatch switch, and surfaces the new action through `describe`.
//
// These tests exercise the real `handleRehydrate` and `handleDescribe`
// code paths (no mocks), so a separate describe block is used to
// side-step the mocks installed above.

describe('WorkflowTool_RegistersRehydrateAction (T033, DR-5)', () => {
  let tempDir: string;
  let stateDir: string;
  let store: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    // Un-mock the describe + rehydrate barrels so this suite hits the
    // real handlers (not the T036 envelope-conformance mocks above).
    vi.doUnmock('../describe/handler.js');
    vi.resetModules();

    tempDir = await mkdtemp(path.join(tmpdir(), 'workflow-tool-rehydrate-'));
    stateDir = tempDir;
    store = new EventStore(stateDir);
    ctx = { stateDir, eventStore: store, enableTelemetry: false };

    // Side effect: registers the rehydration reducer on the default
    // registry so `handleRehydrate` can resolve its projection.
    await import('../projections/rehydration/index.js');
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('WorkflowTool_DescribeIncludesRehydrate', async () => {
    // GIVEN: a fresh import of the composite so describe hits the real
    // handler rather than the module-level mock above.
    const compositeMod = await import('./composite.js');

    // WHEN: the caller asks describe for the rehydrate action.
    const result = await compositeMod.handleWorkflow(
      { action: 'describe', actions: ['rehydrate'] },
      ctx,
    );

    // THEN: the envelope's `data.rehydrate` descriptor exists and looks
    // structurally like a sibling action (schema + phases + roles).
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
    // The rehydrate schema must require a featureId — mirrors T031 args.
    const schema = env.data.rehydrate?.schema as {
      properties?: Record<string, unknown>;
      required?: readonly string[];
    };
    expect(schema.properties).toHaveProperty('featureId');
    expect(schema.required).toContain('featureId');
  });

  it('WorkflowTool_RehydrateDispatch_ReturnsEnveloped', async () => {
    // GIVEN: a minimally seeded event store — the handler requires only
    // that the stream exists (empty stream is also legal per T031).
    const featureId = 'rehydrate-dispatch-test';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const compositeMod = await import('./composite.js');

    // WHEN: the composite dispatches the rehydrate action.
    const result = await compositeMod.handleWorkflow(
      { action: 'rehydrate', featureId },
      ctx,
    );

    // THEN: response has envelope shape (T036) AND data passes the
    // canonical rehydration-document schema (T031, DR-5).
    const env = result as unknown as Record<string, unknown>;
    expect(env.success).toBe(true);
    expect(Array.isArray(env.next_actions)).toBe(true);
    expect(env._meta).toBeTypeOf('object');
    expect(env._perf).toBeTypeOf('object');

    const { RehydrationDocumentSchema } = await import(
      '../projections/rehydration/schema.js'
    );
    const parsed = RehydrationDocumentSchema.safeParse(env.data);
    expect(parsed.success).toBe(true);
  });
});

// ─── C3 (#1241): handleCheckpoint payload-digest idempotencyKey ─────────────
//
// `handleCheckpoint` previously built its idempotencyKey from
// `${featureId}:checkpoint:${phase}:${state._version}`. Because
// `handleCheckpoint` does NOT bump `state._version`, a second checkpoint
// within the same phase (no version-bumping action between calls)
// collided on this key. Combined with #1228's phantom-claim path (closed
// by C2 at the handler boundary), the second call returned `success:
// true` while the event was silently dropped.
//
// Fix: include a sha256 prefix of the handoff payload in the key.
// `JSON.stringify(undefined ?? {}) === '{}'` is stable, so no-handoff
// callers continue to dedup as before. Refinement callers passing
// distinct handoff payloads now produce distinct events.
//
// (The `handoff` field is not yet in `CheckpointInputSchema` — that's
// #1240. We cast through `any` here so the digest path is exercised
// even with the current schema; behavior for today's callers is
// unchanged because none populate `handoff`.)

describe('HandleCheckpoint_PayloadDigestIdempotencyKey (C3, closes #1241)', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Un-mock `./tools.js` so this suite hits real `handleInit` and
    // `handleCheckpoint`; the file-level mock above stubs them for
    // envelope-conformance assertions only.
    vi.doUnmock('./tools.js');
    vi.resetModules();

    tempDir = await mkdtemp(path.join(tmpdir(), 'checkpoint-idem-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('handleCheckpoint_refinementInSamePhase_landsTwoEvents', async () => {
    // GIVEN: a feature initialized in `ideate` with `_version=1` and no
    // intervening phase transition between two checkpoint calls (so
    // `state._version` is identical on both calls — the prior key shape
    // collided on this).
    const { handleInit, handleCheckpoint } = await import('./tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-c3-refinement';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    // WHEN: two `handleCheckpoint` calls land in the same phase with
    // distinct `handoff` payloads. The schema doesn't formally accept
    // `handoff` yet (see #1240) — cast through `any` so the digest path
    // is exercised today.
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

    // THEN: two `workflow.checkpoint` events are visible AND each
    // event's `idempotencyKey` carries a distinct sha256-prefix segment
    // for its `handoff` payload. (Asserting only `length === 2` is too
    // weak: `writeStateFile` auto-bumps `_version`, so the legacy
    // version-only key also yielded two events — but for the wrong
    // reason. The digest segment is the load-bearing fix for #1241,
    // because production refinement may land at the same `_version`.)
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

  it('handleCheckpoint_noHandoffPayload_legacyKeyShapeStable', async () => {
    // GIVEN: a feature initialized in `ideate`, then a single no-handoff
    // checkpoint. Backwards compat: callers passing no `handoff` must
    // produce a key whose digest segment matches `sha256('{}').slice(0, 16)`
    // (since `JSON.stringify(undefined ?? {}) === '{}'`). This pins the
    // digest segment so historical replay (events written before #1240
    // wires `handoff`) remains dedup-stable across versions of the
    // codebase: the same call shape always produces the same key.
    const { createHash } = await import('node:crypto');
    const { handleInit, handleCheckpoint } = await import('./tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-c3-no-handoff';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    // WHEN: a `handleCheckpoint` call lands with no handoff payload.
    const result = await handleCheckpoint(
      { featureId },
      tempDir,
      store,
    );
    expect(result.success).toBe(true);

    // THEN: the persisted `workflow.checkpoint` event's `idempotencyKey`
    // ends with the deterministic digest of `{}` — the digest is stable
    // across calls, so a *second* no-handoff checkpoint at the same
    // version would collide on this exact key (legacy dedup preserved).
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

// ─── T-23 (rehydration-machinery-refactor §T-23) ────────────────────────────
//
// `handleCheckpoint` composes the phase playbook onto the dispatch envelope so
// CLI/SDK consumers receive the same v:3 `phasePlaybook` shape that
// `handleRehydrate` attaches (T-20). The helper `composePhasePlaybook` is
// shared between handlers; this suite pins the contract at the checkpoint
// boundary:
//   1. Delegate-phase checkpoint surfaces `phasePlaybook.skill === 'delegation'`.
//   2. Unregistered (terminal-shape) phase checkpoint surfaces
//      `phasePlaybook: null` (not undefined / not omitted) — the v:3 schema
//      treats the field as nullable, not optional, and CLI renderers can
//      spread the value directly without a guard.
//
// Tests live in `tools.test.ts` (not `checkpoint.test.ts`) because that file
// scopes the `shouldEnforceCheckpoint` policy helper from `./checkpoint.js`,
// not the `handleCheckpoint` dispatch handler from `./tools.js`. The existing
// C3 suite above is the established home for `handleCheckpoint` integration
// tests in this codebase.

describe('HandleCheckpoint_PhasePlaybook (T-23, rehydration-machinery-refactor)', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Un-mock `./tools.js` so this suite hits real `handleInit` and
    // `handleCheckpoint`; the file-level mock above stubs them for
    // envelope-conformance assertions only.
    vi.doUnmock('./tools.js');
    vi.resetModules();

    tempDir = await mkdtemp(path.join(tmpdir(), 'checkpoint-playbook-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('handleCheckpoint_delegatePhase_attachesPhasePlaybookSkillDelegation', async () => {
    // GIVEN: a feature workflow with phase mutated to `delegate` (the L4
    // registry maps `feature/delegate` → `{ skill: 'delegation' }`).
    const { handleInit, handleCheckpoint } = await import('./tools.js');
    const { readStateFile, writeStateFile } = await import('./state-store.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-t23-delegate';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    // Mutate phase to `delegate` directly on disk. Skipping the formal
    // transition path keeps the test focused on the composition contract,
    // not HSM gating — the latter has its own dedicated suites.
    const stateFile = path.join(tempDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    const mutated = { ...state, phase: 'delegate' as const };
    await writeStateFile(stateFile, mutated);

    // WHEN: handleCheckpoint runs on the delegate-phase state.
    const result = await handleCheckpoint(
      { featureId },
      tempDir,
      store,
    );

    // THEN: the envelope's `data.phasePlaybook` is non-null and carries the
    // delegation skill. We assert on `skill` (not just non-null) so a
    // future registry rename surfaces here as a clear failure.
    expect(result.success).toBe(true);
    const data = result.data as { phasePlaybook?: { skill?: string } | null };
    expect(data.phasePlaybook).not.toBeNull();
    expect(data.phasePlaybook).toBeDefined();
    expect(data.phasePlaybook?.skill).toBe('delegate');
  });

  it('handleCheckpoint_unregisteredPhase_attachesPhasePlaybookNull', async () => {
    // GIVEN: a custom workflow type with an HSM but no playbook registered
    //   for the (workflowType, phase) pair. `composePhasePlaybook` returns
    //   `null` for any unregistered pair; the handler must surface that as
    //   an explicit `null` on the envelope (the v:3 schema treats the field
    //   as nullable, not optional, and CLI/SDK renderers spread the value
    //   without an `undefined` guard).
    //
    //   We use a custom workflow type rather than the rehydrate test's
    //   `shipped`-on-feature trick because `handleCheckpoint` reads through
    //   `readStateFile`, which re-validates against `WorkflowStateSchema`.
    //   Built-in workflow types' phase enums are fully populated by the
    //   playbook registry (every enum member, including terminals, has a
    //   `terminalPlaybook` entry — so they all yield non-null), and an
    //   out-of-enum phase would throw STATE_CORRUPT before composition
    //   runs. The custom workflow path uses a permissive `phase: z.string()`
    //   schema and has no playbook entries, giving a clean `null` surface.
    const { handleInit, handleCheckpoint } = await import('./tools.js');
    const { registerCustomWorkflows } = await import('../config/register.js');
    const { unregisterWorkflowType } = await import('./state-machine.js');
    const { unextendWorkflowTypeEnum } = await import('./schemas.js');
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

      // WHEN: handleCheckpoint runs on the custom-type state. The initial
      //   phase is `start`; no playbook is registered for this type, so
      //   composePhasePlaybook resolves to null regardless of phase.
      const result = await handleCheckpoint(
        { featureId },
        tempDir,
        store,
      );

      // THEN: phasePlaybook is exactly null (not undefined / not omitted).
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

// ─── #1244: markdown-aware handoff lint at handleCheckpoint ────────────────
//
// `handleCheckpoint` runs `lintHandoff` over the dispatch `handoff` payload
// at the handler boundary. The pattern catalog is the same one the
// rehydration template lint uses (DR-13 / T048), but it now gates
// per-dispatch prose: agents that mirror AI-slop back through the
// handoff fields see a structured warning (soft-fail, default) or a
// structured rejection (hard-fail, opt-in via `.exarchos.yml`).
//
// Both modes leave the integrity of the dispatch event stream intact:
//   - Soft-fail: the checkpoint event is appended exactly as before, with
//     findings surfaced on `data.handoffLintFindings` and a human-readable
//     entry on `warnings`. The counter resets normally.
//   - Hard-fail: the handler returns `INVALID_INPUT` BEFORE any event is
//     appended; `data.findings` carries the structured violations and the
//     event store is untouched, so the operator can fix the prose and
//     retry without scrubbing a partial write.
//
// These tests pin the contract at the dispatch boundary. The unit-tier
// fan-out behavior (per-field source annotation, prose-lint shape
// preservation) lives in `handoff-lint.test.ts`.

describe('HandleCheckpoint_HandoffLint (#1244)', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Un-mock `./tools.js` so this suite hits real `handleInit` and
    // `handleCheckpoint`; the file-level mock above stubs them for
    // envelope-conformance assertions only.
    vi.doUnmock('./tools.js');
    vi.resetModules();

    tempDir = await mkdtemp(path.join(tmpdir(), 'checkpoint-handoff-lint-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('HandleCheckpoint_AiPaddedContext_EmitsWarning', async () => {
    // GIVEN: a feature initialized in `ideate`, and a checkpoint
    // dispatch whose `handoff.context` contains catalogued AI tells
    // (`delve`, `tapestry`, `leverage` — all from `ai-vocabulary`).
    const { handleInit, handleCheckpoint } = await import('./tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-1244-soft';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    // WHEN: handleCheckpoint runs with a soft-fail handoff (default
    // config — no `.exarchos.yml` written, no override passed).
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

    // THEN: the call succeeds (soft-fail does NOT block writes),
    // findings surface on `data.handoffLintFindings`, and the
    // human-readable summary is on `warnings`. The checkpoint event
    // was still appended to the stream so the dispatch counter
    // reflects reality on the operator's next read.
    expect(result.success).toBe(true);
    const data = result.data as { handoffLintFindings?: unknown[] };
    expect(Array.isArray(data.handoffLintFindings)).toBe(true);
    expect((data.handoffLintFindings as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect((result.warnings ?? []).some((w) => w.includes('handoff'))).toBe(true);

    // AND: the `workflow.checkpoint` event was appended — soft-fail is
    // advisory, not blocking.
    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(1);
  });

  it('HandleCheckpoint_CleanHandoff_NoWarning', async () => {
    // GIVEN: a clean handoff with no catalogued AI tells.
    const { handleInit, handleCheckpoint } = await import('./tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-1244-clean';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    // WHEN: handleCheckpoint runs with prose that the catalog ignores.
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

    // THEN: success with no findings and no handoff-lint warnings.
    // The data envelope must NOT carry `handoffLintFindings` for clean
    // input (the field's presence is itself a signal).
    expect(result.success).toBe(true);
    const data = result.data as { handoffLintFindings?: unknown[] };
    expect(data.handoffLintFindings).toBeUndefined();
    const handoffWarnings = (result.warnings ?? []).filter((w) => w.includes('handoff'));
    expect(handoffWarnings).toEqual([]);
  });

  it('HandoffLint_ScansAllThreeFields_FindingsCoverEachSource', async () => {
    // GIVEN: a handoff with at least one AI tell in each of context,
    // nextSteps, suggestions. This duplicates the unit-tier coverage at
    // the integration tier because the dispatch handler is the
    // contract surface — the wrapper is private to the handler.
    const { handleInit, handleCheckpoint } = await import('./tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-1244-allfields';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    // WHEN: handleCheckpoint lints a handoff that triggers tells in
    // every field.
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

    // THEN: findings include one finding from each source field —
    // the handler does NOT short-circuit after the first field.
    expect(result.success).toBe(true);
    const findings = (result.data as { handoffLintFindings?: { source: string }[] })
      .handoffLintFindings ?? [];
    const sources = findings.map((f) => f.source);
    expect(sources).toContain('context');
    expect(sources).toContain('nextSteps');
    expect(sources).toContain('suggestions');
  });

  it('HandleCheckpoint_HardFailConfig_BlocksWrite', async () => {
    // GIVEN: a feature initialized in `ideate`, and a hard-fail
    // override (`handoffLint: { hardFail: true }`) passed in via the
    // injection seam. The production wiring loads this from
    // `.exarchos.yml`; the test passes it directly so the failure
    // path is exercised without yaml fixture plumbing.
    const { handleInit, handleCheckpoint } = await import('./tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-1244-hard';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
    );
    expect(init.success).toBe(true);

    // WHEN: handleCheckpoint runs with hard-fail + an AI-padded
    // handoff. The 4th positional argument injects the config so the
    // test does not depend on `.exarchos.yml` resolution.
    const result = await handleCheckpoint(
      {
        featureId,
        handoff: { context: 'Delve into the rich tapestry of complexity.' },
      },
      tempDir,
      store,
      { handoffLint: { hardFail: true } },
    );

    // THEN: the call rejects with INVALID_INPUT, the structured
    // findings are on `data.findings`, and NO checkpoint event was
    // appended — the event store is untouched so retries don't
    // duplicate.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    const data = result.data as { findings?: unknown[] };
    expect(Array.isArray(data?.findings)).toBe(true);
    expect((data!.findings as unknown[]).length).toBeGreaterThanOrEqual(1);

    const events = await store.query(featureId, { type: 'workflow.checkpoint' });
    expect(events.length).toBe(0);
  });
});

// ─── DR-5: handleInit repo-key parameter ─────────────────────────────────────

describe('HandleInit_RepoKeyParameter (DR-5)', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Un-mock `./tools.js` so this suite hits the real `handleInit`; the
    // file-level mock stubs it for envelope-conformance assertions only.
    vi.doUnmock('./tools.js');
    vi.resetModules();
    tempDir = await mkdtemp(path.join(tmpdir(), 'init-reporoot-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('HandleInit_WithRepoKeyParam_EmitsRepoRoot', async () => {
    const { handleInit } = await import('./tools.js');
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
    // The supplied key is stamped verbatim (the composite normalizes upstream).
    expect(data.repoRoot).toBe(repoKey);
  });

  it('HandleInit_NoRepoKey_EmitsLegacyShape', async () => {
    const { handleInit } = await import('./tools.js');
    const store = new EventStore(tempDir);
    const featureId = 'wf-init-reporoot-absent';

    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      tempDir,
      store,
      // no repoKey — exactly today's call shape
    );
    expect(init.success).toBe(true);

    const events = await store.query(featureId, { type: 'workflow.started' });
    expect(events.length).toBe(1);
    const data = events[0]!.data as { repoRoot?: string; featureId?: string };
    // Legacy shape: repoRoot is absent and idempotency behavior is unchanged.
    expect(data.repoRoot).toBeUndefined();
    expect(data.featureId).toBe(featureId);
    const key = (events[0] as unknown as { idempotencyKey?: string }).idempotencyKey;
    expect(key).toBe(`${featureId}:workflow.started`);
  });
});

// ─── DR-10 (T-14): monotonic, fail-safe requirement resolution ──────────────
//
// `tools.ts` used to collapse an absent/malformed `riskTier` to the literal
// `'low'` and hardcode `boundaryTouching: false` — the two WEAKEST coordinates
// of the six-cell verification ladder, asserted on no evidence. These tests pin
// the monotonicity property: an unresolved input can only ever select a
// STRONGER obligation, never a weaker one.
describe('requirement resolution is monotonic and fail-safe (DR-10, T-14)', () => {
  it('ResolveRiskTier_AbsentTier_DoesNotResolveLow', () => {
    // The headline criterion. Every way a tier can fail to be established must
    // resolve to `'unknown'` — the ABSENCE of a claim — and never to `'low'`,
    // which is a positive claim that a project's `.exarchos.yml` can bind to an
    // empty cell (`verification.policy.low: []`), i.e. to ZERO gates.
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

    // Non-vacuity: a well-formed tier still resolves to itself.
    expect(resolveRiskTier('low')).toBe('low');
    expect(resolveRiskTier('medium')).toBe('medium');
    expect(resolveRiskTier('high')).toBe('high');
  });

  it('ResolveRiskTier_UnknownTier_SelectsTheStrongestLadderCell', () => {
    // "Not low" is only meaningful if the unresolved tier actually escalates.
    expect(failSafeVerificationProfile('unknown', false)).toEqual({
      riskTier: 'high',
      boundaryTouching: true,
    });
    // The resolved sequence must equal the strongest cell's, and must NOT equal
    // the weakest cell's (which the old collapse selected).
    const unknown = resolveVerificationPolicy('unknown', false).sequence;
    expect(unknown).toEqual(resolveVerificationPolicy('high', true).sequence);
    expect(unknown).not.toEqual(resolveVerificationPolicy('low', false).sequence);
  });

  it('ResolveRiskTier_UnknownTier_CannotBindAWeakConfigOverride', () => {
    // The concrete hazard of collapsing to `'low'`: a project legitimately
    // configures `policy.low: []` ("run nothing for trivial work") and an
    // unresolved tier then silently inherits ZERO gates. An unknown tier must
    // resolve through the boundary/high cell, so the empty override cannot
    // apply to it.
    const config = {
      verification: { policy: { low: [], boundary: { high: ['check_static_analysis'] } } },
    } as unknown as ResolvedProjectConfig;

    expect(resolveVerificationPolicy('low', false, config).sequence).toEqual([]);
    const unknown = resolveVerificationPolicy('unknown', false, config);
    expect(unknown.sequence).toEqual(['check_static_analysis']);
    expect(unknown.sequence).not.toEqual([]);
  });

  it('ResolveBoundaryTouching_UnknownState_FailsSafeToTrue', () => {
    // Only an explicit boolean is believed. Everything else — absent, wrong
    // type, a truthy/falsy non-boolean — must select the BOUNDARY ladder, not
    // the non-boundary one. The old code asserted `false` unconditionally.
    for (const raw of [undefined, null, '', 'false', 'true', 0, 1, {}, [], NaN]) {
      expect(resolveBoundaryTouching(raw), `raw=${JSON.stringify(raw)}`).toBe(true);
    }

    // Non-vacuity: an explicit boolean is honoured in both directions.
    expect(resolveBoundaryTouching(false)).toBe(false);
    expect(resolveBoundaryTouching(true)).toBe(true);

    // And the fail-safe actually selects a different (stronger) cell — the
    // string `'false'` must not behave like the boolean `false`.
    expect(
      resolveVerificationPolicy('medium', resolveBoundaryTouching('false')).sequence,
    ).toEqual(resolveVerificationPolicy('medium', true).sequence);
  });

  it('ResolveRiskTier_KnownTiers_AreUnchangedByTheFailSafe', () => {
    // Monotonicity must not become "escalate everything": a stated tier keeps
    // resolving to exactly its own cell, so the fix is a floor on the unknown
    // case rather than a blanket strengthening.
    for (const tier of ['low', 'medium', 'high'] as const) {
      for (const boundary of [false, true]) {
        expect(failSafeVerificationProfile(tier, boundary)).toEqual({
          riskTier: tier,
          boundaryTouching: boundary,
        });
      }
    }
  });

  it('ReviewRosterTier_UnknownTier_MakesNoTierClaimAndCannotDeadlock', () => {
    // The review roster's fail-safe direction is deliberately the opposite of
    // the ladder's, because its failure mode is deadlock rather than
    // under-verification: escalating an untiered workflow to `'high'` would
    // require the tier-coupled `mutation-adequacy` dimension that no producer
    // would ever emit, permanently blocking review → synthesize.
    expect(reviewRosterTier('unknown')).toBeUndefined();
    expect(reviewRosterTier('low')).toBe('low');
    expect(reviewRosterTier('high')).toBe('high');

    // The resulting roster is the workflow-type base — NOT the high roster.
    const unknownRoster = resolveGateSet('REVIEW', {
      riskTier: 'unknown',
      boundaryTouching: resolveBoundaryTouching(undefined),
      workflowType: 'feature',
    }).map((g) => g.gate);
    expect(unknownRoster).toEqual(getRequiredReviews('feature'));
    expect(unknownRoster).not.toContain('mutation-adequacy');

    // Non-vacuity: an explicit high tier DOES pull the extra dimension in, so
    // the roster really is tier-sensitive and the unknown case is a choice.
    const highRoster = resolveGateSet('REVIEW', {
      riskTier: 'high',
      boundaryTouching: false,
      workflowType: 'feature',
    }).map((g) => g.gate);
    expect(highRoster).toContain('mutation-adequacy');
  });
});
