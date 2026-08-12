/**
 * Tests for `diff` (task 006, DR-1/DR-4) — the structural heart of the
 * onboard/doctor consolidation. `diff` turns the doctor checks (whose
 * remediable Fail/Warning results carry a `fix` hint string today) into an
 * EXECUTABLE {@link ReconcilePlan}: one {@link PlanStep} per remediable
 * failing check, zero steps when everything passes.
 *
 * Seam choice: `diff(desired, actual)` accepts `actual: readonly CheckResult[]`
 * — the exact output the doctor composer (`handleDoctorWithChecks`) already
 * produces by running the 11 checks. This keeps `diff` PURE (no fs/process):
 * the caller runs the probes/checks and hands the results in. Both `doctor
 * --fix` (task 013) and `onboard` (task 010) consume this.
 */

import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';

import { diff } from './reconcile.js';
import type { DesiredState } from './types.js';
import { ReconcilePlanSchema } from './types.js';
import type { CheckResult } from '../../../orchestrate/doctor/schema.js';
import { BLOCK_DRIFT_CHECK_NAME } from '../../../orchestrate/onboard/block-drift.js';
import { RETIRED_HOOKS_CHECK_NAME } from '../../../orchestrate/onboard/hooks.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DESIRED: DesiredState = {
  runtimes: ['claude-code'],
  vcs: 'git',
  commands: { test: 'npm test', typecheck: 'tsc --noEmit', install: 'npm ci' },
};

/** A passing check (no `fix`) — contributes no plan step. */
function pass(category: CheckResult['category'], name: string): CheckResult {
  return { category, name, status: 'Pass', message: `${name} ok`, durationMs: 1 };
}

/** A remediable failing/warning check (carries a `fix`) — becomes one step. */
function remediable(
  category: CheckResult['category'],
  name: string,
  status: 'Fail' | 'Warning' = 'Warning',
): CheckResult {
  return {
    category,
    name,
    status,
    message: `${name} drifted`,
    fix: `Run the fix for ${name}`,
    durationMs: 1,
  };
}

/** A non-remediable Skipped check (no `fix`) — contributes no plan step. */
function skipped(category: CheckResult['category'], name: string): CheckResult {
  return {
    category,
    name,
    status: 'Skipped',
    message: `${name} skipped`,
    reason: `${name} not applicable`,
    durationMs: 0,
  };
}

// ─── Diff_ProducesStructuredPlan_FromDoctorChecks ────────────────────────────

describe('diff', () => {
  it('Diff_ProducesStructuredPlan_FromDoctorChecks', () => {
    // A mix: 4 remediable failing checks (one per kind) + passes + a skip.
    const actual: CheckResult[] = [
      pass('runtime', 'node-version'),
      remediable('storage', 'state-dir'), // config / any
      remediable('agent', 'agent-mcp-registered'), // generate / any
      remediable('plugin', 'plugin-skill-hash-sync'), // install / cli-only
      remediable('agent', 'session-start-hook'), // hook / any
      skipped('remote', 'remote-mcp'),
    ];

    const plan = diff(DESIRED, actual);

    // N remediable failing checks ⇒ N steps. Pass + Skipped contribute none.
    expect(plan.steps).toHaveLength(4);

    // Plan validates against the canonical schema.
    expect(() => ReconcilePlanSchema.parse(plan)).not.toThrow();

    // Each step's stable key derives from the check name, so callers can
    // diff/idempotence-match against the originating check.
    const byKey = new Map(plan.steps.map((s) => [s.key, s]));
    expect([...byKey.keys()].sort()).toEqual(
      ['agent-mcp-registered', 'plugin-skill-hash-sync', 'session-start-hook', 'state-dir'].sort(),
    );

    // kind is derived from the check's nature.
    expect(byKey.get('state-dir')!.kind).toBe('config');
    expect(byKey.get('agent-mcp-registered')!.kind).toBe('generate');
    expect(byKey.get('plugin-skill-hash-sync')!.kind).toBe('install');
    expect(byKey.get('session-start-hook')!.kind).toBe('hook');

    // surface (DR-6): install/skills steps are cli-only; everything else any.
    expect(byKey.get('plugin-skill-hash-sync')!.surface).toBe('cli-only');
    expect(byKey.get('state-dir')!.surface).toBe('any');
    expect(byKey.get('agent-mcp-registered')!.surface).toBe('any');
    expect(byKey.get('session-start-hook')!.surface).toBe('any');

    // description carries the actionable text (message/fix), never empty.
    for (const step of plan.steps) {
      expect(step.description.length).toBeGreaterThan(0);
    }
  });

  // ─── Diff_NoDrift_ReturnsEmptyPlan ─────────────────────────────────────────

  it('Diff_NoDrift_ReturnsEmptyPlan', () => {
    const allPass: CheckResult[] = [
      pass('runtime', 'node-version'),
      pass('storage', 'state-dir'),
      pass('storage', 'storage-sqlite-health'),
      pass('env', 'variables'),
      pass('vcs', 'git-available'),
      pass('agent', 'agent-config-valid'),
      pass('agent', 'agent-mcp-registered'),
      pass('plugin', 'plugin-skill-hash-sync'),
      pass('plugin', 'plugin-version-match'),
      pass('invariants', 'invariants-catalog'),
    ];

    const plan = diff(DESIRED, allPass);

    expect(plan).toEqual({ steps: [] });
  });

  // ─── Property: clean repo ⇒ always empty plan ──────────────────────────────

  it('Diff_CleanRepo_AlwaysEmptyPlan', () => {
    const categoryArb = fc.constantFrom<CheckResult['category']>(
      'runtime',
      'storage',
      'vcs',
      'agent',
      'plugin',
      'env',
      'remote',
      'invariants',
    );

    const allPassChecksArb = fc.array(
      fc.record({
        category: categoryArb,
        name: fc.string({ minLength: 1, maxLength: 24 }),
        durationMs: fc.nat({ max: 5000 }),
      }),
      { maxLength: 20 },
    );

    fc.assert(
      fc.property(allPassChecksArb, (specs) => {
        // For ANY set of all-Pass checks, the plan is empty. A Pass carries
        // no `fix`, so it can never become a remediation step.
        const actual: CheckResult[] = specs.map((s) => ({
          category: s.category,
          name: s.name,
          status: 'Pass' as const,
          message: `${s.name} ok`,
          durationMs: s.durationMs,
        }));

        const plan = diff(DESIRED, actual);
        expect(plan.steps).toHaveLength(0);
      }),
    );
  });

  // ─── §4.5-seed — verification commands resolved-but-undeclared ──────────────
  //
  // `diff` is also the home for desired-vs-declared command divergence: when the
  // layered resolver resolved a `mutation`/`lint` command but it is NOT declared
  // in the repo's `.exarchos.yml`, `diff` emits a `config`-kind PlanStep so
  // `apply` can seed it (the SAME seed path test/typecheck use, no new kinds).
  // The `declared` arg is the third input — the commands the repo already pins in
  // `.exarchos.yml`; a resolved field present there contributes NO step (the
  // idempotence precondition).

  describe('verification-command seeding (§4.5-seed)', () => {
    /** A clean, all-passing doctor roster — isolates the command-divergence path. */
    const ALL_PASS: CheckResult[] = [pass('runtime', 'node-version')];

    /** A desired state with mutation + lint both resolved by the resolver. */
    const DESIRED_WITH_VERIFICATION: DesiredState = {
      runtimes: ['claude-code'],
      vcs: 'git',
      commands: {
        test: 'npm run test:run',
        typecheck: 'tsc --noEmit',
        install: 'npm install',
        mutation: 'npx stryker run',
        lint: 'eslint .',
      },
    };

    it('Diff_ResolvedMutationMissingFromConfig_EmitsConfigStep', () => {
      // mutation resolved, but the repo declares neither mutation nor lint.
      const declared = { test: 'npm run test:run' };

      const plan = diff(DESIRED_WITH_VERIFICATION, ALL_PASS, declared);

      // The plan validates and carries a config step for each undeclared
      // resolved verification command (mutation + lint here).
      expect(() => ReconcilePlanSchema.parse(plan)).not.toThrow();

      const byKey = new Map(plan.steps.map((s) => [s.key, s]));
      const mutationStep = byKey.get('verification-command-mutation');
      expect(mutationStep).toBeDefined();
      // Same shape/surface as the test/typecheck config steps: config / any.
      expect(mutationStep!.kind).toBe('config');
      expect(mutationStep!.surface).toBe('any');
      expect(mutationStep!.description.length).toBeGreaterThan(0);

      const lintStep = byKey.get('verification-command-lint');
      expect(lintStep).toBeDefined();
      expect(lintStep!.kind).toBe('config');
      expect(lintStep!.surface).toBe('any');
    });

    it('Diff_ResolvedMutationAlreadyDeclared_NoStep_Idempotent', () => {
      // Both verification commands resolved AND already declared in
      // `.exarchos.yml` ⇒ no config step (the seed already happened).
      const declared = {
        mutation: 'npx stryker run',
        lint: 'eslint .',
      };

      const plan = diff(DESIRED_WITH_VERIFICATION, ALL_PASS, declared);

      const keys = plan.steps.map((s) => s.key);
      expect(keys).not.toContain('verification-command-mutation');
      expect(keys).not.toContain('verification-command-lint');
    });

    it('Diff_UnresolvedVerificationCommand_NoStep', () => {
      // The resolver left mutation/lint unresolved (omitted from desired.commands)
      // ⇒ nothing to seed, no step. INV-6 omit-never-fabricate carries through:
      // diff never invents a command the resolver did not surface.
      const desiredNoVerification: DesiredState = {
        runtimes: ['claude-code'],
        vcs: 'git',
        commands: { test: 'npm run test:run' },
      };

      const plan = diff(desiredNoVerification, ALL_PASS, {});

      const keys = plan.steps.map((s) => s.key);
      expect(keys).not.toContain('verification-command-mutation');
      expect(keys).not.toContain('verification-command-lint');
    });

    it('Diff_DeclaredDefaultsToEmpty_BackwardCompatible', () => {
      // Omitting the `declared` arg treats every resolved verification command as
      // undeclared (seed-everything) — and the legacy two-arg call still works,
      // so the doctor-check path is untouched.
      const plan = diff(DESIRED_WITH_VERIFICATION, ALL_PASS);

      const keys = plan.steps.map((s) => s.key);
      expect(keys).toContain('verification-command-mutation');
      expect(keys).toContain('verification-command-lint');
    });
  });

  // ─── DR-7 plan-step ordering (Task 017) ────────────────────────────────────
  //
  // The on-ramp managed-block WRITE (`onramp-block-drift`, a `generate` step) must
  // precede the retired-hooks REMOVAL (`retired-hooks-present`, a `hook` step) so a
  // consumer never transitions through hook-less + block-less (apply's cross-step
  // gate then keeps the hooks if the block write fails).

  describe('DR-7 block-write-before-hook-removal ordering', () => {
    it('reconcile_BlockWriteOrderedBeforeHookRemoval', () => {
      // Feed the removal check BEFORE the block-write check — the ordering pass
      // must still emit the block-write step first, regardless of input order.
      const actual: CheckResult[] = [
        remediable('agent', RETIRED_HOOKS_CHECK_NAME),
        remediable('agent', BLOCK_DRIFT_CHECK_NAME),
      ];

      const plan = diff(DESIRED, actual);
      const keys = plan.steps.map((s) => s.key);

      const blockIdx = keys.indexOf(BLOCK_DRIFT_CHECK_NAME);
      const removalIdx = keys.indexOf(RETIRED_HOOKS_CHECK_NAME);
      expect(blockIdx).toBeGreaterThanOrEqual(0);
      expect(removalIdx).toBeGreaterThanOrEqual(0);
      expect(blockIdx).toBeLessThan(removalIdx);

      // The steps carry their classified kinds: generate (block write) + hook.
      const byKey = new Map(plan.steps.map((s) => [s.key, s]));
      expect(byKey.get(BLOCK_DRIFT_CHECK_NAME)!.kind).toBe('generate');
      expect(byKey.get(RETIRED_HOOKS_CHECK_NAME)!.kind).toBe('hook');
    });

    it('Reconcile_AlreadyOrdered_PreservesOtherStepOrder', () => {
      // When block-write already precedes removal (the roster-ordered case), the
      // pass is a no-op AND unrelated steps keep their relative order.
      const actual: CheckResult[] = [
        remediable('storage', 'state-dir'), // config
        remediable('agent', BLOCK_DRIFT_CHECK_NAME), // generate (block write)
        remediable('agent', RETIRED_HOOKS_CHECK_NAME), // hook (removal)
        remediable('plugin', 'plugin-skill-hash-sync'), // install
      ];

      const plan = diff(DESIRED, actual);
      const keys = plan.steps.map((s) => s.key);

      expect(keys).toEqual([
        'state-dir',
        BLOCK_DRIFT_CHECK_NAME,
        RETIRED_HOOKS_CHECK_NAME,
        'plugin-skill-hash-sync',
      ]);
    });

    it('Reconcile_RemovalWithoutBlockWrite_LeavesRemovalStep', () => {
      // A removal step with NO block-write step (the block already matched) is a
      // valid plan — the ordering pass leaves it untouched.
      const actual: CheckResult[] = [remediable('agent', RETIRED_HOOKS_CHECK_NAME)];

      const plan = diff(DESIRED, actual);
      const keys = plan.steps.map((s) => s.key);
      expect(keys).toEqual([RETIRED_HOOKS_CHECK_NAME]);
    });
  });
});
