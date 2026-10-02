/**
 * Failure modes of the `onboard` pipeline.
 *
 * 1. An offline `npx` install failure is forward-only. The install step goes to `residual` with an advisory, and applied steps stay applied.
 *    The run fails, and a re-run resumes from the residual.
 * 2. A blocking `Fail` in the VERIFY residual gives a failed `ToolResult` with a `suggestedFix` that points at doctor.
 * 3. DETECT omits an unresolved toolchain command and does not make up a default. The run does not crash.
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
import { detectDesiredState } from '../../../../src/dispatch/core/onboarding/reconcile.js';

import { handleOnboard, type HandleOnboardArgs, type OnboardDeps } from '../../../../src/verbs/onboard/index.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

interface Fixture {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly base: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

/** A temp repo with a Node toolchain marker, and an isolated `EventStore` state dir. */
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

/** A `WriterDeps` on the real fs, with `cwd` and `home` set to the fixture repo. */
function fixtureWriterDeps(fx: Fixture): WriterDeps {
  const real = buildWriterDeps();
  return { ...real, cwd: () => fx.repoRoot, home: () => fx.repoRoot };
}

/** A config check that `diff` turns into a `config` plan step. */
const CONFIG_FAIL: CheckResult = {
  category: 'storage',
  name: 'state-dir',
  status: 'Fail',
  message: 'state dir missing',
  fix: 'create the state directory',
  durationMs: 0,
};

/** A cli-only check that `diff` turns into an `install` plan step. */
const INSTALL_FAIL: CheckResult = {
  category: 'plugin',
  name: 'plugin-skill-hash-sync',
  status: 'Fail',
  message: 'skills bundle out of sync',
  fix: 'reinstall the skills bundle',
  durationMs: 0,
};

/** A passing check. It adds no plan step. */
const GREEN: CheckResult = {
  category: 'storage',
  name: 'state-dir',
  status: 'Pass',
  message: 'state dir present',
  durationMs: 0,
};

/**
 * A `runDoctorChecks` seam. Each call returns the next phase: first DETECT, then VERIFY.
 * A call after the last phase returns the last phase again.
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

/** Default deps for a fixture run. A test overrides the fields that it needs. */
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

/** The event types on the onboard stream, where `onboard.requested` and `onboard.executed` land. */
async function onboardEventTypes(fx: Fixture): Promise<string[]> {
  const events = await fx.eventStore.query(ONBOARD_STREAM_ID);
  return events.map((e) => e.type);
}

describe('onboard failure modes (DR-10, task 019)', () => {
  /**
   * DETECT finds a config Fail and an install Fail. The config step applies, and the install step throws a network error.
   * VERIFY still sees the install Fail, so the run fails but keeps the config step. A re-run with a working install reaches green.
   */
  it('Install_OfflineNpxFailure_ExitsNonZeroForwardOnly', async () => {
    const fx = await createFixture();
    try {
      const offlineError = new Error('npm ERR! network ENOTFOUND registry.npmjs.org');
      const installStep = vi.fn().mockRejectedValue(offlineError);
      const seed = vi.fn(() => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') }));
      const deps = makeDeps(fx, {
        runDoctorChecks: phasedChecks([CONFIG_FAIL, INSTALL_FAIL], [INSTALL_FAIL]),
        installStep,
        seed,
      });

      const args: HandleOnboardArgs = { surface: 'cli', format: 'json' };

      const result = await handleOnboard(args, fx.ctx, deps);

      expect(installStep).toHaveBeenCalled();

      expect(result.success).toBe(false);

      expect(seed).toHaveBeenCalled();

      const data = result.data as {
        result?: {
          applied: { key: string }[];
          residual: { key: string }[];
          advisories: { message: string }[];
        };
      };
      expect(data.result?.applied.map((s) => s.key)).toContain('state-dir');
      expect(data.result?.residual.map((s) => s.key)).toContain('plugin-skill-hash-sync');
      expect(
        (data.result?.advisories ?? []).some((a) =>
          /install|npx|offline|network|failed/i.test(a.message),
        ),
      ).toBe(true);

      const types = await onboardEventTypes(fx);
      expect(types).toContain('onboard.requested');
      expect(types).toContain('onboard.executed');

      const installStep2 = vi.fn().mockResolvedValue(undefined);
      const deps2 = makeDeps(fx, {
        runDoctorChecks: phasedChecks([INSTALL_FAIL], [GREEN]),
        installStep: installStep2,
      });
      const rerun = await handleOnboard(args, fx.ctx, deps2);

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

  /**
   * Apply cannot fix this blocking check, so VERIFY still sees it fail. This models an environment gap that the pipeline cannot fix.
   * The error names the check and points at doctor.
   */
  it('Verify_ResidualBlockingFail_ExitsWithDoctorDiff', async () => {
    const fx = await createFixture();
    try {
      const STILL_FAILING: CheckResult = {
        category: 'plugin',
        name: 'plugin-version-match',
        status: 'Fail',
        message: 'plugin version mismatch persists',
        fix: 'reinstall the plugin to match the marketplace version',
        durationMs: 0,
      };
      const deps = makeDeps(fx, {
        runDoctorChecks: phasedChecks([STILL_FAILING], [STILL_FAILING]),
        installStep: vi.fn().mockResolvedValue(undefined),
      });

      const result = await handleOnboard({ surface: 'cli', format: 'json' }, fx.ctx, deps);

      expect(result.success).toBe(false);

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('ONBOARD_RESIDUAL_BLOCKING');
      expect(result.error?.suggestedFix).toBeDefined();
      expect(result.error?.suggestedFix?.tool).toBe('exarchos_orchestrate');
      expect((result.error?.suggestedFix?.params as { action?: string })?.action).toBe('doctor');

      expect(result.error?.message).toContain('plugin-version-match');
      const data = result.data as {
        verify: { residualBlocking: number; blockingChecks: string[] };
      };
      expect(data.verify.residualBlocking).toBeGreaterThan(0);
      expect(data.verify.blockingChecks).toContain('plugin-version-match');

      const verbs = (result.next_actions ?? []).map((a) => a.verb);
      expect(verbs).toContain('doctor');
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * A repo with no toolchain markers resolves no test, typecheck, or install command. DETECT must omit these fields, not make up a default.
   * With nothing to fix, the full run succeeds and writes no `.exarchos.yml`.
   */
  it('Detect_UnresolvedToolchain_WarnsWritesNoFabricatedCommand', async () => {
    const fx = await createFixture();
    try {
      const bare = path.join(fx.base, 'bare');
      await mkdir(bare, { recursive: true });

      const desired = await detectDesiredState(bare, {
        detectRuntimes: async () => [],
        vcs: 'none',
      });

      expect(desired.commands.test).toBeUndefined();
      expect(desired.commands.typecheck).toBeUndefined();
      expect(desired.commands.install).toBeUndefined();

      const values = Object.values(desired.commands).filter((v): v is string => v !== undefined);
      expect(values.some((c) => /^npm |^npx |vitest|jest|tsc/.test(c))).toBe(false);

      const bareFx: Fixture = { ...fx, repoRoot: bare };
      const deps = makeDeps(bareFx, {
        runDoctorChecks: phasedChecks([GREEN], [GREEN]),
        detectOptions: { detectRuntimes: async () => [], vcs: 'none' },
      });
      const result = await handleOnboard({ surface: 'cli' }, fx.ctx, deps);

      expect(result.success).toBe(true);

      const entries = await readdir(bare);
      expect(entries).not.toContain('.exarchos.yml');
    } finally {
      await cleanup(fx);
    }
  });
});
