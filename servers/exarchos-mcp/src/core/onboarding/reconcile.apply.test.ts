/**
 * Tests for `apply` (task 007, DR-1/DR-10) — the executor half of the
 * onboard/doctor reconciler. `apply` takes a {@link ReconcilePlan} and an
 * injected {@link ApplyCtx} of side-effect deps and routes each
 * {@link PlanStep} to the right EXISTING writer:
 *
 *   - `kind: 'config'`   → `seedExarchosConfig` (never-overwrite unless force)
 *   - `kind: 'generate'` → the init writers (`WriterDeps` injected via ctx)
 *   - `kind: 'install'`  → cli-only; downgraded to an Advisory off-CLI (DR-6)
 *   - `kind: 'hook'`     → the injected hook installer (real impl: task 012)
 *
 * `apply` is a PURE-ISH executor: it performs ONLY the side effects of its
 * injected deps and emits NO events. Event emission (`onboard.requested` /
 * `onboard.executed`) + crash recovery is task 009, which WRAPS `apply`.
 *
 * Result semantics (DR-10):
 *   - `applied`    = steps whose side effect ran.
 *   - `skipped`    = steps intentionally not run (preserved hand-edit, no force).
 *   - `residual`   = steps that still need doing after apply (verify re-diff).
 *   - `advisories` = cli-only steps downgraded off the CLI surface.
 *
 * Injection seam: every side effect is a ctx hook so task 009 and these tests
 * can drive `apply` against a temp-dir fs (the real-fs `WriterDeps` pattern from
 * `init.characterization.test.ts`) without touching `$HOME` or the event store.
 */

import { describe, it, expect, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { apply, detectDesiredState, diff, type ApplyCtx } from './reconcile.js';
import type { PlanStep, ReconcilePlan } from './types.js';
import { ReconcileResultSchema } from './types.js';
import { buildWriterDeps } from '../../orchestrate/init/probes.js';
import type { RuntimeConfigWriter } from '../../orchestrate/init/writers/writer.js';
import { loadExarchosConfig } from '../../config/load-exarchos-config.js';
import { resolveVerificationRuntime } from '../../config/test-runtime-resolver.js';
import type { CheckResult } from '../../orchestrate/doctor/schema.js';
import { BLOCK_DRIFT_CHECK_NAME } from '../../orchestrate/onboard/block-drift.js';
import { RETIRED_HOOKS_CHECK_NAME } from '../../orchestrate/onboard/hooks.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
  await rm(fx.base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
    () => {},
  );
}

/**
 * Build an `ApplyCtx` for a fixture. `surface` defaults to `'cli'` (the
 * privileged path). Tests override individual fields. The `writers` default is
 * an empty list (generate is exercised explicitly where needed) so the config /
 * install / hook paths can be tested in isolation.
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

// ─── Apply_EmptyPlan_IsNoOp ──────────────────────────────────────────────────

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

      // Validates against the canonical schema.
      expect(() => ReconcileResultSchema.parse(result)).not.toThrow();

      // Nothing ran, nothing recorded.
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

  // ─── Apply_HandEditedConfig_PreservedWithoutForce ──────────────────────────

  it('Apply_HandEditedConfig_PreservedWithoutForce', async () => {
    const fx = await createFixture();
    try {
      // A hand-edited config the operator owns.
      const handEdited = 'test: my-custom-test-command\n# operator note\n';
      await writeFile(path.join(fx.repoRoot, CONFIG_FILE), handEdited, 'utf8');

      const ctx = makeCtx(fx, { force: false });
      const plan: ReconcilePlan = { steps: [configStep()] };

      const result = await apply(plan, ctx);

      // The file survives byte-for-byte (seed's never-overwrite posture holds).
      const after = await readFile(path.join(fx.repoRoot, CONFIG_FILE), 'utf8');
      expect(after).toBe(handEdited);

      // The step is recorded as skipped (preserved hand-edit), not applied.
      expect(result.applied).toHaveLength(0);
      expect(result.skipped.map((s) => s.key)).toContain('state-dir');
    } finally {
      await cleanup(fx);
    }
  });

  // ─── Apply_ForceFlag_OverwritesAndReports ──────────────────────────────────

  it('Apply_ForceFlag_OverwritesAndReports', async () => {
    const fx = await createFixture();
    try {
      const handEdited = 'test: my-custom-test-command\n';
      const configPath = path.join(fx.repoRoot, CONFIG_FILE);
      await writeFile(configPath, handEdited, 'utf8');

      const ctx = makeCtx(fx, { force: true });
      const plan: ReconcilePlan = { steps: [configStep()] };

      const result = await apply(plan, ctx);

      // Force overwrote the hand-edit with the seeded (resolver-derived) config.
      const after = await readFile(configPath, 'utf8');
      expect(after).not.toBe(handEdited);
      expect(after).toContain('# .exarchos.yml');

      // The overwrite is RECORDED: the step is applied and an advisory notes the
      // forced overwrite so the operator is told (DR-10 "force overwrites and
      // says so").
      expect(result.applied.map((s) => s.key)).toContain('state-dir');
      const overwriteAdvisory = result.advisories.find((a) =>
        /overwrote|overwrit|force/i.test(a.message),
      );
      expect(overwriteAdvisory).toBeDefined();
    } finally {
      await cleanup(fx);
    }
  });

  // ─── Apply_CliOnlyStepOffCliSurface_BecomesAdvisory (DR-6) ──────────────────

  it('Apply_CliOnlyStepOffCliSurface_BecomesAdvisory', async () => {
    const fx = await createFixture();
    try {
      const installSpy = vi.fn();
      const ctx = makeCtx(fx, { surface: 'any', installStep: installSpy });
      const plan: ReconcilePlan = { steps: [installStep()] };

      const result = await apply(plan, ctx);

      // Off-CLI: the install hook NEVER ran (no silent server-side write).
      expect(installSpy).not.toHaveBeenCalled();

      // The cli-only step landed in advisories, not applied.
      expect(result.applied).toHaveLength(0);
      expect(result.advisories).toHaveLength(1);
      expect(result.advisories[0].surface).toBe('cli-only');
      // The advisory points the operator at the CLI.
      expect(result.advisories[0].commands?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await cleanup(fx);
    }
  });

  // ─── On-CLI install runs via the injected hook ─────────────────────────────

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

  // ─── hook steps route through the injected hook installer ───────────────────

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

  // ─── RF-2 (#1510): a throwing hook is FORWARD-ONLY, never an abort ──────────

  it('Apply_HookStepThrows_IsForwardOnly_ResidualPlusAdvisory_PipelineNotAborted', async () => {
    const fx = await createFixture();
    try {
      // A hook installer that fails (e.g. an unwritable settings file). Before
      // RF-2, `applyHookStep` had no try/catch, so this throw propagated out of
      // `apply` and aborted the whole pipeline — discarding the config step that
      // had ALREADY been applied earlier in the plan.
      const hookError = new Error('settings.json is read-only');
      const hookSpy = vi.fn().mockRejectedValue(hookError);
      const ctx = makeCtx(fx, { surface: 'cli', installHook: hookSpy });

      // config FIRST (it applies), hook SECOND (it throws). Forward-only requires
      // the already-applied config to survive the hook failure.
      const plan: ReconcilePlan = { steps: [configStep(), hookStep()] };

      // Must NOT reject — a thrown hook is swallowed, not propagated.
      const result = await apply(plan, ctx);

      // Still a valid ReconcileResult (no partial/throw escape).
      expect(() => ReconcileResultSchema.parse(result)).not.toThrow();

      // The hook installer WAS invoked (and threw).
      expect(hookSpy).toHaveBeenCalledTimes(1);

      // FORWARD-ONLY: the already-applied config step is KEPT (no rollback).
      expect(result.applied.map((s) => s.key)).toContain('state-dir');

      // The failed hook step landed in `residual` (so the VERIFY re-diff sees it
      // and a re-run resumes from it) — NOT in `applied`.
      expect(result.residual.map((s) => s.key)).toContain('session-start-hook');
      expect(result.applied.map((s) => s.key)).not.toContain('session-start-hook');

      // An advisory surfaces the hook failure with its reason (forward-only).
      const hookAdvisory = result.advisories.find((a) =>
        /session-start-hook|read-only|forward-only/i.test(a.message),
      );
      expect(hookAdvisory).toBeDefined();
      expect(hookAdvisory?.message).toContain('settings.json is read-only');
    } finally {
      await cleanup(fx);
    }
  });

  // ─── generate steps route through the init writers ──────────────────────────

  it('Apply_GenerateStep_RoutesThroughInitWriters', async () => {
    const fx = await createFixture();
    try {
      // A stub writer records that the generate step reached it.
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

  // ─── #1534: multi-step generate must not misreport converged steps ──────────

  it('Apply_MultipleGenerateSteps_SkippedWritersConverge_NoFalseResidual', async () => {
    const fx = await createFixture();
    try {
      // A writer that no-ops because the artifact is already in desired state
      // (e.g. produced by an earlier generate step in this same plan run).
      // 'skipped' is convergence, not a failure.
      const skippedWriter: RuntimeConfigWriter = {
        runtime: 'claude-code',
        write: vi.fn().mockResolvedValue({
          runtime: 'claude-code',
          status: 'skipped' as const,
          componentsWritten: [],
        }),
      };
      const ctx = makeCtx(fx, { writers: [skippedWriter] });

      // TWO generate steps over the SAME writer set — `agent-config-valid` and
      // `agent-mcp-registered` both classify to `kind: 'generate'`. Before the
      // fix, the second step (writers all no-op) was mis-marked `residual`,
      // corrupting the onboard.executed convergence report (INV-1). Both must
      // land in `applied`, none in `residual`.
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

  it('Apply_GenerateStep_FailedWriter_IsResidual', async () => {
    const fx = await createFixture();
    try {
      // A writer that returns a 'failed' status (not a throw) is NOT convergence
      // — the step stays residual so the VERIFY re-diff resumes it.
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

  // ─── DR-7 cross-step gate: block write before retired-hook removal (Task 017) ─
  //
  // The retired-hooks REMOVAL step (a `hook` step keyed `retired-hooks-present`)
  // consults the on-ramp block-WRITE outcome (a `generate` step keyed
  // `onramp-block-drift`, ordered before it). If the block write did not converge,
  // the removal is DEFERRED (hooks kept) so no consumer is ever left with neither
  // the on-ramp block nor the hooks. This is the apply half of the fixture matrix
  // (removeRetiredHooks's own settings.json matrix lives in `onboard/hooks.test.ts`).

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

  /** A writer that converges ('written') — the block write succeeds. */
  const WRITTEN_WRITER: RuntimeConfigWriter = {
    runtime: 'claude-code',
    write: vi.fn().mockResolvedValue({
      runtime: 'claude-code',
      status: 'written' as const,
      componentsWritten: ['onramp'],
    }),
  };

  it('onboard_BlockWriteFails_RetiredHooksKept', async () => {
    // Block-write generate step with NO writers → residual (write failed), ordered
    // before the removal step. The removal must be DEFERRED: the hook seam is never
    // invoked, the step is residual, and an advisory explains the deferral.
    const fx = await createFixture();
    try {
      const hookSpy = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx(fx, { writers: [], installHook: hookSpy });
      const plan: ReconcilePlan = { steps: [blockWriteStep(), removalStep()] };

      const result = await apply(plan, ctx);
      expect(() => ReconcileResultSchema.parse(result)).not.toThrow();

      // The uninstall never reached its seam — the hooks are KEPT.
      expect(hookSpy).not.toHaveBeenCalled();

      // The removal step is residual (so the verify re-diff resurfaces it).
      expect(result.residual.map((s) => s.key)).toContain(RETIRED_HOOKS_CHECK_NAME);
      expect(result.applied.map((s) => s.key)).not.toContain(RETIRED_HOOKS_CHECK_NAME);

      // An advisory records the deferral (hooks kept / block write failed).
      const advisory = result.advisories.find((a) =>
        /deferred|kept|block/i.test(a.message),
      );
      expect(advisory).toBeDefined();
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * A writer that CONVERGES overall ('written') because its MCP/commands/skills
   * phases wrote, but whose AGENTS.md on-ramp block write FAILED — surfaced via
   * `onrampFailed: true` (the real ClaudeCodeWriter reports on-ramp failure as an
   * advisory, not a status change). This is the production path the empty-writers
   * simulation cannot reach.
   */
  const ONRAMP_FAILED_WRITER: RuntimeConfigWriter = {
    runtime: 'claude-code',
    write: vi.fn().mockResolvedValue({
      runtime: 'claude-code',
      status: 'written' as const,
      componentsWritten: ['skills'],
      onrampFailed: true,
    }),
  };

  it('onboard_BlockWriteConvergesButOnrampFailed_RetiredHooksKept', async () => {
    // DR-7 regression: a writer may return status 'written' overall while the
    // AGENTS.md on-ramp block write FAILED (advisory-only in the writer). The
    // block-write step must NOT count as converged — the replacement on-ramp is
    // not in place — so the retired-hooks removal is DEFERRED (hooks kept). Guards
    // the exact hook-less+block-less stranding window that `writers: []` cannot
    // exercise (that path fails via absence, not via a converged-but-failed write).
    const fx = await createFixture();
    try {
      const hookSpy = vi.fn().mockResolvedValue(undefined);
      const ctx = makeCtx(fx, { writers: [ONRAMP_FAILED_WRITER], installHook: hookSpy });
      const plan: ReconcilePlan = { steps: [blockWriteStep(), removalStep()] };

      const result = await apply(plan, ctx);

      // The uninstall never reached its seam — the hooks are KEPT.
      expect(hookSpy).not.toHaveBeenCalled();
      expect(result.residual.map((s) => s.key)).toContain(RETIRED_HOOKS_CHECK_NAME);
      expect(result.applied.map((s) => s.key)).not.toContain(RETIRED_HOOKS_CHECK_NAME);
      const advisory = result.advisories.find((a) => /deferred|kept|block/i.test(a.message));
      expect(advisory).toBeDefined();
    } finally {
      await cleanup(fx);
    }
  });

  it('onboard_BlockWriteSucceeds_RetiredHooksRemoved', async () => {
    // Block write converges before the removal step → the removal proceeds (the
    // replacement on-ramp block is in place, so removing the hooks is safe).
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

  it('onboard_NoBlockWriteStep_RetiredHooksRemoved', async () => {
    // No block-write step in the plan means the on-ramp block already matched (its
    // drift check Passed) — the block is present, so the removal proceeds.
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

  // ─── §4.5-seed — verification commands (mutation/lint) seeded into config ───
  //
  // The config-step path now seeds the WIDENED verification field set: a
  // resolved-but-undeclared `mutation`/`lint` is written into `.exarchos.yml` via
  // the SAME seeder test/typecheck/install use. These tests prove the seed lands
  // at the config-direct tier (through the REAL loader, not YAML string-matching),
  // is idempotent across a full detect→diff→apply→detect→diff cycle, and NEVER
  // writes a `verification:` policy block (the gen-time-bake negative guarantee).

  const ALL_PASS: CheckResult[] = [
    { category: 'runtime', name: 'node-version', status: 'Pass', message: 'ok', durationMs: 1 },
  ];

  /**
   * A temp repo with a Python toolchain marker — the registry seeds BOTH
   * `mutation` (`mutmut run`) and `lint` (`ruff check`) for python, exercising
   * the full widened field set (the node fixture only seeds mutation).
   */
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

  it('Apply_MutationConfigStep_SeedsExarchosYml', async () => {
    const fx = await createPythonFixture();
    try {
      // Detect resolves mutation + lint from the python registry (tier 5); nothing
      // is declared yet, so diff emits the verification-command config steps.
      const desired = await detectDesiredState(fx.repoRoot, { detectRuntimes: async () => [] });
      expect(desired.commands.mutation).toBe('mutmut run');
      expect(desired.commands.lint).toBe('ruff check');

      const plan = diff(desired, ALL_PASS, {});
      expect(plan.steps.map((s) => s.key)).toEqual(
        expect.arrayContaining(['verification-command-mutation', 'verification-command-lint']),
      );

      const ctx = makeCtx(fx);
      const result = await apply(plan, ctx);

      // The config step was applied (the seeder wrote the file).
      expect(result.applied.map((s) => s.key)).toEqual(
        expect.arrayContaining(['verification-command-mutation', 'verification-command-lint']),
      );

      // PROVE IT THROUGH THE LOADER, not the YAML text: the resolver now returns
      // the seeded commands at the config-direct tier (source 'config' for the
      // legacy three; mutation/lint resolve from the written config-direct keys).
      const resolved = resolveVerificationRuntime(fx.repoRoot);
      expect(resolved.mutation).toBe('mutmut run');
      expect(resolved.lint).toBe('ruff check');
      // The aggregate source is the config tier — the seed is the operator's
      // explicit tier-2 declaration the resolver honors above detection.
      expect(resolved.source).toBe('config');

      // The written file parses through the REAL .exarchos.yml loader and carries
      // the verification commands as top-level direct keys.
      const loaded = loadExarchosConfig(fx.repoRoot);
      expect(loaded).not.toBeNull();
      expect(loaded!.config.mutation).toBe('mutmut run');
      expect(loaded!.config.lint).toBe('ruff check');
    } finally {
      await cleanup(fx);
    }
  });

  it('Apply_MutationConfigStep_ExistingConfig_ResidualNotSilentlySkipped', async () => {
    const fx = await createPythonFixture();
    try {
      // A pre-existing `.exarchos.yml` that declares NEITHER mutation nor lint.
      // The create-only seeder will short-circuit on it (`already-exists`).
      await writeFile(path.join(fx.repoRoot, CONFIG_FILE), 'test: pytest\n', 'utf8');

      // mutation/lint resolve from the python registry but are undeclared in the
      // existing config, so diff emits the verification-command steps.
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

      // The create-only seeder cannot add keys to the existing file, so the
      // commands are genuinely still absent. They MUST surface as residual (a
      // re-diff resumes them), NOT silently `skipped` (which reads as a preserved
      // hand-edit / success) and NOT `applied`.
      expect(result.residual.map((s) => s.key)).toEqual(
        expect.arrayContaining(['verification-command-mutation', 'verification-command-lint']),
      );
      expect(result.skipped.map((s) => s.key)).not.toContain('verification-command-mutation');
      expect(result.skipped.map((s) => s.key)).not.toContain('verification-command-lint');
      expect(result.applied.map((s) => s.key)).not.toContain('verification-command-mutation');
      // Each un-seedable command carries an advisory naming the untouched file.
      expect(result.advisories.length).toBeGreaterThanOrEqual(2);

      // The existing file was NOT modified — mutation/lint still absent.
      const loaded = loadExarchosConfig(fx.repoRoot);
      expect(loaded).not.toBeNull();
      expect(loaded!.config.mutation).toBeUndefined();
      expect(loaded!.config.lint).toBeUndefined();
    } finally {
      await cleanup(fx);
    }
  });

  it('Apply_ReRunAfterSeed_EmptyPlanIdempotent', async () => {
    const fx = await createPythonFixture();
    try {
      // Cycle 1: detect → diff → apply (seeds the config).
      const desired1 = await detectDesiredState(fx.repoRoot, { detectRuntimes: async () => [] });
      const declared1 = (loadExarchosConfig(fx.repoRoot)?.config ?? {}) as {
        mutation?: string;
        lint?: string;
      };
      const plan1 = diff(desired1, ALL_PASS, declared1);
      expect(plan1.steps.length).toBeGreaterThan(0);
      await apply(plan1, makeCtx(fx));

      // Cycle 2: re-detect → re-diff. The commands are now DECLARED (config-direct),
      // so the verification-command steps disappear → empty plan (idempotence).
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

  it('Apply_NeverWritesVerificationPolicyBlock', async () => {
    const fx = await createPythonFixture();
    try {
      // A full apply over the verification-command config steps.
      const desired = await detectDesiredState(fx.repoRoot, { detectRuntimes: async () => [] });
      const plan = diff(desired, ALL_PASS, {});
      await apply(plan, makeCtx(fx));

      // The written .exarchos.yml parsed object has NO `verification` key —
      // seeding the resolved POLICY would freeze today's builtin defaults into
      // consumer config (the gen-time-bake trap, §4.5 negative guarantee). Only
      // the resolved COMMANDS are seeded; policy is surfaced read-only via doctor.
      const raw = await readFile(path.join(fx.repoRoot, CONFIG_FILE), 'utf8');
      const parsed = parseYaml(raw) as Record<string, unknown>;
      expect('verification' in parsed).toBe(false);

      // The loader confirms it too (no verification block survives validation).
      const loaded = loadExarchosConfig(fx.repoRoot);
      expect(loaded).not.toBeNull();
      expect('verification' in (loaded!.config as Record<string, unknown>)).toBe(false);
    } finally {
      await cleanup(fx);
    }
  });

  // ─── Apply_EmptyPlan_Idempotent (property) ──────────────────────────────────

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

          // Apply the empty plan n times.
          for (let i = 0; i < n; i++) {
            const result = await apply({ steps: [] }, ctx);
            expect(result.applied).toEqual([]);
            expect(result.skipped).toEqual([]);
            expect(result.residual).toEqual([]);
            expect(result.advisories).toEqual([]);
          }

          // No side effect ever fired, regardless of repeat count.
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
