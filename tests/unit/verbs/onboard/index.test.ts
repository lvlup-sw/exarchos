/**
 * Tests `handleOnboard`, the `onboard` verb handler: DETECT → CONFIG → GENERATE → INSTALL → VERIFY.
 * The handler runs the reconciler over a real {@link EventStore} and the apply-side `ApplyCtx`.
 * VERIFY runs the doctor checks again and diffs for a blocking Fail that remains.
 *
 * The install, hook, and seed effects are injected stubs, so these tests check that the pipeline composes and VERIFY converges.
 * `runDoctorChecks` is an injected seam, so each run has a deterministic plan.
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

interface Fixture {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly base: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

/**
 * A temp repo with a Node toolchain marker and an isolated EventStore, wired into a minimal DispatchContext.
 * By default it also writes an `.exarchos.yml` that declares the verification commands the Node toolchain resolves.
 * Without that file, the seed divergence path adds a `verification-command-*` config step to each plan.
 * With the file, each plan holds only the injected doctor-check drift. The dry-run test opts out.
 */
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

describe('handleOnboard (DR-2 — onboard verb + pipeline)', () => {
  /**
   * Before apply, the repo has a blocking config Fail and a CLI-only install Fail.
   * After apply, the doctor is green, and `onboard.requested` comes before `onboard.executed` on the onboard stream.
   */
  it('Onboard_FreshRepo_ReachesGreenDoctor', async () => {
    const fx = await createFixture();
    try {
      const { run } = twoPhaseChecks([CONFIG_FAIL, INSTALL_FAIL], [GREEN]);
      const installStep = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps(fx, { runDoctorChecks: run, installStep });

      const args: HandleOnboardArgs = { surface: 'cli', format: 'json' };
      const result = await handleOnboard(args, fx.ctx, deps);

      expect(result.success).toBe(true);

      expect(installStep).toHaveBeenCalled();

      const data = result.data as {
        plan: { steps: unknown[] };
        verify: { residualBlocking: number };
      };
      expect(data.verify.residualBlocking).toBe(0);

      const verbs = (result.next_actions ?? []).map((a) => a.verb);
      expect(verbs).toContain('doctor');

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

  /**
   * The first run is on a green repo, so its plan is empty.
   * The second run injects one config Fail. Only that drift step is planned and applied, and its side effect runs once.
   */
  it('Onboard_Rerun_ReconcilesDriftOnly', async () => {
    const fx = await createFixture();
    try {
      const firstDeps = makeDeps(fx, { runDoctorChecks: async () => [GREEN] });
      const first = await handleOnboard({ surface: 'cli' }, fx.ctx, firstDeps);
      expect(first.success).toBe(true);
      const firstData = first.data as { plan: { steps: unknown[] } };
      expect(firstData.plan.steps).toHaveLength(0);

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
      expect(secondData.plan.steps.map((s) => s.key)).toEqual(['state-dir']);
      expect(secondData.result.applied.map((s) => s.key)).toEqual(['state-dir']);
      expect(secondData.verify.residualBlocking).toBe(0);
      expect(seed).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * The fixture has no `.exarchos.yml`, so the test can prove that the dry run writes nothing.
   * The dry run returns the plan, calls no side-effect hook, and appends no events.
   */
  it('Onboard_DryRun_PrintsPlanWritesNothing', async () => {
    const fx = await createFixture(false);
    try {
      const seed = vi.fn(() => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') }));
      const installStep = vi.fn().mockResolvedValue(undefined);
      const installHook = vi.fn().mockResolvedValue(undefined);
      const { run } = twoPhaseChecks([CONFIG_FAIL, INSTALL_FAIL], [GREEN]);
      const deps = makeDeps(fx, { runDoctorChecks: run, seed, installStep, installHook });

      const result = await handleOnboard({ surface: 'cli', dryRun: true }, fx.ctx, deps);

      expect(result.success).toBe(true);
      const data = result.data as { plan: { steps: { key: string }[] }; dryRun: boolean };
      expect(data.dryRun).toBe(true);
      expect(data.plan.steps.length).toBeGreaterThan(0);

      expect(seed).not.toHaveBeenCalled();
      expect(installStep).not.toHaveBeenCalled();
      expect(installHook).not.toHaveBeenCalled();

      const types = await onboardEvents(fx);
      expect(types).toHaveLength(0);

      const entries = await readdir(fx.repoRoot);
      expect(entries).not.toContain('.exarchos.yml');
    } finally {
      await cleanup(fx);
    }
  });
});
