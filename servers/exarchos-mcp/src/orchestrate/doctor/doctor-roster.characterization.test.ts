/**
 * T0 characterization (epic task 006, design §4.7) — PINS the CURRENT doctor
 * roster surface so the upcoming reconciler/doctor extension (a sibling task
 * adds a 13th check and widens `ResolvedCommandsSchema`) has a regression
 * oracle.
 *
 * SCOPE — this file pins the STATIC roster export `ALL_CHECKS` at the roster
 * level: how many checks ship, each check's stable `(name, category)`, and the
 * status vocabulary the contract type declares. It is deliberately COMPLEMENTARY
 * to `doctor.characterization.test.ts`, which pins the same identity set as
 * observed through the full `handleDoctor` run + the `diagnostic.executed` event
 * payload. Pinning the roster export directly (rather than only through the
 * composer) means a sibling task that appends a 13th entry to `ALL_CHECKS` trips
 * THIS guard at the roster boundary, before any handler wiring.
 *
 * This test MUST PASS against unmodified HEAD — it is a Feathers baseline, not
 * a spec for new behavior.
 *
 * HOW IDENTITY IS READ (no copied literals masquerading as pins): each check in
 * the REAL `ALL_CHECKS` is executed with a benign full-probe bundle and its
 * `(name, category)` is read off the returned `CheckResult`. The bundle returns
 * safe values for every probe a check might touch, so each check reaches its
 * return statement and surfaces its own identity — we never hand-build a check
 * result. The benign bundle is identity-only scaffolding; the pass/fail STATUS
 * each check computes is host-dependent and intentionally NOT pinned here.
 *
 * The status VOCABULARY is pinned from the canonical `CheckStatusSchema` enum
 * (schema.ts) — the source of truth the `CheckFn` result type derives from — so
 * the pin tracks the type, not a transcribed copy.
 */

import { describe, it, expect } from 'vitest';
import type { DoctorProbes } from './probes.js';
import type { AgentEnvironment } from '../../runtime/agent-environment-detector.js';
import type { IntegrityResult } from '../../event-store/store.js';
import { CheckStatusSchema, CheckResultSchema, type CheckResult } from './schema.js';
import { ALL_CHECKS } from './index.js';

// ─── Pinned roster identity ──────────────────────────────────────────────────

/**
 * The SIXTEEN checks shipped today, pinned by `(category, name)` and ORDER.
 * `ALL_CHECKS` order is part of the observable contract: the composer preserves
 * it so callers scan top-to-bottom for the first Fail. A task adding a check
 * must update this list (and the count) deliberately — that edit is the signal
 * this guard exists to force.
 *
 * DELIBERATE PIN UPDATE (task 009, design §4.6): the `verification-toolchain`
 * entry (category `verification`) was added as a CONSCIOUS act (12 → 13).
 * DELIBERATE PIN UPDATE (Task 017, DR-5/DR-7): `onramp-block-drift` (the Task 013
 * drift finding, previously unregistered) and `retired-hooks-present` (the
 * uninstall-reachability check) were added together in the `agent` block, in that
 * order (block-write step before hook-removal step); the count is updated
 * 13 → 15 on purpose.
 * DELIBERATE PIN UPDATE (Task 011): `stale-skill-dirs` (category `plugin`) was
 * added as a further CONSCIOUS act, updating the count 15 → 16.
 */
const PINNED_ROSTER: ReadonlyArray<{
  category: CheckResult['category'];
  name: string;
}> = [
  { category: 'runtime', name: 'node-version' },
  { category: 'storage', name: 'state-dir' },
  { category: 'storage', name: 'storage-sqlite-health' },
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
  { category: 'remote', name: 'remote-mcp' },
  { category: 'invariants', name: 'invariants-catalog' },
  { category: 'verification', name: 'verification-toolchain' },
];

// ─── Benign probe bundle (identity scaffolding only) ─────────────────────────

/**
 * A DoctorProbes bundle where every probe returns a SAFE value so each check
 * reaches its return statement and surfaces its own `(name, category)`. We do
 * NOT assert the resulting statuses — those depend on the (benign) probe values
 * and are host-/scaffold-dependent; only the identity each check stamps on its
 * result is pinned. This mirrors the real `DoctorProbes` field surface (see
 * `make-stub-probes.ts`) without throwing, since here we WANT every check to
 * run rather than fault on an unstubbed probe.
 */
function benignProbes(): DoctorProbes {
  const emptyEnvironments: AgentEnvironment[] = [];
  return {
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
      runIntegrityCheck: async (): Promise<IntegrityResult> => ({
        ok: 'skipped',
        reason: 'benign roster probe',
      }),
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

// ─── Characterization ────────────────────────────────────────────────────────

describe('doctor roster characterization (T0 baseline)', () => {
  it('DoctorRoster_CurrentBuild_ExactlySixteenChecksWithStableNames', async () => {
    // The static export ships exactly sixteen checks, in pinned order. (13 → 15
    // by Task 017: onramp-block-drift + retired-hooks-present; 15 → 16 by
    // Task 011: stale-skill-dirs.)
    expect(ALL_CHECKS).toHaveLength(16);
    expect(PINNED_ROSTER).toHaveLength(16);

    const results = await runRoster();
    expect(results).toHaveLength(16);

    // Each check, run through the REAL ALL_CHECKS, stamps its own identity —
    // we read (category, name) off the returned result rather than transcribing.
    const observedIdentity = results.map((r) => ({
      category: r.category,
      name: r.name,
    }));
    expect(observedIdentity).toEqual(PINNED_ROSTER);

    // The name set is exactly the pinned set: no duplicates, no strays.
    const observedNames = new Set(results.map((r) => r.name));
    expect(observedNames.size).toBe(16);
    for (const { name } of PINNED_ROSTER) {
      expect(observedNames.has(name)).toBe(true);
    }

    // Every result satisfies the canonical CheckResult contract — proves each
    // entry is a real check returning a schema-valid result, not a stub.
    for (const r of results) {
      expect(CheckResultSchema.safeParse(r).success).toBe(true);
    }
  });

  it('DoctorRoster_CurrentBuild_StatusVocabularyPinned', () => {
    // The status vocabulary is exactly these four values, sourced from the
    // canonical CheckStatusSchema enum (the type CheckFn results derive from).
    expect(CheckStatusSchema.options).toEqual(['Pass', 'Warning', 'Fail', 'Skipped']);

    // Each vocabulary member round-trips through the schema (the enum is closed).
    for (const status of ['Pass', 'Warning', 'Fail', 'Skipped'] as const) {
      expect(CheckStatusSchema.safeParse(status).success).toBe(true);
    }
    // A value outside the vocabulary is rejected (the enum admits nothing else).
    expect(CheckStatusSchema.safeParse('Unknown').success).toBe(false);
    expect(CheckStatusSchema.safeParse('Ok').success).toBe(false);
  });
});
