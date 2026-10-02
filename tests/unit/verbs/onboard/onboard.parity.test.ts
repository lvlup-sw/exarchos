/**
 * CLI and MCP parity tests for the `onboard` action. Onboard runs five steps:
 * DETECT, CONFIG, GENERATE, INSTALL, and VERIFY.
 *
 * For every step except INSTALL, the CLI and MCP arms must give the same
 * `ToolResult` for the same context and args. INSTALL runs `npx` and writes to
 * `~/.claude/`, so it is CLI-only. On a surface other than `'cli'`, the core
 * `apply` turns that step into a structured {@link Advisory} with
 * `surface: 'cli-only'`. The step never runs on the server and is never a
 * silent no-op. The gate is in the core, not in an adapter branch.
 *
 * The arms call `handleOnboard` directly with the surface of each carrier. The
 * `stampOnboardSurface` and `surfaceOnboardCliAdvisory` helpers test the MCP
 * adapter seam.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import type { CheckResult } from '../../../../src/verbs/doctor/schema.js';
import { buildWriterDeps } from '../../../../src/verbs/init/probes.js';
import type { WriterDeps } from '../../../../src/verbs/init/probes.js';
import { normalize as harnessNormalize } from '../../parity-harness.js';

import { handleOnboard, type HandleOnboardArgs, type OnboardDeps } from '../../../../src/verbs/onboard/index.js';
import {
  MCP_ONBOARD_SURFACE,
  stampOnboardSurface,
  surfaceOnboardCliAdvisory,
} from '../../../../src/adapters/mcp/mcp.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { BLOCK_DRIFT_CHECK_NAME } from '../../../../src/verbs/onboard/block-drift.js';
import { RETIRED_HOOKS_CHECK_NAME } from '../../../../src/verbs/onboard/hooks.js';

interface Fixture {
  readonly repoRoot: string;
  readonly base: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

/** A temp repo (Node toolchain marker) + an isolated EventStore. */
async function createFixture(prefix: string): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), prefix));
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
  return { repoRoot, base, ctx, eventStore };
}

async function cleanup(fx: Fixture): Promise<void> {
  await rmrfAsync(fx.base).catch(
    () => {},
  );
}

/** A WriterDeps pointed at the fixture repo. */
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

/** On-ramp block drift → a `generate` block-write PlanStep. */
const BLOCK_WRITE_DRIFT: CheckResult = {
  category: 'agent',
  name: BLOCK_DRIFT_CHECK_NAME,
  status: 'Warning',
  message: 'AGENTS.md on-ramp block drifted',
  fix: 'run exarchos onboard to re-write the on-ramp block',
  durationMs: 0,
};

/** Retired hooks present → a `hook` removal PlanStep. */
const RETIRED_HOOKS_DRIFT: CheckResult = {
  category: 'agent',
  name: RETIRED_HOOKS_CHECK_NAME,
  status: 'Warning',
  message: 'retired lifecycle hooks still installed',
  fix: 'run exarchos onboard to remove the retired lifecycle hooks',
  durationMs: 0,
};

/**
 * A `runDoctorChecks` seam returning `before` on call 1 (DETECT→diff) and
 * `after` on call 2 (the VERIFY re-diff).
 */
function twoPhaseChecks(
  before: readonly CheckResult[],
  after: readonly CheckResult[],
): OnboardDeps['runDoctorChecks'] {
  let n = 0;
  return async () => {
    n += 1;
    return n === 1 ? [...before] : [...after];
  };
}

/**
 * Builds the injected deps for one arm. The CLI surface runs the `installStep` hook, which writes to `~/.claude/`.
 * The MCP surface must not run it, so each arm gets its own spy. The seeder is fixed, so the config step is the same on both arms.
 */
function makeDeps(
  fx: Fixture,
  runDoctorChecks: OnboardDeps['runDoctorChecks'],
  installStep: ReturnType<typeof vi.fn>,
): OnboardDeps {
  return {
    repoRoot: fx.repoRoot,
    writerDeps: fixtureWriterDeps(fx),
    writers: [],
    runDoctorChecks,
    seed: () => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') }),
    installStep,
    installHook: vi.fn().mockResolvedValue(undefined),
    detectOptions: { detectRuntimes: async () => [], vcs: 'git' },
  };
}

/**
 * Normalize a `ToolResult` so two independent arm invocations compare equal —
 * strip the wall-clock `durationMs` and the per-dispatch `_meta`/`_perf`.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { durationMs: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
}

describe('exarchos onboard CLI/MCP parity (DR-6)', () => {
  /**
   * Both arms have the same drift: a config `Fail` before apply and green after. The plan has no install step,
   * so only the surface differs. The plan holds two config steps: the injected `state-dir` drift and the seeded
   * `verification-command-mutation` step. The node fixture detects `npx stryker run`, and `.exarchos.yml` does not declare it.
   */
  it('Parity_StepsOneToThreeAndFive_IdenticalAcrossSurfaces', async () => {
    const cliFx = await createFixture('onboard-parity-cli-');
    const mcpFx = await createFixture('onboard-parity-mcp-');
    try {
      const cliInstall = vi.fn().mockResolvedValue(undefined);
      const mcpInstall = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeDeps(cliFx, twoPhaseChecks([CONFIG_FAIL], [GREEN]), cliInstall);
      const mcpDeps = makeDeps(mcpFx, twoPhaseChecks([CONFIG_FAIL], [GREEN]), mcpInstall);

      const cliArgs: HandleOnboardArgs = { surface: 'cli', format: 'json' };
      const mcpArgs: HandleOnboardArgs = stampOnboardSurface({
        format: 'json',
      }) as HandleOnboardArgs;

      const cliResult = await handleOnboard(cliArgs, cliFx.ctx, cliDeps);
      const mcpResult = await handleOnboard(mcpArgs, mcpFx.ctx, mcpDeps);

      expect(cliResult.success).toBe(true);
      expect(mcpResult.success).toBe(true);

      const normalizedCli = normalize(cliResult);
      const normalizedMcp = normalize(mcpResult);
      expect(normalizedCli).toEqual(normalizedMcp);
      expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

      const cliData = cliResult.data as { plan: { steps: { kind: string; key: string }[] } };
      expect(cliData.plan.steps.map((s) => s.kind)).toEqual(['config', 'config']);
      expect(cliData.plan.steps.map((s) => s.key)).toEqual([
        'state-dir',
        'verification-command-mutation',
      ]);
    } finally {
      await cleanup(cliFx);
      await cleanup(mcpFx);
    }
  });

  /**
   * The plan holds a CLI-only install step. The CLI arm runs it. The MCP arm skips the effect and returns a
   * structured advisory, not an error. The MCP adapter adds an `onboard` pointer to the CLI in `next_actions`.
   */
  it('Parity_McpInstallStep_ReturnsStructuredAdvisory', async () => {
    const cliFx = await createFixture('onboard-advisory-cli-');
    const mcpFx = await createFixture('onboard-advisory-mcp-');
    try {
      const cliInstall = vi.fn().mockResolvedValue(undefined);
      const mcpInstall = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeDeps(
        cliFx,
        twoPhaseChecks([CONFIG_FAIL, INSTALL_FAIL], [GREEN]),
        cliInstall,
      );
      const mcpDeps = makeDeps(
        mcpFx,
        twoPhaseChecks([CONFIG_FAIL, INSTALL_FAIL], [GREEN]),
        mcpInstall,
      );

      const cliResult = await handleOnboard(
        { surface: 'cli', format: 'json' },
        cliFx.ctx,
        cliDeps,
      );
      expect(cliResult.success).toBe(true);
      expect(cliInstall).toHaveBeenCalledTimes(1);

      const mcpArgs = stampOnboardSurface({ format: 'json' }) as HandleOnboardArgs;
      const mcpRaw = await handleOnboard(mcpArgs, mcpFx.ctx, mcpDeps);
      const mcpResult = surfaceOnboardCliAdvisory(mcpRaw);

      expect(mcpResult.success).toBe(true);

      expect(mcpInstall).not.toHaveBeenCalled();

      const mcpData = mcpResult.data as {
        result?: { advisories: { surface: string; message: string; commands?: string[] }[] };
      };
      const advisories = mcpData.result?.advisories ?? [];
      const installAdvisory = advisories.find((a) => a.surface === 'cli-only');
      expect(installAdvisory).toBeDefined();
      expect(installAdvisory?.message.length ?? 0).toBeGreaterThan(0);
      expect(Array.isArray(installAdvisory?.commands)).toBe(true);
      expect((installAdvisory?.commands ?? []).some((c) => c.includes('onboard'))).toBe(true);

      const verbs = (mcpResult.next_actions ?? []).map((a) => a.verb);
      expect(verbs).toContain('onboard');
      const onboardHint = (mcpResult.next_actions ?? []).find((a) => a.verb === 'onboard');
      expect((onboardHint?.hint ?? '') + (onboardHint?.reason ?? '')).toContain('CLI');
    } finally {
      await cleanup(cliFx);
      await cleanup(mcpFx);
    }
  });

  /**
   * The block-write step comes before the retired-hooks removal step, and the result is byte-equal on both surfaces.
   * The pure core `diff` holds the order. With `writers: []` the block-write step stays residual, so apply keeps the hooks.
   */
  it('Parity_RetiredHookRemovalOrdering_IdenticalAcrossSurfaces', async () => {
    const cliFx = await createFixture('onboard-retired-cli-');
    const mcpFx = await createFixture('onboard-retired-mcp-');
    try {
      const before = [BLOCK_WRITE_DRIFT, RETIRED_HOOKS_DRIFT];
      const cliInstall = vi.fn().mockResolvedValue(undefined);
      const mcpInstall = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeDeps(cliFx, twoPhaseChecks(before, [GREEN]), cliInstall);
      const mcpDeps = makeDeps(mcpFx, twoPhaseChecks(before, [GREEN]), mcpInstall);

      const cliResult = await handleOnboard(
        { surface: 'cli', format: 'json' },
        cliFx.ctx,
        cliDeps,
      );
      const mcpArgs = stampOnboardSurface({ format: 'json' }) as HandleOnboardArgs;
      const mcpResult = await handleOnboard(mcpArgs, mcpFx.ctx, mcpDeps);

      expect(cliResult.success).toBe(true);
      expect(mcpResult.success).toBe(true);

      expect(normalize(cliResult)).toEqual(normalize(mcpResult));

      const cliData = cliResult.data as { plan: { steps: { key: string }[] } };
      const keys = cliData.plan.steps.map((s) => s.key);
      expect(keys.indexOf(BLOCK_DRIFT_CHECK_NAME)).toBeGreaterThanOrEqual(0);
      expect(keys.indexOf(BLOCK_DRIFT_CHECK_NAME)).toBeLessThan(
        keys.indexOf(RETIRED_HOOKS_CHECK_NAME),
      );
    } finally {
      await cleanup(cliFx);
      await cleanup(mcpFx);
    }
  });

  /**
   * The `installStep` hook runs `npx` and writes to `~/.claude/`, so it must never run on the MCP surface.
   * The advisory is present even when the install step stays residual.
   */
  it('Parity_McpArm_NeverWritesClaudeHome', async () => {
    const mcpFx = await createFixture('onboard-noclaudehome-mcp-');
    try {
      const mcpInstall = vi.fn().mockResolvedValue(undefined);
      const mcpDeps = makeDeps(
        mcpFx,
        twoPhaseChecks([INSTALL_FAIL], [INSTALL_FAIL]),
        mcpInstall,
      );

      const mcpArgs = stampOnboardSurface({ format: 'json' }) as HandleOnboardArgs;
      const result = await handleOnboard(mcpArgs, mcpFx.ctx, mcpDeps);

      expect(mcpInstall).not.toHaveBeenCalled();

      expect(mcpArgs.surface).toBe(MCP_ONBOARD_SURFACE);
      expect(MCP_ONBOARD_SURFACE).not.toBe('cli');

      const data = result.data as {
        result?: { advisories: { surface: string }[] };
      };
      const advisories = data.result?.advisories ?? [];
      expect(advisories.some((a) => a.surface === 'cli-only')).toBe(true);
    } finally {
      await cleanup(mcpFx);
    }
  });
});
