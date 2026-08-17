/**
 * Tests for `handleOnboard` (task 010, DR-2) — the `onboard` verb handler that
 * composes the Wave-1 reconciler into the full pipeline:
 *
 *   DETECT → CONFIG → GENERATE → INSTALL → VERIFY
 *
 * The handler wires the pure reconciler (`reconcileWithEvents` from task 009)
 * over a REAL {@link EventStore} (its `emit`/`readStreamTail` seam) and the
 * apply-side {@link ApplyCtx} (writers + injected install/hook hooks), then
 * VERIFIES by re-running the doctor checks and re-`diff`-ing for a residual
 * blocking Fail.
 *
 * Scope boundary (later tasks): the REAL skills/deps install (task 015), the
 * REAL #1485 hook installer (task 012), the `--new` greenfield scaffold
 * (task 016) and the CLI/registry action registration (task 011) are NOT
 * implemented here. They are exercised as STUBBABLE `ctx` hooks — these tests
 * inject success and assert the pipeline composes + VERIFY converges.
 *
 * Test style mirrors `reconcile.apply.test.ts` (temp dirs, real-fs WriterDeps
 * redirected at the fixture) and `reconcile.events.test.ts` (the EventStore is
 * real but state-dir-isolated; `runDoctorChecks` is an injected seam so the
 * pipeline drives a deterministic plan).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { ONBOARD_STREAM_ID } from '../../../../src/dispatch/core/infra-streams.js';
import type { CheckResult } from '../../../../src/verbs/doctor/schema.js';
import { buildWriterDeps } from '../../../../src/verbs/init/probes.js';
import type { WriterDeps } from '../../../../src/verbs/init/probes.js';

import { handleOnboard, type HandleOnboardArgs, type OnboardDeps } from '../../../../src/verbs/onboard/index.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly base: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

/** A temp repo (Node toolchain marker so the seed resolves commands) + an
 * isolated EventStore state dir, wired into a minimal DispatchContext.
 *
 * `declareConfig` (default `true`) pre-writes an `.exarchos.yml` declaring the
 * verification commands the node toolchain resolves (`mutation: npx stryker run`).
 * Without it, the §4.5-seed divergence path would add a `verification-command-*`
 * config step to EVERY plan (the node fixture resolves mutation from detection,
 * undeclared), which is orthogonal to these doctor-check-drift tests. Pre-
 * declaring it makes the verification command already-declared (no seed step), so
 * each test's plan reflects only its INJECTED doctor-check drift. The one test
 * that asserts the repo has NO `.exarchos.yml` (dry-run) opts out. */
async function createFixture(declareConfig = true): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'onboard-'));
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
  if (declareConfig) {
    await writeFile(
      path.join(repoRoot, '.exarchos.yml'),
      'test: npm run test:run\nmutation: npx stryker run\n',
      'utf8',
    );
  }
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
 * Build a `runDoctorChecks` seam that returns `before` on the first call (the
 * DETECT→diff plan input) and `after` on the second (the VERIFY re-diff). This
 * is the deterministic two-phase drift surface the pipeline reconciles.
 */
function twoPhaseChecks(
  before: readonly CheckResult[],
  after: readonly CheckResult[],
): { run: OnboardDeps['runDoctorChecks'] } {
  let n = 0;
  const run: OnboardDeps['runDoctorChecks'] = async () => {
    n += 1;
    return n === 1 ? [...before] : [...after];
  };
  return { run };
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

/** Read the onboard stream's events (the two-event split lands here). */
async function onboardEvents(fx: Fixture): Promise<string[]> {
  const events = await fx.eventStore.query(ONBOARD_STREAM_ID);
  return events.map((e) => e.type);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleOnboard (DR-2 — onboard verb + pipeline)', () => {
  it('Onboard_FreshRepo_ReachesGreenDoctor', async () => {
    const fx = await createFixture();
    try {
      // Fresh repo: a blocking config Fail + a cli-only install Fail before
      // apply; both gone after apply (green doctor on the VERIFY re-diff).
      const { run } = twoPhaseChecks([CONFIG_FAIL, INSTALL_FAIL], [GREEN]);
      const installStep = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps(fx, { runDoctorChecks: run, installStep });

      const args: HandleOnboardArgs = { surface: 'cli', format: 'json' };
      const result = await handleOnboard(args, fx.ctx, deps);

      // Pipeline drove the repo to green: success, no blocking residual.
      expect(result.success).toBe(true);

      // The injected install hook ran for the cli-only step (INSTALL stage).
      expect(installStep).toHaveBeenCalled();

      // VERIFY re-diff is empty (green) → carrier shape with a doctor pointer.
      const data = result.data as {
        plan: { steps: unknown[] };
        verify: { residualBlocking: number };
      };
      expect(data.verify.residualBlocking).toBe(0);

      // next_actions carries a pointer to `doctor` (the read-only diagnosis).
      const verbs = (result.next_actions ?? []).map((a) => a.verb);
      expect(verbs).toContain('doctor');

      // The two-event split landed on the onboard stream.
      const types = await onboardEvents(fx);
      expect(types).toContain('onboard.requested');
      expect(types).toContain('onboard.executed');
      expect(types.indexOf('onboard.requested')).toBeLessThan(
        types.indexOf('onboard.executed'),
      );
    } finally {
      await cleanup(fx);
    }
  });

  it('Onboard_Rerun_ReconcilesDriftOnly', async () => {
    const fx = await createFixture();
    try {
      // First run: already-onboarded repo (green before AND after) → no-op.
      const firstDeps = makeDeps(fx, { runDoctorChecks: async () => [GREEN] });
      const first = await handleOnboard({ surface: 'cli' }, fx.ctx, firstDeps);
      expect(first.success).toBe(true);
      const firstData = first.data as { plan: { steps: unknown[] } };
      // Green-before ⇒ the plan is empty (nothing to reconcile).
      expect(firstData.plan.steps).toHaveLength(0);

      // Second run injects drift: one config Fail before, green after apply.
      // Only the injected drift step is reconciled; the rest stay untouched.
      const { run } = twoPhaseChecks([CONFIG_FAIL], [GREEN]);
      const seed = vi.fn(() => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') }));
      const secondDeps = makeDeps(fx, { runDoctorChecks: run, seed });
      const second = await handleOnboard({ surface: 'cli' }, fx.ctx, secondDeps);

      expect(second.success).toBe(true);
      const secondData = second.data as {
        plan: { steps: { key: string }[] };
        result: { applied: { key: string }[] };
        verify: { residualBlocking: number };
      };
      // Exactly the drift step was planned + applied; VERIFY is green.
      expect(secondData.plan.steps.map((s) => s.key)).toEqual(['state-dir']);
      expect(secondData.result.applied.map((s) => s.key)).toEqual(['state-dir']);
      expect(secondData.verify.residualBlocking).toBe(0);
      // The drift-only side effect ran once.
      expect(seed).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup(fx);
    }
  });

  it('Onboard_DryRun_PrintsPlanWritesNothing', async () => {
    // Opt out of the pre-declared `.exarchos.yml` — this test asserts the repo
    // has NO config file after the dry-run (proving zero writes).
    const fx = await createFixture(false);
    try {
      const seed = vi.fn(() => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') }));
      const installStep = vi.fn().mockResolvedValue(undefined);
      const installHook = vi.fn().mockResolvedValue(undefined);
      const { run } = twoPhaseChecks([CONFIG_FAIL, INSTALL_FAIL], [GREEN]);
      const deps = makeDeps(fx, { runDoctorChecks: run, seed, installStep, installHook });

      const result = await handleOnboard({ surface: 'cli', dryRun: true }, fx.ctx, deps);

      // Dry-run surfaces the plan it WOULD apply.
      expect(result.success).toBe(true);
      const data = result.data as { plan: { steps: { key: string }[] }; dryRun: boolean };
      expect(data.dryRun).toBe(true);
      expect(data.plan.steps.length).toBeGreaterThan(0);

      // Zero writes: no side-effect hook fired.
      expect(seed).not.toHaveBeenCalled();
      expect(installStep).not.toHaveBeenCalled();
      expect(installHook).not.toHaveBeenCalled();

      // Zero events: the two-event split never emitted on dry-run.
      const types = await onboardEvents(fx);
      expect(types).toHaveLength(0);

      // No `.exarchos.yml` was written to the fixture repo.
      const entries = await readdir(fx.repoRoot);
      expect(entries).not.toContain('.exarchos.yml');
    } finally {
      await cleanup(fx);
    }
  });
});
