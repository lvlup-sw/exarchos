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
import type { CheckResult } from '../../orchestrate/doctor/schema.js';

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
});
