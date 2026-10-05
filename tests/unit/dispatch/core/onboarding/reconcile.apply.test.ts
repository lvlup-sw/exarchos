/**
 * Tests for `apply`, the executor half of the onboard and doctor reconciler. `apply` routes each
 * `PlanStep` of a `ReconcilePlan` by `kind`:
 * - `config` goes to the seeder, which overwrites only with `force`.
 * - `generate` goes to the init writers in the context.
 * - `install` runs only on the CLI surface. On another surface it becomes an advisory.
 * - `hook` goes to the injected hook installer.
 *
 * `apply` performs only the side effects of its injected deps and emits no events. Each side
 * effect is a context hook, so these tests use a temp-dir file system and no event store.
 */

import { describe, it, expect, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { apply, detectDesiredState, diff, type ApplyCtx } from '../../../../../src/dispatch/core/onboarding/reconcile.js';
import type { PlanStep, ReconcilePlan } from '../../../../../src/dispatch/core/onboarding/types.js';
import { ReconcileResultSchema } from '../../../../../src/dispatch/core/onboarding/types.js';
import { buildWriterDeps } from '../../../../../src/verbs/init/probes.js';
import type { RuntimeConfigWriter } from '../../../../../src/verbs/init/writers/writer.js';
import { loadExarchosConfig } from '../../../../../src/config/load-exarchos-config.js';
import { resolveVerificationRuntime } from '../../../../../src/config/test-runtime-resolver.js';
import type { CheckResult } from '../../../../../src/verbs/doctor/schema.js';
import { BLOCK_DRIFT_CHECK_NAME } from '../../../../../src/verbs/onboard/block-drift.js';
import { RETIRED_HOOKS_CHECK_NAME } from '../../../../../src/verbs/onboard/hooks.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';

const CONFIG_FILE = '.exarchos.yml';

function configStep(key = 'state-dir'): PlanStep {
  return {
    kind: 'config',
    surface: 'any',
    key,
    description: `Reconcile ${key}`,
  };
}

function generateStep(key = 'agent-mcp-registered'): PlanStep {
  return {
    kind: 'generate',
    surface: 'any',
    key,
    description: `Regenerate ${key}`,
  };
}

function installStep(key = 'plugin-skill-hash-sync'): PlanStep {
  return {
    kind: 'install',
    surface: 'cli-only',
    key,
    description: `Install ${key}`,
  };
}

function hookStep(key = 'session-start-hook'): PlanStep {
  return {
    kind: 'hook',
    surface: 'any',
    key,
    description: `Bind ${key}`,
  };
}

interface Fixture {
  readonly repoRoot: string;
  readonly base: string;
}

/** A temp repo with a Node toolchain marker so the seed resolves commands. */
async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'apply-'));
  const repoRoot = path.join(base, 'repo');
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
  return { repoRoot, base };
}

async function cleanup(fx: Fixture): Promise<void> {
  await rmrfAsync(fx.base).catch(
    () => {},
  );
}

/**
 * Builds an `ApplyCtx` for a fixture, on the `cli` surface by default. `writers` is empty by
 * default, so a test of the config, install or hook path runs alone.
 */
function makeCtx(fx: Fixture, overrides?: Partial<ApplyCtx>): ApplyCtx {
  const realDeps = buildWriterDeps();
  return {
    repoRoot: fx.repoRoot,
    surface: 'cli',
    force: false,
    writerDeps: { ...realDeps, cwd: () => fx.repoRoot, home: () => fx.repoRoot },
    writers: [],
    ...overrides,
  };
}

/**
 * The `onboard_*` tests cover the gate between two steps. The retired-hooks removal is a `hook`
 * step that reads the result of the on-ramp block write, a `generate` step before it. If the block
 * write does not converge, `apply` defers the removal. Thus a consumer always has the block or the
 * hooks.
 *
 * The tests with `createPythonFixture` cover the seed of the verification commands. For a
 * `pyproject.toml`, the registry resolves `mutation` (`mutmut run`) and `lint` (`ruff check`).
 */
describe('apply', () => {
  it('Apply_EmptyPlan_IsNoOp', async () => {
    const fx = await createFixture();
    try {
      const seedSpy = vi.fn();
      const installSpy = vi.fn();
      const hookSpy = vi.fn();
      const ctx = makeCtx(fx, {
        seed: seedSpy,
        installStep: installSpy,
        installHook: hookSpy,
      });

      const result = await apply({ steps: [] }, ctx);

      expect(() => ReconcileResultSchema.parse(result)).not.toThrow();

      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.residual).toEqual([]);
      expect(result.advisories).toEqual([]);
      expect(seedSpy).not.toHaveBeenCalled();
      expect(installSpy).not.toHaveBeenCalled();
      expect(hookSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup(fx);
    }
  });

  /** The never-overwrite rule of the seeder keeps the hand-edited file. The step is `skipped`. */
  it('Apply_HandEditedConfig_PreservedWithoutForce', async () => {
    const fx = await createFixture();
    try {
      const handEdited = 'test: my-custom-test-command\n# operator note\n';
      await writeFile(path.join(fx.repoRoot, CONFIG_FILE), handEdited, 'utf8');

      const ctx = makeCtx(fx, { force: false });
      const plan: ReconcilePlan = { steps: [configStep()] };

      const result = await apply(plan, ctx);

      const after = await readFile(path.join(fx.repoRoot, CONFIG_FILE), 'utf8');
      expect(after).toBe(handEdited);

      expect(result.applied).toHaveLength(0);
      expect(result.skipped.map((s) => s.key)).toContain('state-dir');
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * `force` replaces the hand edit with the seeded config. The step is `applied`, and an advisory
   * tells the operator about the overwrite.
   */
  it('Apply_ForceFlag_OverwritesAndReports', async () => {
    const fx = await createFixture();
    try {
      const handEdited = 'test: my-custom-test-command\n';
      const configPath = path.join(fx.repoRoot, CONFIG_FILE);
      await writeFile(configPath, handEdited, 'utf8');

      const ctx = makeCtx(fx, { force: true });
      const plan: ReconcilePlan = { steps: [configStep()] };

      const result = await apply(plan, ctx);

      const after = await readFile(configPath, 'utf8');
      expect(after).not.toBe(handEdited);
      expect(after).toContain('# .exarchos.yml');

      expect(result.applied.map((s) => s.key)).toContain('state-dir');
      const overwriteAdvisory = result.advisories.find((a) =>
        /overwrote|overwrit|force/i.test(a.message),
      );
      expect(overwriteAdvisory).toBeDefined();
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * Off the CLI surface the install hook does not run. The step becomes one `cli-only` advisory
   * that names a CLI command.
   */
  it('Apply_CliOnlyStepOffCliSurface_BecomesAdvisory', async () => {
    const fx = await createFixture();
    try {
      const installSpy = vi.fn();
      const ctx = makeCtx(fx, { surface: 'any', installStep: installSpy });
      const plan: ReconcilePlan = { steps: [installStep()] };

      const result = await apply(plan, ctx);

      expect(installSpy).not.toHaveBeenCalled();

      expect(result.applied).toHaveLength(0);
      expect(result.advisories).toHaveLength(1);
      expect(result.advisories[0].surface).toBe('cli-only');
      expect(result.advisories[0].commands?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await cleanup(fx);
    }
  });

  it('Apply_CliOnlyStepOnCliSurface_RunsViaHook', async () => {
    const fx = await createFixture();
    try {
      const installSpy = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx(fx, { surface: 'cli', installStep: installSpy });
      const plan: ReconcilePlan = { steps: [installStep()] };

      const result = await apply(plan, ctx);

      expect(installSpy).toHaveBeenCalledTimes(1);
      expect(result.applied.map((s) => s.key)).toContain('plugin-skill-hash-sync');
      expect(result.advisories).toHaveLength(0);
    } finally {
      await cleanup(fx);
    }
  });

  it('Apply_HookStep_RoutesThroughInstallHook', async () => {
    const fx = await createFixture();
    try {
      const hookSpy = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx(fx, { installHook: hookSpy });
      const plan: ReconcilePlan = { steps: [hookStep()] };

      const result = await apply(plan, ctx);

      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(result.applied.map((s) => s.key)).toContain('session-start-hook');
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * A hook installer that throws does not stop `apply` and causes no rollback. The plan puts the
   * config step first, and that step stays `applied`. The failed hook step is `residual`, so a
   * re-run resumes from it. An advisory carries the reason for the failure.
   */
  it('Apply_HookStepThrows_IsForwardOnly_ResidualPlusAdvisory_PipelineNotAborted', async () => {
    const fx = await createFixture();
    try {
      const hookError = new Error('settings.json is read-only');
      const hookSpy = vi.fn().mockRejectedValue(hookError);
      const ctx = makeCtx(fx, { surface: 'cli', installHook: hookSpy });

      const plan: ReconcilePlan = { steps: [configStep(), hookStep()] };

      const result = await apply(plan, ctx);

      expect(() => ReconcileResultSchema.parse(result)).not.toThrow();

      expect(hookSpy).toHaveBeenCalledTimes(1);

      expect(result.applied.map((s) => s.key)).toContain('state-dir');

      expect(result.residual.map((s) => s.key)).toContain('session-start-hook');
      expect(result.applied.map((s) => s.key)).not.toContain('session-start-hook');

      const hookAdvisory = result.advisories.find((a) =>
        /session-start-hook|read-only|forward-only/i.test(a.message),
      );
      expect(hookAdvisory).toBeDefined();
      expect(hookAdvisory?.message).toContain('settings.json is read-only');
    } finally {
      await cleanup(fx);
    }
  });

  it('Apply_GenerateStep_RoutesThroughInitWriters', async () => {
    const fx = await createFixture();
    try {
      const writeFn = vi.fn().mockResolvedValue({
        runtime: 'claude-code',
        status: 'written' as const,
        componentsWritten: ['mcp-config'],
      });
      const stubWriter: RuntimeConfigWriter = {
        runtime: 'claude-code',
        write: writeFn,
      };
      const ctx = makeCtx(fx, { writers: [stubWriter] });
      const plan: ReconcilePlan = { steps: [generateStep()] };

      const result = await apply(plan, ctx);

      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(result.applied.map((s) => s.key)).toContain('agent-mcp-registered');
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * Two generate steps share one writer set. The writer returns `skipped` because the artifact is
   * already in the desired state, and that status is convergence. Both steps must be `applied`
   * and none `residual`.
   */
  it('Apply_MultipleGenerateSteps_SkippedWritersConverge_NoFalseResidual', async () => {
    const fx = await createFixture();
    try {
      const skippedWriter: RuntimeConfigWriter = {
        runtime: 'claude-code',
        write: vi.fn().mockResolvedValue({
          runtime: 'claude-code',
          status: 'skipped' as const,
          componentsWritten: [],
        }),
      };
      const ctx = makeCtx(fx, { writers: [skippedWriter] });

      const plan: ReconcilePlan = {
        steps: [generateStep('agent-config-valid'), generateStep('agent-mcp-registered')],
      };

      const result = await apply(plan, ctx);

      expect(result.applied.map((s) => s.key)).toEqual(
        expect.arrayContaining(['agent-config-valid', 'agent-mcp-registered']),
      );
      expect(result.residual).toHaveLength(0);
    } finally {
      await cleanup(fx);
    }
  });

  /** A `failed` status is not convergence. The step stays `residual`, so a re-run resumes it. */
  it('Apply_GenerateStep_FailedWriter_IsResidual', async () => {
    const fx = await createFixture();
    try {
      const failedWriter: RuntimeConfigWriter = {
        runtime: 'claude-code',
        write: vi.fn().mockResolvedValue({
          runtime: 'claude-code',
          status: 'failed' as const,
          componentsWritten: [],
          error: 'permission denied',
        }),
      };
      const ctx = makeCtx(fx, { writers: [failedWriter] });
      const plan: ReconcilePlan = { steps: [generateStep('agent-mcp-registered')] };

      const result = await apply(plan, ctx);

      expect(result.applied).toHaveLength(0);
      expect(result.residual.map((s) => s.key)).toContain('agent-mcp-registered');
    } finally {
      await cleanup(fx);
    }
  });

  function blockWriteStep(): PlanStep {
    return {
      kind: 'generate',
      surface: 'any',
      key: BLOCK_DRIFT_CHECK_NAME,
      description: 'write the on-ramp managed block',
    };
  }

  function removalStep(): PlanStep {
    return {
      kind: 'hook',
      surface: 'any',
      key: RETIRED_HOOKS_CHECK_NAME,
      description: 'remove the retired lifecycle hooks',
    };
  }

  const WRITTEN_WRITER: RuntimeConfigWriter = {
    runtime: 'claude-code',
    write: vi.fn().mockResolvedValue({
      runtime: 'claude-code',
      status: 'written' as const,
      componentsWritten: ['onramp'],
    }),
  };

  /**
   * With no writers, the block-write step is `residual`. `apply` then defers the removal: it does
   * not call the hook seam, the removal step is `residual`, and an advisory explains the deferral.
   */
  it('onboard_BlockWriteFails_RetiredHooksKept', async () => {
    const fx = await createFixture();
    try {
      const hookSpy = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx(fx, { writers: [], installHook: hookSpy });
      const plan: ReconcilePlan = { steps: [blockWriteStep(), removalStep()] };

      const result = await apply(plan, ctx);
      expect(() => ReconcileResultSchema.parse(result)).not.toThrow();

      expect(hookSpy).not.toHaveBeenCalled();

      expect(result.residual.map((s) => s.key)).toContain(RETIRED_HOOKS_CHECK_NAME);
      expect(result.applied.map((s) => s.key)).not.toContain(RETIRED_HOOKS_CHECK_NAME);

      const advisory = result.advisories.find((a) =>
        /deferred|kept|block/i.test(a.message),
      );
      expect(advisory).toBeDefined();
    } finally {
      await cleanup(fx);
    }
  });

  const ONRAMP_FAILED_WRITER: RuntimeConfigWriter = {
    runtime: 'claude-code',
    write: vi.fn().mockResolvedValue({
      runtime: 'claude-code',
      status: 'written' as const,
      componentsWritten: ['skills'],
      onrampFailed: true,
    }),
  };

  /**
   * `ONRAMP_FAILED_WRITER` returns `written` with `onrampFailed: true`, as the Claude Code writer
   * does when only the write of the on-ramp block fails. The block-write step must not count as
   * converged, so `apply` defers the removal. An empty writer list cannot reach this path.
   */
  it('onboard_BlockWriteConvergesButOnrampFailed_RetiredHooksKept', async () => {
    const fx = await createFixture();
    try {
      const hookSpy = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx(fx, { writers: [ONRAMP_FAILED_WRITER], installHook: hookSpy });
      const plan: ReconcilePlan = { steps: [blockWriteStep(), removalStep()] };

      const result = await apply(plan, ctx);

      expect(hookSpy).not.toHaveBeenCalled();
      expect(result.residual.map((s) => s.key)).toContain(RETIRED_HOOKS_CHECK_NAME);
      expect(result.applied.map((s) => s.key)).not.toContain(RETIRED_HOOKS_CHECK_NAME);
      const advisory = result.advisories.find((a) => /deferred|kept|block/i.test(a.message));
      expect(advisory).toBeDefined();
    } finally {
      await cleanup(fx);
    }
  });

  /** `WRITTEN_WRITER` converges with the status `written`. The block is in place, so the removal runs. */
  it('onboard_BlockWriteSucceeds_RetiredHooksRemoved', async () => {
    const fx = await createFixture();
    try {
      const hookSpy = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx(fx, { writers: [WRITTEN_WRITER], installHook: hookSpy });
      const plan: ReconcilePlan = { steps: [blockWriteStep(), removalStep()] };

      const result = await apply(plan, ctx);

      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(result.applied.map((s) => s.key)).toContain(RETIRED_HOOKS_CHECK_NAME);
    } finally {
      await cleanup(fx);
    }
  });

  /** A plan with no block-write step means that the block already matched, so the removal runs. */
  it('onboard_NoBlockWriteStep_RetiredHooksRemoved', async () => {
    const fx = await createFixture();
    try {
      const hookSpy = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx(fx, { installHook: hookSpy });
      const plan: ReconcilePlan = { steps: [removalStep()] };

      const result = await apply(plan, ctx);

      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(result.applied.map((s) => s.key)).toContain(RETIRED_HOOKS_CHECK_NAME);
    } finally {
      await cleanup(fx);
    }
  });

  const ALL_PASS: CheckResult[] = [
    { category: 'runtime', name: 'node-version', status: 'Pass', message: 'ok', durationMs: 1 },
  ];

  async function createPythonFixture(): Promise<Fixture> {
    const base = await mkdtemp(path.join(tmpdir(), 'apply-py-'));
    const repoRoot = path.join(base, 'repo');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(
      path.join(repoRoot, 'pyproject.toml'),
      '[project]\nname = "fixture"\nversion = "0.0.0"\n',
      'utf8',
    );
    return { repoRoot, base };
  }

  /**
   * Nothing is declared, so `diff` emits the config steps for the two commands. The proof goes
   * through the real resolver and the real `.exarchos.yml` loader, not through the YAML text. The
   * resolver reports the source `config`, and the loader shows both commands as top-level keys.
   */
  it('Apply_MutationConfigStep_SeedsExarchosYml', async () => {
    const fx = await createPythonFixture();
    try {
      const desired = await detectDesiredState(fx.repoRoot, { detectRuntimes: async () => [] });
      expect(desired.commands.mutation).toBe('mutmut run');
      expect(desired.commands.lint).toBe('ruff check');

      const plan = diff(desired, ALL_PASS, {});
      expect(plan.steps.map((s) => s.key)).toEqual(
        expect.arrayContaining(['verification-command-mutation', 'verification-command-lint']),
      );

      const ctx = makeCtx(fx);
      const result = await apply(plan, ctx);

      expect(result.applied.map((s) => s.key)).toEqual(
        expect.arrayContaining(['verification-command-mutation', 'verification-command-lint']),
      );

      const resolved = resolveVerificationRuntime(fx.repoRoot);
      expect(resolved.mutation).toBe('mutmut run');
      expect(resolved.lint).toBe('ruff check');
      expect(resolved.source).toBe('config');

      const loaded = loadExarchosConfig(fx.repoRoot);
      expect(loaded).not.toBeNull();
      expect(loaded!.config.mutation).toBe('mutmut run');
      expect(loaded!.config.lint).toBe('ruff check');
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * The existing `.exarchos.yml` declares neither command, and the create-only seeder cannot add a
   * key to it. Each step must be `residual` with an advisory. It must not be `skipped`, which
   * reads as a kept hand edit, and it must not be `applied`. The file stays unchanged.
   */
  it('Apply_MutationConfigStep_ExistingConfig_ResidualNotSilentlySkipped', async () => {
    const fx = await createPythonFixture();
    try {
      await writeFile(path.join(fx.repoRoot, CONFIG_FILE), 'test: pytest\n', 'utf8');

      const desired = await detectDesiredState(fx.repoRoot, { detectRuntimes: async () => [] });
      const declared = (loadExarchosConfig(fx.repoRoot)?.config ?? {}) as {
        mutation?: string;
        lint?: string;
      };
      const plan = diff(desired, ALL_PASS, declared);
      expect(plan.steps.map((s) => s.key)).toEqual(
        expect.arrayContaining(['verification-command-mutation', 'verification-command-lint']),
      );

      const result = await apply(plan, makeCtx(fx));

      expect(result.residual.map((s) => s.key)).toEqual(
        expect.arrayContaining(['verification-command-mutation', 'verification-command-lint']),
      );
      expect(result.skipped.map((s) => s.key)).not.toContain('verification-command-mutation');
      expect(result.skipped.map((s) => s.key)).not.toContain('verification-command-lint');
      expect(result.applied.map((s) => s.key)).not.toContain('verification-command-mutation');
      expect(result.advisories.length).toBeGreaterThanOrEqual(2);

      const loaded = loadExarchosConfig(fx.repoRoot);
      expect(loaded).not.toBeNull();
      expect(loaded!.config.mutation).toBeUndefined();
      expect(loaded!.config.lint).toBeUndefined();
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * The first cycle seeds the config. In the second cycle the config declares the commands, so
   * `diff` gives an empty plan.
   */
  it('Apply_ReRunAfterSeed_EmptyPlanIdempotent', async () => {
    const fx = await createPythonFixture();
    try {
      const desired1 = await detectDesiredState(fx.repoRoot, { detectRuntimes: async () => [] });
      const declared1 = (loadExarchosConfig(fx.repoRoot)?.config ?? {}) as {
        mutation?: string;
        lint?: string;
      };
      const plan1 = diff(desired1, ALL_PASS, declared1);
      expect(plan1.steps.length).toBeGreaterThan(0);
      await apply(plan1, makeCtx(fx));

      const desired2 = await detectDesiredState(fx.repoRoot, { detectRuntimes: async () => [] });
      const declared2 = (loadExarchosConfig(fx.repoRoot)?.config ?? {}) as {
        mutation?: string;
        lint?: string;
      };
      const plan2 = diff(desired2, ALL_PASS, declared2);

      expect(plan2).toEqual({ steps: [] });
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * The seeder writes only the resolved commands. A seeded `verification` policy block freezes the
   * current built-in defaults into the consumer config, so the written file must not hold that key.
   */
  it('Apply_NeverWritesVerificationPolicyBlock', async () => {
    const fx = await createPythonFixture();
    try {
      const desired = await detectDesiredState(fx.repoRoot, { detectRuntimes: async () => [] });
      const plan = diff(desired, ALL_PASS, {});
      await apply(plan, makeCtx(fx));

      const raw = await readFile(path.join(fx.repoRoot, CONFIG_FILE), 'utf8');
      const parsed = parseYaml(raw) as Record<string, unknown>;
      expect('verification' in parsed).toBe(false);

      const loaded = loadExarchosConfig(fx.repoRoot);
      expect(loaded).not.toBeNull();
      expect('verification' in (loaded!.config as Record<string, unknown>)).toBe(false);
    } finally {
      await cleanup(fx);
    }
  });

  it('Apply_EmptyPlan_Idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (n) => {
        const fx = await createFixture();
        try {
          const seedSpy = vi.fn();
          const installSpy = vi.fn();
          const hookSpy = vi.fn();
          const ctx = makeCtx(fx, {
            seed: seedSpy,
            installStep: installSpy,
            installHook: hookSpy,
          });

          for (let i = 0; i < n; i++) {
            const result = await apply({ steps: [] }, ctx);
            expect(result.applied).toEqual([]);
            expect(result.skipped).toEqual([]);
            expect(result.residual).toEqual([]);
            expect(result.advisories).toEqual([]);
          }

          expect(seedSpy).not.toHaveBeenCalled();
          expect(installSpy).not.toHaveBeenCalled();
          expect(hookSpy).not.toHaveBeenCalled();
        } finally {
          await cleanup(fx);
        }
      }),
      { numRuns: 8 },
    );
  });
});
