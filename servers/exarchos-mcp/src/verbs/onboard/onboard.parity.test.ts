/**
 * CLI/MCP parity tests for the `onboard` action (DR-6, task 014).
 *
 * Onboard runs a five-step pipeline:
 *
 *   DETECT → CONFIG → GENERATE → INSTALL → VERIFY
 *
 * DR-6 splits this surface in two:
 *   - Steps 1–3 + 5 (detect/config/generate/verify) are MCP-parity-able: the
 *     CLI and MCP arms MUST project identical `ToolResult`s for them given the
 *     same context + args (INV-2 — behavior lives in the core, the surface is
 *     just presentation).
 *   - Step 4 (skills/deps install — `npx` + a `~/.claude/` write) is gated
 *     CLI-only. On the MCP (non-`'cli'`) surface the core `apply` downgrades it
 *     to a structured {@link Advisory} (`surface: 'cli-only'`, `commands`) — it
 *     is NEVER executed server-side and NEVER a silent no-op.
 *
 * The step-4 gate is a property of the plan step's `surface` tag + the run's
 * capability surface (DR-6), NOT an `if (adapter === 'mcp')` branch in an
 * adapter file. The gating already lives in the CORE (`apply`'s install router
 * downgrades a `cli-only` step to an advisory when `ctx.surface !== 'cli'`).
 * This suite proves:
 *   1. parity of the non-install steps across the two surfaces;
 *   2. the MCP adapter passes its non-`'cli'` surface so the advisory fires and
 *      is surfaced in the `ToolResult` with `next_actions` pointing at the CLI;
 *   3. the MCP arm never invokes the `~/.claude/`-writing install hook.
 *
 * Onboard is not yet registered as a composite action (task 011), so the
 * CLI/MCP *arms* drive `handleOnboard` directly with the surface each carrier
 * supplies (CLI ⇒ `'cli'`, MCP ⇒ the non-CLI surface the MCP adapter stamps).
 * The MCP adapter's surface-stamp + advisory-surfacing seam is exercised
 * through its dedicated `stampOnboardSurface` / `surfaceOnboardCliAdvisory`
 * helpers (the thin, testable slice of `adapters/mcp.ts`).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { CheckResult } from '../doctor/schema.js';
import { buildWriterDeps } from '../init/probes.js';
import type { WriterDeps } from '../init/probes.js';
import { normalize as harnessNormalize } from '../../__tests__/parity-harness.js';

import { handleOnboard, type HandleOnboardArgs, type OnboardDeps } from './index.js';
import {
  MCP_ONBOARD_SURFACE,
  stampOnboardSurface,
  surfaceOnboardCliAdvisory,
} from '../../adapters/mcp/mcp.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { BLOCK_DRIFT_CHECK_NAME } from './block-drift.js';
import { RETIRED_HOOKS_CHECK_NAME } from './hooks.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

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

/** On-ramp block drift → a `generate` block-write PlanStep (DR-5). */
const BLOCK_WRITE_DRIFT: CheckResult = {
  category: 'agent',
  name: BLOCK_DRIFT_CHECK_NAME,
  status: 'Warning',
  message: 'AGENTS.md on-ramp block drifted',
  fix: 'run exarchos onboard to re-write the on-ramp block',
  durationMs: 0,
};

/** Retired hooks present → a `hook` removal PlanStep (DR-7). */
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
 * Build the injected deps for one arm. `installStep` is the `~/.claude/`-writing
 * install hook the CLI surface runs and the MCP surface MUST NOT — so each arm
 * gets its OWN spy to prove who invoked it.
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
    // Deterministic seeder so the config step is reproducible across arms.
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('exarchos onboard CLI/MCP parity (DR-6)', () => {
  it('Parity_StepsOneToThreeAndFive_IdenticalAcrossSurfaces', async () => {
    // Two isolated arms, identical drift surface: a config Fail before apply,
    // green after. NO install step in the plan — this isolates steps 1–3+5,
    // the parity-able surface. The ONLY difference between arms is the surface.
    const cliFx = await createFixture('onboard-parity-cli-');
    const mcpFx = await createFixture('onboard-parity-mcp-');
    try {
      const cliInstall = vi.fn().mockResolvedValue(undefined);
      const mcpInstall = vi.fn().mockResolvedValue(undefined);
      const cliDeps = makeDeps(cliFx, twoPhaseChecks([CONFIG_FAIL], [GREEN]), cliInstall);
      const mcpDeps = makeDeps(mcpFx, twoPhaseChecks([CONFIG_FAIL], [GREEN]), mcpInstall);

      // CLI arm runs `surface: 'cli'`; MCP arm runs the non-CLI surface the
      // MCP adapter stamps. Both produce identical detect/config/generate/verify.
      const cliArgs: HandleOnboardArgs = { surface: 'cli', format: 'json' };
      const mcpArgs: HandleOnboardArgs = stampOnboardSurface({
        format: 'json',
      }) as HandleOnboardArgs;

      const cliResult = await handleOnboard(cliArgs, cliFx.ctx, cliDeps);
      const mcpResult = await handleOnboard(mcpArgs, mcpFx.ctx, mcpDeps);

      // Both succeed and the non-install steps are byte-equal after normalize.
      expect(cliResult.success).toBe(true);
      expect(mcpResult.success).toBe(true);

      const normalizedCli = normalize(cliResult);
      const normalizedMcp = normalize(mcpResult);
      expect(normalizedCli).toEqual(normalizedMcp);
      expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

      // Sanity — the plan reconciled config steps on both arms (no install).
      // Two config steps: the injected `state-dir` doctor-check drift PLUS the
      // §4.5-seed `verification-command-mutation` step (the node fixture resolves
      // `npx stryker run` from detection, undeclared in `.exarchos.yml`). Both
      // arms produce the identical plan — parity is unaffected by the new seeding.
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

  it('Parity_McpInstallStep_ReturnsStructuredAdvisory', async () => {
    // The plan now carries a cli-only install step. CLI applies it; MCP skips
    // the side effect and downgrades it to a structured advisory.
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

      // CLI arm — install side effect runs.
      const cliResult = await handleOnboard(
        { surface: 'cli', format: 'json' },
        cliFx.ctx,
        cliDeps,
      );
      expect(cliResult.success).toBe(true);
      expect(cliInstall).toHaveBeenCalledTimes(1);

      // MCP arm — non-CLI surface stamped by the adapter; the adapter surfaces
      // the cli-only advisory with a CLI pointer in next_actions.
      const mcpArgs = stampOnboardSurface({ format: 'json' }) as HandleOnboardArgs;
      const mcpRaw = await handleOnboard(mcpArgs, mcpFx.ctx, mcpDeps);
      const mcpResult = surfaceOnboardCliAdvisory(mcpRaw);

      // NOT an error — a structured advisory carrier, never a silent no-op.
      expect(mcpResult.success).toBe(true);

      // The install side effect never ran on the MCP arm.
      expect(mcpInstall).not.toHaveBeenCalled();

      // The structured advisory is on the apply result: cli-only surface,
      // a `commands` array, and a non-empty message.
      const mcpData = mcpResult.data as {
        result?: { advisories: { surface: string; message: string; commands?: string[] }[] };
      };
      const advisories = mcpData.result?.advisories ?? [];
      const installAdvisory = advisories.find((a) => a.surface === 'cli-only');
      expect(installAdvisory).toBeDefined();
      expect(installAdvisory?.message.length ?? 0).toBeGreaterThan(0);
      expect(Array.isArray(installAdvisory?.commands)).toBe(true);
      expect((installAdvisory?.commands ?? []).some((c) => c.includes('onboard'))).toBe(true);

      // The MCP adapter surfaced a CLI pointer in next_actions (run install
      // from the CLI) — distinct from the success-path `doctor` pointer.
      const verbs = (mcpResult.next_actions ?? []).map((a) => a.verb);
      expect(verbs).toContain('onboard');
      const onboardHint = (mcpResult.next_actions ?? []).find((a) => a.verb === 'onboard');
      expect((onboardHint?.hint ?? '') + (onboardHint?.reason ?? '')).toContain('CLI');
    } finally {
      await cleanup(cliFx);
      await cleanup(mcpFx);
    }
  });

  it('Parity_RetiredHookRemovalOrdering_IdenticalAcrossSurfaces', async () => {
    // DR-7 surface parity: the on-ramp block-write step is ordered before the
    // retired-hooks removal step, and the whole reconcile result is byte-identical
    // across the CLI and MCP surfaces (the ordering lives in the pure core `diff`,
    // not in an adapter branch). `writers: []` makes the block-write step residual,
    // so apply's gate DEFERS the removal (hooks kept) — identically on both arms.
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

      // Byte-equal reconcile surface across the two arms.
      expect(normalize(cliResult)).toEqual(normalize(mcpResult));

      // The block-write step precedes the retired-hooks removal step in the plan.
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

  it('Parity_McpArm_NeverWritesClaudeHome', async () => {
    // The `installStep` hook is the ONLY path that shells `npx` + writes
    // `~/.claude/`. On the MCP (non-CLI) surface it must NEVER fire — the
    // cli-only step is downgraded to an advisory, not executed server-side.
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

      // Zero `~/.claude/` writes — the install hook was never invoked.
      expect(mcpInstall).not.toHaveBeenCalled();

      // The stamped surface is the non-CLI MCP surface (drives the downgrade).
      expect(mcpArgs.surface).toBe(MCP_ONBOARD_SURFACE);
      expect(MCP_ONBOARD_SURFACE).not.toBe('cli');

      // The advisory is present even when the install step stays residual.
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
