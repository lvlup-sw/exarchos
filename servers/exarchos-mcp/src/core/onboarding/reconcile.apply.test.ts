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

import { apply, type ApplyCtx } from './reconcile.js';
import type { PlanStep, ReconcilePlan } from './types.js';
import { ReconcileResultSchema } from './types.js';
import { buildWriterDeps } from '../../orchestrate/init/probes.js';
import type { RuntimeConfigWriter } from '../../orchestrate/init/writers/writer.js';

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
