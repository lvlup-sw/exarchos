/**
 * Characterization of the doctor roster. It pins the static `ALL_CHECKS` export: the count, the order,
 * the `(category, name)` of each check, and the status vocabulary.
 * `doctor.characterization.test.ts` pins the same identities through a full `handleDoctor` run.
 * This file pins them at the export, so a new check fails here before any handler wiring.
 *
 * Each check in the real `ALL_CHECKS` runs on a benign probe bundle, and the test reads the identity off the result.
 * The status of each check depends on the host, so this file does not pin it.
 */

import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_CHECK_BUDGET_MS, type DoctorProbes } from '../../../../src/verbs/doctor/probes.js';
import type { AgentEnvironment } from '../../../../src/runtime/agent-environment-detector.js';
import type { IntegrityResult } from '../../../../src/events/store.js';
import type { BundleIntegrityResult } from '../../../../src/events/bundle/integrity.js';
import { CheckStatusSchema, CheckResultSchema, type CheckResult } from '../../../../src/verbs/doctor/schema.js';
import { ALL_CHECKS } from '../../../../src/verbs/doctor/index.js';

/**
 * The pinned checks, by `(category, name)` and in order. The `ALL_CHECKS` order is the doctor output order.
 * A new check must edit this list and the count. That edit is the review signal that this guard forces.
 */
const PINNED_ROSTER: ReadonlyArray<{
  category: CheckResult['category'];
  name: string;
}> = [
  { category: 'runtime', name: 'node-version' },
  { category: 'storage', name: 'state-dir' },
  { category: 'storage', name: 'storage-sqlite-health' },
  { category: 'storage', name: 'store-path-divergence' },
  { category: 'storage', name: 'run-bundle-integrity' },
  { category: 'env', name: 'variables' },
  { category: 'vcs', name: 'git-available' },
  { category: 'agent', name: 'agent-config-valid' },
  { category: 'agent', name: 'agent-mcp-registered' },
  { category: 'agent', name: 'session-start-hook' },
  { category: 'agent', name: 'onramp-block-drift' },
  { category: 'agent', name: 'retired-hooks-present' },
  { category: 'plugin', name: 'stale-skill-dirs' },
  { category: 'plugin', name: 'plugin-skill-hash-sync' },
  { category: 'plugin', name: 'plugin-version-match' },
  { category: 'plugin', name: 'install-freshness' },
  { category: 'remote', name: 'remote-mcp' },
  { category: 'invariants', name: 'invariants-catalog' },
  { category: 'invariants', name: 'action-contract-closure' },
  { category: 'verification', name: 'verification-toolchain' },
];

/**
 * A `DoctorProbes` bundle in which each probe returns a safe value, so each check reaches its return statement.
 * Unlike `make-stub-probes.ts`, no probe throws.
 */
function benignProbes(): DoctorProbes {
  const emptyEnvironments: AgentEnvironment[] = [];
  return {
    checkBudgetMs: DEFAULT_CHECK_BUDGET_MS,
    fs: {
      readFile: async () => '',
      stat: (async () => ({
        isDirectory: () => true,
        isFile: () => false,
      })) as unknown as DoctorProbes['fs']['stat'],
      access: async () => undefined,
    },
    env: {},
    git: {
      which: async () => '/usr/bin/git',
      isRepo: async () => true,
      version: async () => 'git version 2.40.0',
    },
    sqlite: {
      runIntegrityCheck: vi.fn(async (): Promise<IntegrityResult> => ({
        ok: 'skipped',
        reason: 'benign roster probe',
      })),
    },
    bundles: {
      runIntegrityCheck: vi.fn(async (): Promise<BundleIntegrityResult> => ({
        ok: 'skipped',
        reason: 'benign roster probe',
      })),
    },
    detector: async () => emptyEnvironments,
    eventStore: {
      append: async () => ({}),
    } as unknown as DoctorProbes['eventStore'],
    runtime: { nodeVersion: process.version },
    stateDir: '/tmp/doctor-roster-characterization',
    skills: { guardStatus: async () => ({ inSync: true }) },
    plugin: {
      installedVersion: async () => null,
      runningVersion: async () => null,
    },
    invariants: { resolve: async () => ({ configured: false, warnings: [] }) },
    verificationToolchain: {
      resolve: async () => ({
        detected: true,
        runtime: {
          test: 'npm run test:run',
          typecheck: 'tsc --noEmit',
          install: 'npm install',
          mutation: 'npx stryker run',
          lint: 'eslint .',
        },
        policyCells: [
          { riskTier: 'low', boundaryTouching: false, source: 'builtin' },
          { riskTier: 'low', boundaryTouching: true, source: 'builtin' },
          { riskTier: 'medium', boundaryTouching: false, source: 'builtin' },
          { riskTier: 'medium', boundaryTouching: true, source: 'builtin' },
          { riskTier: 'high', boundaryTouching: false, source: 'builtin' },
          { riskTier: 'high', boundaryTouching: true, source: 'builtin' },
        ],
      }),
    },
  } as DoctorProbes;
}

/** Run every check in the REAL `ALL_CHECKS` and collect their results. */
async function runRoster(): Promise<readonly CheckResult[]> {
  const probes = benignProbes();
  const controller = new AbortController();
  return Promise.all(ALL_CHECKS.map((check) => check(probes, controller.signal)));
}

describe('doctor roster characterization (T0 baseline)', () => {
  /**
   * The test reads each identity off the result of the real check, not off a copied literal.
   * The schema check proves that each entry returns a valid `CheckResult`.
   */
  it('DoctorRoster_CurrentBuild_ExactlyTwentyChecksWithStableNames', async () => {
    expect(ALL_CHECKS).toHaveLength(20);
    expect(PINNED_ROSTER).toHaveLength(20);

    const results = await runRoster();
    expect(results).toHaveLength(20);

    const observedIdentity = results.map((r) => ({
      category: r.category,
      name: r.name,
    }));
    expect(observedIdentity).toEqual(PINNED_ROSTER);

    const observedNames = new Set(results.map((r) => r.name));
    expect(observedNames.size).toBe(20);
    for (const { name } of PINNED_ROSTER) {
      expect(observedNames.has(name)).toBe(true);
    }

    for (const r of results) {
      expect(CheckResultSchema.safeParse(r).success).toBe(true);
    }
  });

  /** The vocabulary comes from the `CheckStatusSchema` enum, and the enum rejects any other value. */
  it('DoctorRoster_CurrentBuild_StatusVocabularyPinned', () => {
    expect(CheckStatusSchema.options).toEqual(['Pass', 'Warning', 'Fail', 'Skipped']);

    for (const status of ['Pass', 'Warning', 'Fail', 'Skipped'] as const) {
      expect(CheckStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(CheckStatusSchema.safeParse('Unknown').success).toBe(false);
    expect(CheckStatusSchema.safeParse('Ok').success).toBe(false);
  });
});
