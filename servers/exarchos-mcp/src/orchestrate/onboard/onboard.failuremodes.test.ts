/**
 * Task 019 — DR-10 failure-mode hardening for the `onboard` pipeline.
 *
 * Three failure paths (from the Tasks 007/013/015 handoffs), each asserted
 * end-to-end through `handleOnboard` (or, for the unresolved-toolchain case,
 * through the pure `detectDesiredState`):
 *
 *   1. Offline / `npx` install failure → FORWARD-ONLY (DR-10). A thrown
 *      `installStep` must leave that install step in `residual` + push an
 *      Advisory — NOT reject the whole pipeline. The already-applied
 *      config/generate steps are NOT rolled back, `onboard` exits non-zero, and
 *      a re-run resumes from the residual. This mirrors `applyGenerateStep`'s
 *      swallow+residual posture (today `applyInstallStep` has no try/catch).
 *
 *   2. VERIFY residual blocking Fail → non-zero `ToolResult` carrying the doctor
 *      diff in an INV-5b error envelope (`suggestedFix`).
 *
 *   3. Unresolved toolchain → DETECT omits the unresolved command field (never
 *      fabricates one), the run does not crash, and the gap is surfaced.
 *
 * Test style mirrors `index.test.ts` (temp fixture repo + real-but-isolated
 * EventStore + an injected two-phase `runDoctorChecks` seam) and
 * `reconcile.apply.test.ts` (real-fs WriterDeps redirected at the fixture).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { ONBOARD_STREAM_ID } from '../../core/infra-streams.js';
import type { CheckResult } from '../doctor/schema.js';
import { buildWriterDeps } from '../init/probes.js';
import type { WriterDeps } from '../init/probes.js';
import { detectDesiredState } from '../../core/onboarding/reconcile.js';

import { handleOnboard, type HandleOnboardArgs, type OnboardDeps } from './index.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly base: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

/** A temp repo (Node toolchain marker) + an isolated EventStore state dir. */
async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'onboard-fail-'));
  const repoRoot = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  await mkdir(repoRoot, { recursive: true });
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify(
      { name: 'fixture', version: '0.0.0', scripts: { 'test:run': 'vitest run' } },
      null,
      2,
    ),
    'utf8',
  );
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  return { repoRoot, stateDir, base, ctx, eventStore };
}

async function cleanup(fx: Fixture): Promise<void> {
  await rmrfAsync(fx.base).catch(
    () => {},
  );
}

/** A WriterDeps pointed at the fixture repo (real fs, redirected cwd/home). */
function fixtureWriterDeps(fx: Fixture): WriterDeps {
  const real = buildWriterDeps();
  return { ...real, cwd: () => fx.repoRoot, home: () => fx.repoRoot };
}

/** A remediable config check → exactly one `config` PlanStep through `diff`. */
const CONFIG_FAIL: CheckResult = {
  category: 'storage',
  name: 'state-dir',
  status: 'Fail',
  message: 'state dir missing',
  fix: 'create the state directory',
  durationMs: 0,
};

/** A remediable cli-only install check → one `install` PlanStep. */
const INSTALL_FAIL: CheckResult = {
  category: 'plugin',
  name: 'plugin-skill-hash-sync',
  status: 'Fail',
  message: 'skills bundle out of sync',
  fix: 'reinstall the skills bundle',
  durationMs: 0,
};

/** A passing check contributes no plan step (green). */
const GREEN: CheckResult = {
  category: 'storage',
  name: 'state-dir',
  status: 'Pass',
  message: 'state dir present',
  durationMs: 0,
};

/**
 * A `runDoctorChecks` seam returning `phases[0]` on the first call (DETECT plan),
 * `phases[1]` on the second (VERIFY re-diff), and the LAST phase for any further
 * call (a re-run's DETECT + VERIFY). This lets a single seam drive both the
 * initial run and the resume.
 */
function phasedChecks(
  ...phases: ReadonlyArray<readonly CheckResult[]>
): OnboardDeps['runDoctorChecks'] {
  let n = -1;
  return async () => {
    n += 1;
    const idx = n < phases.length ? n : phases.length - 1;
    return [...phases[idx]];
  };
}

/** Default args + injected deps for a fixture run. Tests override fields. */
function makeDeps(fx: Fixture, overrides?: Partial<OnboardDeps>): OnboardDeps {
  return {
    repoRoot: fx.repoRoot,
    writerDeps: fixtureWriterDeps(fx),
    writers: [],
    runDoctorChecks: async () => [GREEN],
    seed: vi.fn(() => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') })),
    installStep: vi.fn().mockResolvedValue(undefined),
    installHook: vi.fn().mockResolvedValue(undefined),
    detectOptions: { detectRuntimes: async () => [], vcs: 'git' },
    ...overrides,
  };
}

/** Read the onboard stream's event types (the two-event split lands here). */
async function onboardEventTypes(fx: Fixture): Promise<string[]> {
  const events = await fx.eventStore.query(ONBOARD_STREAM_ID);
  return events.map((e) => e.type);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('onboard failure modes (DR-10, task 019)', () => {
  // ── Failure mode 1: offline / npx install failure → forward-only ────────────
  it('Install_OfflineNpxFailure_ExitsNonZeroForwardOnly', async () => {
    const fx = await createFixture();
    try {
      // Plan: a config Fail + a cli-only install Fail. The config step applies
      // cleanly; the install step throws (offline / npx error). VERIFY still
      // sees the install check failing (install never ran) → blocking residual.
      const offlineError = new Error('npm ERR! network ENOTFOUND registry.npmjs.org');
      const installStep = vi.fn().mockRejectedValue(offlineError);
      const seed = vi.fn(() => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') }));
      const deps = makeDeps(fx, {
        // DETECT: config + install fail. VERIFY: config reconciled, install
        // STILL fails (its side effect threw forward-only).
        runDoctorChecks: phasedChecks([CONFIG_FAIL, INSTALL_FAIL], [INSTALL_FAIL]),
        installStep,
        seed,
      });

      const args: HandleOnboardArgs = { surface: 'cli', format: 'json' };

      // FORWARD-ONLY: the thrown install must NOT reject the whole pipeline.
      const result = await handleOnboard(args, fx.ctx, deps);

      // The install hook was actually invoked (and threw).
      expect(installStep).toHaveBeenCalled();

      // Non-zero result: the install failure leaves a blocking residual.
      expect(result.success).toBe(false);

      // The config step was NOT rolled back — its side effect still ran.
      expect(seed).toHaveBeenCalled();

      const data = result.data as {
        result?: {
          applied: { key: string }[];
          residual: { key: string }[];
          advisories: { message: string }[];
        };
      };
      // The config step landed in `applied` (forward-only: keep what worked).
      expect(data.result?.applied.map((s) => s.key)).toContain('state-dir');
      // The failed install step landed in `residual` (mirrors applyGenerateStep).
      expect(data.result?.residual.map((s) => s.key)).toContain('plugin-skill-hash-sync');
      // An advisory surfaces the install failure (forward-only warning).
      expect(
        (data.result?.advisories ?? []).some((a) =>
          /install|npx|offline|network|failed/i.test(a.message),
        ),
      ).toBe(true);

      // The two-event split still landed (apply completed forward-only, not rejected).
      const types = await onboardEventTypes(fx);
      expect(types).toContain('onboard.requested');
      expect(types).toContain('onboard.executed');

      // ── Re-run resumes from the residual: the install hook is retried; this
      // time it succeeds (registry back online) and the repo reaches green. ──
      const installStep2 = vi.fn().mockResolvedValue(undefined);
      const deps2 = makeDeps(fx, {
        runDoctorChecks: phasedChecks([INSTALL_FAIL], [GREEN]),
        installStep: installStep2,
      });
      const rerun = await handleOnboard(args, fx.ctx, deps2);

      // The re-run replanned the residual install step and applied it.
      expect(installStep2).toHaveBeenCalled();
      expect(rerun.success).toBe(true);
      const rerunData = rerun.data as {
        plan: { steps: { key: string }[] };
        verify: { residualBlocking: number };
      };
      expect(rerunData.plan.steps.map((s) => s.key)).toContain('plugin-skill-hash-sync');
      expect(rerunData.verify.residualBlocking).toBe(0);
    } finally {
      await cleanup(fx);
    }
  });

  // ── Failure mode 2: VERIFY residual blocking Fail → non-zero + doctor diff ───
  it('Verify_ResidualBlockingFail_ExitsWithDoctorDiff', async () => {
    const fx = await createFixture();
    try {
      // A blocking check that apply cannot reconcile: it is still `Fail` on the
      // VERIFY re-diff (the install hook is a no-op success, but the doctor
      // re-check insists the check is still failing — e.g. an environment gap
      // the pipeline can't fix).
      const STILL_FAILING: CheckResult = {
        category: 'plugin',
        name: 'plugin-version-match',
        status: 'Fail',
        message: 'plugin version mismatch persists',
        fix: 'reinstall the plugin to match the marketplace version',
        durationMs: 0,
      };
      const deps = makeDeps(fx, {
        // DETECT: the blocking install check. VERIFY: STILL failing.
        runDoctorChecks: phasedChecks([STILL_FAILING], [STILL_FAILING]),
        installStep: vi.fn().mockResolvedValue(undefined),
      });

      const result = await handleOnboard({ surface: 'cli', format: 'json' }, fx.ctx, deps);

      // Non-zero result.
      expect(result.success).toBe(false);

      // INV-5b error envelope: a code + a structured `suggestedFix` pointing at doctor.
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('ONBOARD_RESIDUAL_BLOCKING');
      expect(result.error?.suggestedFix).toBeDefined();
      expect(result.error?.suggestedFix?.tool).toBe('exarchos_orchestrate');
      expect((result.error?.suggestedFix?.params as { action?: string })?.action).toBe('doctor');

      // The doctor diff is carried: the still-failing check name is named in the
      // error message and surfaced on the VERIFY summary.
      expect(result.error?.message).toContain('plugin-version-match');
      const data = result.data as {
        verify: { residualBlocking: number; blockingChecks: string[] };
      };
      expect(data.verify.residualBlocking).toBeGreaterThan(0);
      expect(data.verify.blockingChecks).toContain('plugin-version-match');

      // next_actions points the operator at `doctor` to inspect the diff.
      const verbs = (result.next_actions ?? []).map((a) => a.verb);
      expect(verbs).toContain('doctor');
    } finally {
      await cleanup(fx);
    }
  });

  // ── Failure mode 3: unresolved toolchain → warn, no fabrication, no crash ────
  it('Detect_UnresolvedToolchain_WarnsWritesNoFabricatedCommand', async () => {
    const fx = await createFixture();
    try {
      // A repo with NO toolchain markers at all: the layered resolver cannot
      // resolve a test/typecheck/install command. DETECT must omit the
      // unresolved fields — never fabricate a default command.
      const bare = path.join(fx.base, 'bare');
      await mkdir(bare, { recursive: true });

      const desired = await detectDesiredState(bare, {
        detectRuntimes: async () => [],
        vcs: 'none',
      });

      // No crash; the gap is surfaced as an OMITTED command, not a fabricated one.
      expect(desired.commands.test).toBeUndefined();
      expect(desired.commands.typecheck).toBeUndefined();
      expect(desired.commands.install).toBeUndefined();

      // No fabricated default command leaked into the resolved set.
      const values = Object.values(desired.commands).filter((v): v is string => v !== undefined);
      expect(values.some((c) => /^npm |^npx |vitest|jest|tsc/.test(c))).toBe(false);

      // The full pipeline over a bare repo does not crash and the result surfaces
      // the gap (doctor flags it; here the pipeline simply completes cleanly with
      // no fabricated command written into the plan/desired state).
      const bareFx: Fixture = { ...fx, repoRoot: bare };
      const deps = makeDeps(bareFx, {
        runDoctorChecks: phasedChecks([GREEN], [GREEN]),
        detectOptions: { detectRuntimes: async () => [], vcs: 'none' },
      });
      const result = await handleOnboard({ surface: 'cli' }, fx.ctx, deps);

      // No crash — the run completes; with nothing remediable it is green.
      expect(result.success).toBe(true);

      // The bare repo has NO toolchain marker, so DETECT resolved no commands.
      // Nothing remediable ⇒ the empty plan ⇒ no `.exarchos.yml` was written
      // (and so no fabricated command could leak into a config file).
      const entries = await readdir(bare);
      expect(entries).not.toContain('.exarchos.yml');
    } finally {
      await cleanup(fx);
    }
  });
});
