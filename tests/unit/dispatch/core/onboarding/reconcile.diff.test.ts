/**
 * Tests for `diff`, which turns doctor check results into an executable `ReconcilePlan`. Each
 * remediable check gives one `PlanStep`, and a passing check gives none. `diff` also adds a
 * `config` step for each resolved `mutation` or `lint` command that `.exarchos.yml` does not
 * declare.
 *
 * `diff` is pure. It takes the `CheckResult[]` that the doctor roster produces, so each test builds
 * the results by hand and runs no probe.
 */

import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';

import {
  deliberatelyClassifiedCheckNames,
  diff,
  NON_REMEDIABLE_CHECKS,
} from '../../../../../src/dispatch/core/onboarding/reconcile.js';
import { ALL_CHECKS } from '../../../../../src/verbs/doctor/index.js';
import type { DesiredState } from '../../../../../src/dispatch/core/onboarding/types.js';
import { ReconcilePlanSchema } from '../../../../../src/dispatch/core/onboarding/types.js';
import type { CheckResult } from '../../../../../src/verbs/doctor/schema.js';
import { BLOCK_DRIFT_CHECK_NAME } from '../../../../../src/verbs/onboard/block-drift.js';
import { RETIRED_HOOKS_CHECK_NAME } from '../../../../../src/verbs/onboard/hooks.js';

const DESIRED: DesiredState = {
  runtimes: ['claude-code'],
  vcs: 'git',
  commands: { test: 'npm test', typecheck: 'tsc --noEmit', install: 'npm ci' },
};

/** A passing check. It has no `fix`, so it gives no plan step. */
function pass(category: CheckResult['category'], name: string): CheckResult {
  return { category, name, status: 'Pass', message: `${name} ok`, durationMs: 1 };
}

/**
 * A `Fail` or `Warning` check with a `fix`. It gives one plan step, unless its name is in
 * `NON_REMEDIABLE_CHECKS`.
 */
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

/** A `Skipped` check. It has no `fix`, so it gives no plan step. */
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

describe('diff', () => {
  /**
   * The input holds one remediable check for each step kind, one pass and one skip. Each step key
   * is the check name, so a caller can match a step to its check. Only the `install` step is
   * `cli-only`.
   */
  it('Diff_ProducesStructuredPlan_FromDoctorChecks', () => {
    const actual: CheckResult[] = [
      pass('runtime', 'node-version'),
      remediable('storage', 'state-dir'),
      remediable('agent', 'agent-mcp-registered'),
      remediable('plugin', 'plugin-skill-hash-sync'),
      remediable('agent', 'session-start-hook'),
      skipped('remote', 'remote-mcp'),
    ];

    const plan = diff(DESIRED, actual);

    expect(plan.steps).toHaveLength(4);

    expect(() => ReconcilePlanSchema.parse(plan)).not.toThrow();

    const byKey = new Map(plan.steps.map((s) => [s.key, s]));
    expect([...byKey.keys()].sort()).toEqual(
      ['agent-mcp-registered', 'plugin-skill-hash-sync', 'session-start-hook', 'state-dir'].sort(),
    );

    expect(byKey.get('state-dir')!.kind).toBe('config');
    expect(byKey.get('agent-mcp-registered')!.kind).toBe('generate');
    expect(byKey.get('plugin-skill-hash-sync')!.kind).toBe('install');
    expect(byKey.get('session-start-hook')!.kind).toBe('hook');

    expect(byKey.get('plugin-skill-hash-sync')!.surface).toBe('cli-only');
    expect(byKey.get('state-dir')!.surface).toBe('any');
    expect(byKey.get('agent-mcp-registered')!.surface).toBe('any');
    expect(byKey.get('session-start-hook')!.surface).toBe('any');

    for (const step of plan.steps) {
      expect(step.description.length).toBeGreaterThan(0);
    }
  });

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

  /** Property: a `Pass` result has no `fix`, so any set of passing checks gives an empty plan. */
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

  /**
   * `diff` adds a `config` step for each `mutation` or `lint` command that the resolver resolved
   * and `.exarchos.yml` does not declare. The third argument holds the declared commands, and a
   * declared field gives no step.
   *
   * `ALL_PASS` keeps the check path empty. `DESIRED_WITH_VERIFICATION` resolves both commands.
   */
  describe('verification-command seeding (§4.5-seed)', () => {
    const ALL_PASS: CheckResult[] = [pass('runtime', 'node-version')];

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

    /** The declared set holds neither `mutation` nor `lint`, so each one gets a step. */
    it('Diff_ResolvedMutationMissingFromConfig_EmitsConfigStep', () => {
      const declared = { test: 'npm run test:run' };

      const plan = diff(DESIRED_WITH_VERIFICATION, ALL_PASS, declared);

      expect(() => ReconcilePlanSchema.parse(plan)).not.toThrow();

      const byKey = new Map(plan.steps.map((s) => [s.key, s]));
      const mutationStep = byKey.get('verification-command-mutation');
      expect(mutationStep).toBeDefined();
      expect(mutationStep!.kind).toBe('config');
      expect(mutationStep!.surface).toBe('any');
      expect(mutationStep!.description.length).toBeGreaterThan(0);

      const lintStep = byKey.get('verification-command-lint');
      expect(lintStep).toBeDefined();
      expect(lintStep!.kind).toBe('config');
      expect(lintStep!.surface).toBe('any');
    });

    it('Diff_ResolvedMutationAlreadyDeclared_NoStep_Idempotent', () => {
      const declared = {
        mutation: 'npx stryker run',
        lint: 'eslint .',
      };

      const plan = diff(DESIRED_WITH_VERIFICATION, ALL_PASS, declared);

      const keys = plan.steps.map((s) => s.key);
      expect(keys).not.toContain('verification-command-mutation');
      expect(keys).not.toContain('verification-command-lint');
    });

    /** `diff` never invents a command that is absent from `desired.commands`. */
    it('Diff_UnresolvedVerificationCommand_NoStep', () => {
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

    /** A two-argument call treats every resolved verification command as undeclared. */
    it('Diff_DeclaredDefaultsToEmpty_BackwardCompatible', () => {
      const plan = diff(DESIRED_WITH_VERIFICATION, ALL_PASS);

      const keys = plan.steps.map((s) => s.key);
      expect(keys).toContain('verification-command-mutation');
      expect(keys).toContain('verification-command-lint');
    });
  });

  /**
   * The on-ramp block-write step must come before the retired-hooks removal step. With the gate in
   * `apply`, a failed block write then keeps the hooks, so a consumer always has at least one of
   * the two.
   */
  describe('DR-7 block-write-before-hook-removal ordering', () => {
    /** The input gives the removal check first, and the plan still puts the block write first. */
    it('reconcile_BlockWriteOrderedBeforeHookRemoval', () => {
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

      const byKey = new Map(plan.steps.map((s) => [s.key, s]));
      expect(byKey.get(BLOCK_DRIFT_CHECK_NAME)!.kind).toBe('generate');
      expect(byKey.get(RETIRED_HOOKS_CHECK_NAME)!.kind).toBe('hook');
    });

    /** With the two steps already in order, every step keeps its input position. */
    it('Reconcile_AlreadyOrdered_PreservesOtherStepOrder', () => {
      const actual: CheckResult[] = [
        remediable('storage', 'state-dir'),
        remediable('agent', BLOCK_DRIFT_CHECK_NAME),
        remediable('agent', RETIRED_HOOKS_CHECK_NAME),
        remediable('plugin', 'plugin-skill-hash-sync'),
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

    /** A plan has no block-write step when the block already matches. The removal step stays. */
    it('Reconcile_RemovalWithoutBlockWrite_LeavesRemovalStep', () => {
      const actual: CheckResult[] = [remediable('agent', RETIRED_HOOKS_CHECK_NAME)];

      const plan = diff(DESIRED, actual);
      const keys = plan.steps.map((s) => s.key);
      expect(keys).toEqual([RETIRED_HOOKS_CHECK_NAME]);
    });
  });
});

describe('roster placement', () => {
  /**
   * Each check in the roster must have a deliberate place: a classification, or the non-remediable
   * list. The category fallback is for an unknown check. For a finding that no step can repair, the
   * fallback can give a `config` step, and `apply` then seeds a file and reports success.
   *
   * `RESULT_NAME_OF_BINDING` maps a function binding to its result name, because the classification
   * table uses the result name. `ACCEPTED_FALLBACKS` names the checks that this test permits to
   * take the category default.
   */
  it('Reconcile_EveryRegisteredCheck_IsClassifiedDeliberately', () => {
    const registered = ALL_CHECKS.map((check) => {
      const meta = (check as { meta?: { name?: string } }).meta;
      return meta?.name ?? check.name;
    });
    expect(registered.length).toBeGreaterThan(10);
    const placed = deliberatelyClassifiedCheckNames();
    const RESULT_NAME_OF_BINDING: Readonly<Record<string, string>> = {
      runtimeNodeVersion: 'node-version',
      storageStateDir: 'state-dir',
      envVariables: 'variables',
      vcsGitAvailable: 'git-available',
      remoteMcpStub: 'remote-mcp',
      storageSqliteHealth: 'storage-sqlite-health',
      storePathDivergence: 'store-path-divergence',
      agentConfigValid: 'agent-config-valid',
      agentMcpRegistered: 'agent-mcp-registered',
      sessionStartHook: 'session-start-hook',
      onrampBlockDrift: BLOCK_DRIFT_CHECK_NAME,
      retiredHooksPresent: RETIRED_HOOKS_CHECK_NAME,
      staleSkillDirs: 'stale-skill-dirs',
      pluginSkillHashSync: 'plugin-skill-hash-sync',
      pluginVersionMatch: 'plugin-version-match',
      installFreshness: 'install-freshness',
      invariantsCatalog: 'invariants-catalog',
      actionContractClosure: 'action-contract-closure',
      verificationToolchain: 'verification-toolchain',
    };
    const unplaced = registered
      .map((name) => RESULT_NAME_OF_BINDING[name] ?? name)
      .filter((name) => !placed.has(name));
    const ACCEPTED_FALLBACKS = new Set(['stale-skill-dirs', 'install-freshness', 'remote-mcp', 'action-contract-closure', 'verification-toolchain']);
    expect(unplaced.filter((name) => !ACCEPTED_FALLBACKS.has(name))).toEqual([]);
  });

  /**
   * The schema requires a `fix` on each `Warning`, so status alone makes a custody-loss finding a
   * `config` step. The non-remediable list prevents that.
   *
   * The loop uses literal names, because a loop over the set passes when the set is empty. The
   * remediable sibling `storage-sqlite-health` still gives its step, so the list decides the
   * result.
   */
  it('Reconcile_NonRemediableWarning_ProducesNoStep', () => {
    for (const name of ['run-bundle-integrity', 'store-path-divergence']) {
      expect(NON_REMEDIABLE_CHECKS.has(name), `${name} is not listed as non-remediable`).toBe(true);
      const plan = diff(DESIRED, [remediable('storage', name)]);
      expect(plan.steps, `${name} produced a reconcile step`).toEqual([]);
    }
    const plan = diff(DESIRED, [remediable('storage', 'storage-sqlite-health')]);
    expect(plan.steps.map((step) => step.key)).toEqual(['storage-sqlite-health']);
  });
});
