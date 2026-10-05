import { describe, it, expect, vi } from 'vitest';
import { fc } from '@fast-check/vitest';

import { reconcileWithEvents } from '../../../../../src/dispatch/core/onboarding/reconcile.js';
import type {
  ReconcileEventCtx,
  ReconcileEventInput,
  EmittedEvent,
} from '../../../../../src/dispatch/core/onboarding/reconcile.js';
import type { ApplyCtx } from '../../../../../src/dispatch/core/onboarding/reconcile.js';
import type { CheckResult } from '../../../../../src/verbs/doctor/schema.js';
import type { PlanStep, ReconcileResult } from '../../../../../src/dispatch/core/onboarding/types.js';

/** A remediable config check. `diff` gives exactly one `config` step for it. */
const REMEDIABLE_CHECK: CheckResult = {
  name: 'state-dir',
  category: 'storage',
  status: 'Fail',
  message: 'state dir missing',
  fix: 'create the state directory',
};

/**
 * An `ApplyCtx` on the `cli` surface with the given seeder. Each test passes a spy that reports a
 * write, so the one step lands in `applied` and the test can count the seeder calls.
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
 * Builds a `reconcileWithEvents` input with injected doctor checks, an injected runtime probe and a
 * fixed `vcs`. Command detection still runs the real resolver on the path `/tmp/repo`.
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
 * An in-memory event seam. `emit` records each event. `readStreamTail` returns a fresh copy of the
 * seed and every recorded event.
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

/**
 * `reconcileWithEvents` emits `onboard.requested`, runs the side effect, then emits
 * `onboard.executed`. After a crash between the two events, a re-run emits only the second event.
 * Spies replace the event seam, so no test opens an event store.
 */
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

    const reqKey = (emits[0].data as { idempotencyKey: string }).idempotencyKey;
    const exeKey = (emits[1].data as { idempotencyKey: string }).idempotencyKey;
    expect(reqKey).toBeTruthy();
    expect(exeKey).toBe(reqKey);

    expect((emits[0].data as { plan: { steps: PlanStep[] } }).plan.steps).toHaveLength(1);
    expect((emits[1].data as { result: ReconcileResult }).result.applied).toHaveLength(1);
    expect(typeof (emits[1].data as { durationMs: number }).durationMs).toBe('number');

    expect(seedSpy).toHaveBeenCalledTimes(1);
  });

  it('Apply_DryRun_EmitsNeither', async () => {
    const seedSpy = vi.fn(() => ({ wrote: true, path: '/tmp/repo/.exarchos.yml' }));
    const ctx = makeEventCtx();
    const input = makeInput([REMEDIABLE_CHECK], true);

    const result = await reconcileWithEvents(input, ctx, makeApplyCtx(seedSpy));

    expect((ctx.emit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(seedSpy).not.toHaveBeenCalled();
    expect(result.plan.steps).toHaveLength(1);
  });

  /**
   * The seeded tail holds an `onboard.requested` with the key that the wrapper derives, and no
   * paired `onboard.executed`. The re-run emits only the missing `onboard.executed`, with that key.
   */
  it('Apply_RequestedWithoutExecuted_RecoversResidualOnly', async () => {
    const seedSpy = vi.fn(() => ({ wrote: true, path: '/tmp/repo/.exarchos.yml' }));
    const input = makeInput([REMEDIABLE_CHECK]);

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
    expect(emits.filter((e) => e.type === 'onboard.requested')).toHaveLength(0);
    expect(emits.filter((e) => e.type === 'onboard.executed')).toHaveLength(1);

    const exe = emits.find((e) => e.type === 'onboard.executed')!;
    expect((exe.data as { idempotencyKey: string }).idempotencyKey).toBe(danglingKey);

    expect(seedSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  /** Every retry shares one event seam, so each retry reads the tail that the first run wrote. */
  it('Apply_Retry_SideEffectAtMostOnce (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (retries) => {
        const seedSpy = vi.fn(() => ({ wrote: true, path: '/tmp/repo/.exarchos.yml' }));
        const input = makeInput([REMEDIABLE_CHECK]);
        const ctx = makeEventCtx();
        const applyCtx = makeApplyCtx(seedSpy);

        for (let i = 0; i < retries; i++) {
          await reconcileWithEvents(input, ctx, applyCtx);
        }

        const emits = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.map(
          (c) => c[0] as EmittedEvent,
        );
        expect(emits.filter((e) => e.type === 'onboard.executed')).toHaveLength(1);
        expect(seedSpy.mock.calls.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 25 },
    );
  });
});
