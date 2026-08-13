import { describe, it, expect, vi } from 'vitest';
import { fc } from '@fast-check/vitest';

import { reconcileWithEvents } from './reconcile.js';
import type {
  ReconcileEventCtx,
  ReconcileEventInput,
  EmittedEvent,
} from './reconcile.js';
import type { ApplyCtx } from './reconcile.js';
import type { CheckResult } from '../../../verbs/doctor/schema.js';
import type { PlanStep, ReconcileResult } from './types.js';

/**
 * Task 009 — DR-7 / DR-10: the `reconcileWithEvents` wrapper. These tests drive
 * the two-event split (`onboard.requested` → side effect → `onboard.executed`)
 * and the INV-13 + INV-8 crash-recovery contract through the INJECTED event seam
 * (`ctx.emit` / `ctx.readStreamTail`). No real EventStore is touched — spies
 * stand in for the seam Task 010's `onboard` handler will wire to the real store.
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A remediable config check → exactly one `config` PlanStep through `diff`. */
const REMEDIABLE_CHECK: CheckResult = {
  name: 'state-dir',
  category: 'storage',
  status: 'Fail',
  message: 'state dir missing',
  fix: 'create the state directory',
};

/**
 * A spy `ApplyCtx` whose config seeder reports a real write, so the (single)
 * remediable step lands in `applied`. The seeder spy lets each test assert the
 * side effect ran AT MOST ONCE across recovery/retries.
 */
function makeApplyCtx(seedSpy: ReturnType<typeof vi.fn>): ApplyCtx {
  return {
    repoRoot: '/tmp/repo',
    surface: 'cli',
    writerDeps: { cwd: () => '/tmp/repo' } as ApplyCtx['writerDeps'],
    seed: seedSpy as unknown as ApplyCtx['seed'],
  };
}

/**
 * Build a `reconcileWithEvents` input whose detect/diff are stubbed so the test
 * controls the plan deterministically. `detectDesiredState` and the doctor
 * checks are injected (no fs), keeping the wrapper test pure.
 */
function makeInput(checks: readonly CheckResult[], dryRun = false): ReconcileEventInput {
  return {
    repoRoot: '/tmp/repo',
    trigger: 'onboard',
    dryRun,
    runDoctorChecks: async () => checks,
    detectOptions: { detectRuntimes: async () => [], vcs: 'git' },
  };
}

/**
 * An in-memory event seam: records emits, replays a FRESH tail on each read
 * (seed + everything emitted so far). The `emit` spy's `mock.calls` is the
 * assertion surface for "exactly N events in order".
 */
function makeEventCtx(seed: readonly EmittedEvent[] = []): ReconcileEventCtx & {
  emitted: EmittedEvent[];
} {
  const emitted: EmittedEvent[] = [...seed];
  return {
    emitted,
    readStreamTail: vi.fn(async () => [...emitted]),
    emit: vi.fn(async (event: EmittedEvent) => {
      emitted.push(event);
    }),
  } as ReconcileEventCtx & { emitted: EmittedEvent[] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('reconcileWithEvents (DR-7 / DR-10 — two-event split + crash recovery)', () => {
  it('Apply_NonDryRun_EmitsRequestedThenExecuted', async () => {
    const seedSpy = vi.fn(() => ({ wrote: true, path: '/tmp/repo/.exarchos.yml' }));
    const ctx = makeEventCtx();
    const input = makeInput([REMEDIABLE_CHECK]);

    await reconcileWithEvents(input, ctx, makeApplyCtx(seedSpy));

    const emits = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as EmittedEvent,
    );
    expect(emits).toHaveLength(2);
    expect(emits[0].type).toBe('onboard.requested');
    expect(emits[1].type).toBe('onboard.executed');

    // Same idempotencyKey on both halves of the split.
    const reqKey = (emits[0].data as { idempotencyKey: string }).idempotencyKey;
    const exeKey = (emits[1].data as { idempotencyKey: string }).idempotencyKey;
    expect(reqKey).toBeTruthy();
    expect(exeKey).toBe(reqKey);

    // requested carries the plan; executed carries the result + durationMs.
    expect((emits[0].data as { plan: { steps: PlanStep[] } }).plan.steps).toHaveLength(1);
    expect((emits[1].data as { result: ReconcileResult }).result.applied).toHaveLength(1);
    expect(typeof (emits[1].data as { durationMs: number }).durationMs).toBe('number');

    // The side effect ran exactly once.
    expect(seedSpy).toHaveBeenCalledTimes(1);
  });

  it('Apply_DryRun_EmitsNeither', async () => {
    const seedSpy = vi.fn(() => ({ wrote: true, path: '/tmp/repo/.exarchos.yml' }));
    const ctx = makeEventCtx();
    const input = makeInput([REMEDIABLE_CHECK], /* dryRun */ true);

    const result = await reconcileWithEvents(input, ctx, makeApplyCtx(seedSpy));

    // No events emitted on the dry-run path.
    expect((ctx.emit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // No side effect performed.
    expect(seedSpy).not.toHaveBeenCalled();
    // Dry-run still surfaces the plan it WOULD apply.
    expect(result.plan.steps).toHaveLength(1);
  });

  it('Apply_RequestedWithoutExecuted_RecoversResidualOnly', async () => {
    // The first run "crashed": a dangling onboard.requested with the SAME
    // idempotencyKey and NO paired onboard.executed sits on the tail. Its plan
    // already lists the step — but on re-detect the config is now half-applied,
    // so the residual diff is what must actually run.
    const seedSpy = vi.fn(() => ({ wrote: true, path: '/tmp/repo/.exarchos.yml' }));
    const input = makeInput([REMEDIABLE_CHECK]);

    // Derive the key the wrapper would compute so the seeded dangling event
    // collides with the recovery run.
    const danglingKey = `onboard:/tmp/repo:onboard`;
    const dangling: EmittedEvent = {
      type: 'onboard.requested',
      data: {
        trigger: 'onboard',
        idempotencyKey: danglingKey,
        plan: { steps: [{ kind: 'config', surface: 'any', key: 'state-dir', description: 'x' }] },
      },
    };
    const ctx = makeEventCtx([dangling]);

    await reconcileWithEvents(input, ctx, makeApplyCtx(seedSpy));

    const emits = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as EmittedEvent,
    );
    // Recovery emits ONLY the missing executed half — no second requested.
    expect(emits.filter((e) => e.type === 'onboard.requested')).toHaveLength(0);
    expect(emits.filter((e) => e.type === 'onboard.executed')).toHaveLength(1);

    // The executed event pairs to the dangling requested via the shared key.
    const exe = emits.find((e) => e.type === 'onboard.executed')!;
    expect((exe.data as { idempotencyKey: string }).idempotencyKey).toBe(danglingKey);

    // The (residual) side effect ran AT MOST once across the crash.
    expect(seedSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('Apply_Retry_SideEffectAtMostOnce (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (retries) => {
        const seedSpy = vi.fn(() => ({ wrote: true, path: '/tmp/repo/.exarchos.yml' }));
        const input = makeInput([REMEDIABLE_CHECK]);
        // Shared seam → shared tail across every invocation (same logical run).
        const ctx = makeEventCtx();
        const applyCtx = makeApplyCtx(seedSpy);

        for (let i = 0; i < retries; i++) {
          await reconcileWithEvents(input, ctx, applyCtx);
        }

        const emits = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.map(
          (c) => c[0] as EmittedEvent,
        );
        // The completed run is recorded exactly once: one executed total.
        expect(emits.filter((e) => e.type === 'onboard.executed')).toHaveLength(1);
        // And the non-idempotent side effect fired at most once across retries.
        expect(seedSpy.mock.calls.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 25 },
    );
  });
});
