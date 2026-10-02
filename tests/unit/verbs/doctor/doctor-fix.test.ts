/**
 * Tests for `doctor --fix`. The fix path repairs drift through the reconciler
 * `apply` that `onboard` uses, with `reconcileWithEvents` and
 * `trigger: 'doctor-fix'`. Bare `doctor` stays read-only. It emits only
 * `diagnostic.executed`, no `onboard.*` event, and no write through `apply`.
 *
 * The tests call `handleDoctorWithChecks` with an injected `fixDeps` bundle, an
 * in-memory event store, and a check that passes after the config seed runs.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { makeStubProbes } from '../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import type { CheckFn } from '../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import type { CheckResult } from '../../../../src/verbs/doctor/schema.js';
import { handleDoctorWithChecks, type DoctorFixDeps } from '../../../../src/verbs/doctor/index.js';
import {
  reconcileWithEvents,
  type EmittedEvent,
  type ReconcileEventCtx,
  type ApplyCtx,
} from '../../../../src/dispatch/core/onboarding/reconcile.js';
import type { WriterDeps } from '../../../../src/verbs/init/probes.js';

interface StoredEvent {
  readonly type: string;
  readonly data: unknown;
}

/**
 * An in-memory event store. It records each append and returns the appends of
 * a stream on `query`. It implements only `append` and `query`, which the
 * doctor and reconcile paths use.
 */
function makeInMemoryStore(): {
  store: DispatchContext['eventStore'];
  appended: Array<{ streamId: string; event: StoredEvent }>;
} {
  const appended: Array<{ streamId: string; event: StoredEvent }> = [];
  const store = {
    append: vi.fn(async (streamId: string, event: StoredEvent) => {
      appended.push({ streamId, event });
      return {};
    }),
    query: vi.fn(async (streamId: string) =>
      appended.filter((a) => a.streamId === streamId).map((a) => a.event),
    ),
  } as unknown as DispatchContext['eventStore'];
  return { store, appended };
}

function ctxWith(store: DispatchContext['eventStore']): DispatchContext {
  return {
    stateDir: '/tmp/doctor-fix-test',
    eventStore: store,
    enableTelemetry: false,
    cwd: '/tmp/doctor-fix-repo',
  } as DispatchContext;
}

/**
 * One remediable check (`state-dir`, a `config` plan step) that gives `Pass`
 * after the injected seed runs. The check reports drift, `apply` seeds the
 * config, and the next run is clean. Thus the `doctor --fix` re-diff and a
 * later `onboard` both get the empty plan.
 */
function makeDriftChecks(state: { seeded: boolean }): {
  checks: ReadonlyArray<CheckFn>;
  runDoctorChecks: (repoRoot: string) => Promise<readonly CheckResult[]>;
} {
  const driftCheck: CheckFn = async (): Promise<CheckResult> =>
    state.seeded
      ? {
          category: 'storage',
          name: 'state-dir',
          status: 'Pass',
          message: 'state dir present',
          durationMs: 0,
        }
      : {
          category: 'storage',
          name: 'state-dir',
          status: 'Fail',
          message: 'state dir missing',
          fix: 'create the exarchos state dir',
          durationMs: 0,
        };
  const checks: ReadonlyArray<CheckFn> = [driftCheck];
  const runDoctorChecks = async (): Promise<readonly CheckResult[]> => [
    await driftCheck(makeStubProbes(), new AbortController().signal),
  ];
  return { checks, runDoctorChecks };
}

/**
 * A `fixDeps` bundle. Its `seed` sets `state.seeded`, so the drift check gives
 * Pass on the next run. `runDoctorChecks` reads the same state as the check
 * list of bare doctor, so the apply really removes the drift. Detection uses
 * stubs, so the test does not touch `$HOME`.
 */
function makeFixDeps(
  state: { seeded: boolean },
  runDoctorChecks: (repoRoot: string) => Promise<readonly CheckResult[]>,
): DoctorFixDeps {
  const writerDeps = {
    cwd: () => '/tmp/doctor-fix-repo',
    home: () => '/tmp/doctor-fix-repo',
  } as unknown as WriterDeps;
  return {
    repoRoot: '/tmp/doctor-fix-repo',
    runDoctorChecks,
    writerDeps,
    writers: [],
    seed: (_repoRoot: string, _force: boolean) => {
      const wrote = !state.seeded;
      state.seeded = true;
      return wrote
        ? { wrote: true, path: '/tmp/doctor-fix-repo/.exarchos.yml', reason: 'created' as const }
        : {
            wrote: false,
            reason: 'already-exists' as const,
            path: '/tmp/doctor-fix-repo/.exarchos.yml',
          };
    },
    detectOptions: { vcs: 'git', detectRuntimes: async () => [] },
  };
}

describe('doctor --fix (DR-4)', () => {
  /**
   * The fix path emits `onboard.requested` and then `onboard.executed`, each with
   * trigger `doctor-fix`. After the fix, each check passes.
   * A later reconcile with trigger `onboard` over the same repo and store then
   * has an empty plan and applies nothing, because both use one reconciler.
   */
  it('DoctorFix_ReconcilableDrift_ConvergesWithOnboard', async () => {
    const { store, appended } = makeInMemoryStore();
    const ctx = ctxWith(store);
    const state = { seeded: false };
    const { checks, runDoctorChecks } = makeDriftChecks(state);
    const fixDeps = makeFixDeps(state, runDoctorChecks);

    const result = await handleDoctorWithChecks(
      { fix: true },
      ctx,
      checks,
      () => makeStubProbes(),
      fixDeps,
    );

    expect(result.success).toBe(true);
    expect(state.seeded).toBe(true);

    const onboardEvents = appended.filter(
      (a) => a.event.type === 'onboard.requested' || a.event.type === 'onboard.executed',
    );
    expect(onboardEvents.map((e) => e.event.type)).toEqual([
      'onboard.requested',
      'onboard.executed',
    ]);
    for (const e of onboardEvents) {
      expect((e.event.data as { trigger: string }).trigger).toBe('doctor-fix');
    }

    const data = result.data as { checks: CheckResult[]; postFix?: { residual?: { steps: unknown[] } } };
    expect(data.checks.every((c) => c.status === 'Pass')).toBe(true);

    const eventCtx: ReconcileEventCtx = {
      emit: async (event: EmittedEvent) => {
        appended.push({ streamId: 'exarchos-onboard', event });
      },
      readStreamTail: async () => [],
    };
    const applyCtx: ApplyCtx = {
      repoRoot: '/tmp/doctor-fix-repo',
      surface: 'cli',
      writerDeps: fixDeps.writerDeps,
      writers: [],
      ...(fixDeps.seed ? { seed: fixDeps.seed } : {}),
    };
    const onboardOutcome = await reconcileWithEvents(
      {
        repoRoot: '/tmp/doctor-fix-repo',
        trigger: 'onboard',
        runDoctorChecks,
        detectOptions: { vcs: 'git', detectRuntimes: async () => [] },
      },
      eventCtx,
      applyCtx,
    );
    expect(onboardOutcome.plan.steps).toHaveLength(0);
    expect(onboardOutcome.result?.applied ?? []).toHaveLength(0);
  });

  /**
   * Bare doctor reports the same drift but does not repair it. It emits one
   * `diagnostic.executed` event and no `onboard.*` event.
   */
  it('DoctorBare_NoFix_ReadOnlyEmitsDiagnosticOnly', async () => {
    const { store, appended } = makeInMemoryStore();
    const ctx = ctxWith(store);
    const state = { seeded: false };
    const { checks } = makeDriftChecks(state);

    const result = await handleDoctorWithChecks(
      {},
      ctx,
      checks,
      () => makeStubProbes(),
    );

    expect(result.success).toBe(true);
    expect(state.seeded).toBe(false);
    const data = result.data as { checks: CheckResult[] };
    expect(data.checks.some((c) => c.status === 'Fail')).toBe(true);

    const types = appended.map((a) => a.event.type);
    expect(types).toEqual(['diagnostic.executed']);
    expect(types).not.toContain('onboard.requested');
    expect(types).not.toContain('onboard.executed');
  });
});
