/**
 * Tests for `doctor --fix` (DR-4 / task 013).
 *
 * `doctor --fix` must repair drift by routing through the SAME reconciler
 * `apply` that `onboard` uses — via `reconcileWithEvents` with
 * `trigger: 'doctor-fix'` — so the two converge by construction (DR-4
 * acceptance). Bare `doctor` (no `--fix`) stays read-only: it runs the checks
 * and emits ONLY `diagnostic.executed`, never an `onboard.*` event, never a
 * write through `apply`.
 *
 * These tests drive the public `handleDoctorWithChecks` seam with an injected
 * `fixDeps` bundle (a temp-dir-free, in-memory event store + a stateful
 * `runDoctorChecks` that flips from drift to clean after a config seed). The
 * convergence test then runs a `doctor-fix` reconcile followed by an
 * `onboard`-trigger reconcile over the SAME store + repo and asserts the second
 * is a no-op — exactly because both go through the one reconciler.
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

// ─── In-memory event store double ──────────────────────────────────────────────

/**
 * A minimal in-memory event store: records every append and replays them on
 * query. Shape-compatible with the slice of `EventStore` the doctor + reconcile
 * paths touch (`append` + `query`).
 */
interface StoredEvent {
  readonly type: string;
  readonly data: unknown;
}

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

// ─── Drift fixture ─────────────────────────────────────────────────────────────

/**
 * One remediable `config` check (`state-dir`) that flips to `Pass` once the
 * injected seed has run. Mirrors the real reconcile loop: the check reports
 * drift, the reconciler's `apply` seeds config, and the post-apply re-run is
 * clean — which is what makes the `doctor --fix` re-diff and the subsequent
 * `onboard` both converge to the empty plan.
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
 * A `fixDeps` bundle whose `apply` seam seeds the fixture state (flipping the
 * drift check to Pass) and whose event seam appends through the dispatch
 * context's in-memory store. The `runDoctorChecks` is the SAME stateful probe
 * the bare-doctor check list reads, so the apply genuinely reconciles the drift.
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
    // The config seeder is the side effect that reconciles `state-dir`: it
    // flips the fixture's `seeded` flag so the post-apply re-run is clean.
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
    // Detection is stubbed off the filesystem so the test never touches $HOME.
    detectOptions: { vcs: 'git', detectRuntimes: async () => [] },
  };
}

// ─── DR-4 ───────────────────────────────────────────────────────────────────

describe('doctor --fix (DR-4)', () => {
  it('DoctorFix_ReconcilableDrift_ConvergesWithOnboard', async () => {
    // Arrange: a repo with one reconcilable drift (`state-dir` failing).
    const { store, appended } = makeInMemoryStore();
    const ctx = ctxWith(store);
    const state = { seeded: false };
    const { checks, runDoctorChecks } = makeDriftChecks(state);
    const fixDeps = makeFixDeps(state, runDoctorChecks);

    // Act: doctor --fix repairs the drift through the shared reconciler.
    const result = await handleDoctorWithChecks(
      { fix: true },
      ctx,
      checks,
      () => makeStubProbes(),
      fixDeps,
    );

    // Assert: the run succeeded and the side effect ran.
    expect(result.success).toBe(true);
    expect(state.seeded).toBe(true);

    // The fix path emits the shared two-event split with trigger `doctor-fix`
    // — NOT `diagnostic.executed`.
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

    // Convergence (DR-4): the post-fix re-diff is clean — every check Pass.
    const data = result.data as { checks: CheckResult[]; postFix?: { residual?: { steps: unknown[] } } };
    expect(data.checks.every((c) => c.status === 'Pass')).toBe(true);

    // ...AND a subsequent `onboard`-trigger reconcile over the SAME repo +
    // store is a no-op (empty plan, no apply side effect), because both go
    // through the one reconciler. We drive it directly to prove convergence.
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
    // The repo is already reconciled: the plan is empty (no remediable checks).
    expect(onboardOutcome.plan.steps).toHaveLength(0);
    expect(onboardOutcome.result?.applied ?? []).toHaveLength(0);
  });

  it('DoctorBare_NoFix_ReadOnlyEmitsDiagnosticOnly', async () => {
    // Arrange: the same reconcilable drift, but bare doctor (no --fix).
    const { store, appended } = makeInMemoryStore();
    const ctx = ctxWith(store);
    const state = { seeded: false };
    const { checks } = makeDriftChecks(state);

    // Act: bare doctor — read-only diagnosis.
    const result = await handleDoctorWithChecks(
      {},
      ctx,
      checks,
      () => makeStubProbes(),
    );

    // Assert: succeeds, reports the drift, but performs NO repair.
    expect(result.success).toBe(true);
    expect(state.seeded).toBe(false);
    const data = result.data as { checks: CheckResult[] };
    expect(data.checks.some((c) => c.status === 'Fail')).toBe(true);

    // Exactly ONE diagnostic.executed event; NO onboard.* events, no apply.
    const types = appended.map((a) => a.event.type);
    expect(types).toEqual(['diagnostic.executed']);
    expect(types).not.toContain('onboard.requested');
    expect(types).not.toContain('onboard.executed');
  });
});
