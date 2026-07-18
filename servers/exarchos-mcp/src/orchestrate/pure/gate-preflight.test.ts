// ─── gate-preflight — shared preflight + policy-skip helper (DR-10) ───────────
//
// These tests pin the SHARED helper directly (the five gate handlers keep their
// own unmodified tests). Two contracts matter:
//   1. runGatePreflight reproduces each handler's exact fail-fast envelopes and
//      the worktree-aware repoRoot resolution.
//   2. emitPolicySkipIfNeeded preserves the per-gate `gate.executed` shape
//      byte-for-byte (gateName / layer / phase parameterized, details fixed) —
//      the dedup must NOT coalesce or re-label the emission.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import { rmrf } from '../../test-helpers/temp-dir.js';
import { emitPolicySkipIfNeeded, runGatePreflight } from './gate-preflight.js';

describe('gate-preflight (DR-10 shared helper)', () => {
  const stateDirs: string[] = [];

  async function makeStore(): Promise<EventStore> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gate-preflight-'));
    stateDirs.push(stateDir);
    const store = new EventStore(stateDir);
    await store.initialize();
    return store;
  }

  afterEach(() => {
    for (const d of stateDirs.splice(0)) {
      try {
        rmrf(d);
      } catch {
        /* best-effort */
      }
    }
  });

  // ─── runGatePreflight ──────────────────────────────────────────────────────

  describe('runGatePreflight', () => {
    it('miswiredEventStore_ReturnsMiswiredContextNamedPerHandler', async () => {
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', handlerName: 'handleContractDrift' },
        null as unknown as EventStore,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.success).toBe(false);
      expect(outcome.result.error?.code).toBe('MISWIRED_CONTEXT');
      // The handler name is stamped into the message (not a generic string).
      expect(outcome.result.error?.message).toBe('handleContractDrift: eventStore is required');
    });

    it('absentFeatureId_ReturnsInvalidInput', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: '', handlerName: 'handleStaticAnalysis' },
        store,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.error?.code).toBe('INVALID_INPUT');
      expect(outcome.result.error?.message).toContain('featureId');
    });

    it('requireTaskIdWithAbsentTaskId_ReturnsInvalidInput', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', handlerName: 'handleTestAdequacy', requireTaskId: true },
        store,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.error?.code).toBe('INVALID_INPUT');
      expect(outcome.result.error?.message).toBe('taskId is required');
    });

    it('absentTaskIdWithoutRequireFlag_ResolvesNormally', async () => {
      // check-integration-suite / static-analysis: taskId is optional.
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', repoRoot: '/literal/repo', handlerName: 'handleCheckIntegrationSuite' },
        store,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.repoRoot).toBe('/literal/repo');
    });

    it('literalRepoRoot_ReturnedVerbatim', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', taskId: 'T-1', repoRoot: '/worktrees/agent-x', handlerName: 'h', requireTaskId: true },
        store,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.repoRoot).toBe('/worktrees/agent-x');
    });

    it('omittedRepoRoot_FallsBackToProcessCwd', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', handlerName: 'h' },
        store,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.repoRoot).toBe(process.cwd());
    });

    it('autoRepoRootUnresolvable_ReturnsInvalidInputWithResolverMessage', async () => {
      // 'auto' with no worktreePath and no worktree.created event → INVALID_INPUT
      // carrying the resolver's own message (byte-preserved from the handlers).
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', taskId: 'T-missing', repoRoot: 'auto', handlerName: 'h', requireTaskId: true },
        store,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.error?.code).toBe('INVALID_INPUT');
      expect(outcome.result.error?.message).toContain("repoRoot 'auto' could not be resolved");
    });

    it('autoRepoRootWithExplicitWorktreePath_Resolves', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        {
          featureId: 'feat-1',
          taskId: 'T-1',
          repoRoot: 'auto',
          worktreePath: '/worktrees/agent-y',
          handlerName: 'h',
          requireTaskId: true,
        },
        store,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.repoRoot).toBe('/worktrees/agent-y');
    });

    it('validationOrder_EventStoreCheckedBeforeFeatureId', async () => {
      // A miswired store with an ALSO-absent featureId must surface the wiring
      // bug (MISWIRED_CONTEXT), not the input error — the order the handlers use.
      const outcome = await runGatePreflight(
        { featureId: '', handlerName: 'h' },
        null as unknown as EventStore,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.error?.code).toBe('MISWIRED_CONTEXT');
    });
  });

  // ─── emitPolicySkipIfNeeded ────────────────────────────────────────────────

  describe('emitPolicySkipIfNeeded', () => {
    async function gateEvents(store: EventStore, featureId: string, gateName: string) {
      const events = await store.query(featureId);
      return events.filter(
        (e) =>
          e.type === 'gate.executed' && (e.data as { gateName?: string }).gateName === gateName,
      );
    }

    it('unstampedProfile_ReturnsNullAndEmitsNothing', async () => {
      // Legacy caller: no riskTier/boundaryTouching → the gate runs
      // unconditionally (null), and NO gate.executed is emitted.
      const store = await makeStore();
      const skip = await emitPolicySkipIfNeeded({
        eventStore: store,
        featureId: 'feat-legacy',
        taskId: 'T-1',
        policyGateName: 'check_test_adequacy',
        emitGateName: 'test-adequacy',
        layer: 'testing',
        phase: 'delegate',
      });
      expect(skip).toBeNull();
      expect(await gateEvents(store, 'feat-legacy', 'test-adequacy')).toHaveLength(0);
    });

    it('gateInResolvedSequence_ReturnsNullAndEmitsNothing', async () => {
      // medium tier → [check_static_analysis, check_test_adequacy]: the gate IS
      // in the sequence, so no skip.
      const store = await makeStore();
      const skip = await emitPolicySkipIfNeeded({
        eventStore: store,
        featureId: 'feat-med',
        taskId: 'T-1',
        riskTier: 'medium',
        boundaryTouching: false,
        policyGateName: 'check_test_adequacy',
        emitGateName: 'test-adequacy',
        layer: 'testing',
        phase: 'delegate',
      });
      expect(skip).toBeNull();
      expect(await gateEvents(store, 'feat-med', 'test-adequacy')).toHaveLength(0);
    });

    it('gateNotInSequence_ReturnsReasonAndEmitsSkipEvent_TestAdequacyShape', async () => {
      // low tier → [check_static_analysis]: check_test_adequacy is NOT in it.
      const store = await makeStore();
      const skip = await emitPolicySkipIfNeeded({
        eventStore: store,
        featureId: 'feat-low',
        taskId: 'T-low',
        branch: 'feat/x',
        riskTier: 'low',
        boundaryTouching: false,
        policyGateName: 'check_test_adequacy',
        emitGateName: 'test-adequacy',
        layer: 'testing',
        phase: 'delegate',
      });

      expect(skip).not.toBeNull();
      expect(skip?.reason).toContain('skipped by verification policy');

      const events = await gateEvents(store, 'feat-low', 'test-adequacy');
      expect(events).toHaveLength(1);
      const evt = events[0];
      // The emission preserves the test-adequacy handler's exact shape.
      expect((evt!.data as { gateName: string }).gateName).toBe('test-adequacy');
      expect((evt!.data as { layer: string }).layer).toBe('testing');
      expect((evt!.data as { passed: boolean }).passed).toBe(true);
      const details = (evt!.data as { details: Record<string, unknown> }).details;
      expect(details).toEqual({
        dimension: 'D1',
        phase: 'delegate',
        taskId: 'T-low',
        branch: 'feat/x',
        skipped: true,
        discriminant: 'skipped-by-policy',
        reason: skip?.reason,
      });
    });

    it('preservesPerGateGateNameLayerAndPhase_NotCoalesced', async () => {
      // The contract-drift gate emits a DIFFERENT gateName + layer (and a fixed
      // phase) than test-adequacy — the helper must not unify these away.
      const store = await makeStore();
      const skip = await emitPolicySkipIfNeeded({
        eventStore: store,
        featureId: 'feat-nb',
        taskId: 'T-nb',
        riskTier: 'medium',
        boundaryTouching: false, // contract-drift only appended when boundaryTouching
        policyGateName: 'check_contract_drift',
        emitGateName: 'contract-drift',
        layer: 'delegate',
        phase: 'delegate',
      });

      expect(skip).not.toBeNull();
      const events = await gateEvents(store, 'feat-nb', 'contract-drift');
      expect(events).toHaveLength(1);
      const evt = events[0];
      expect((evt!.data as { gateName: string }).gateName).toBe('contract-drift');
      expect((evt!.data as { layer: string }).layer).toBe('delegate');
      const details = (evt!.data as { details: { phase: string; branch?: string } }).details;
      expect(details.phase).toBe('delegate');
      // No branch supplied → the key is OMITTED (not emitted as undefined).
      expect('branch' in details).toBe(false);
    });

    it('emissionFailure_StillReturnsReason_FireAndForget', async () => {
      // A store whose append rejects must NOT break the skip verdict — the
      // handlers treat the emission as fire-and-forget.
      const throwingStore = {
        append: () => Promise.reject(new Error('append failed')),
        query: () => Promise.resolve([]),
      } as unknown as EventStore;

      const skip = await emitPolicySkipIfNeeded({
        eventStore: throwingStore,
        featureId: 'feat-x',
        taskId: 'T-x',
        riskTier: 'low',
        boundaryTouching: false,
        policyGateName: 'check_test_adequacy',
        emitGateName: 'test-adequacy',
        layer: 'testing',
        phase: 'delegate',
      });

      expect(skip).not.toBeNull();
      expect(skip?.reason).toContain('skipped by verification policy');
    });

    it('operationIdReplay_CollapsesToSingleRow', async () => {
      // Idempotency (INV-8): re-emitting under the same operationId leaves ONE
      // gate.executed row (the emit threads operationId as the idempotency key).
      const store = await makeStore();
      const params = {
        eventStore: store,
        featureId: 'feat-idem',
        taskId: 'T-idem',
        operationId: 'op-123',
        riskTier: 'low' as const,
        boundaryTouching: false,
        policyGateName: 'check_test_adequacy' as const,
        emitGateName: 'test-adequacy',
        layer: 'testing',
        phase: 'delegate',
      };
      await emitPolicySkipIfNeeded(params);
      await emitPolicySkipIfNeeded(params);
      const events = await gateEvents(store, 'feat-idem', 'test-adequacy');
      expect(events).toHaveLength(1);
    });
  });
});
