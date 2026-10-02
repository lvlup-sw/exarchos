/**
 * Characterization test of the production `doctor` orchestrate handler. It pins
 * the observable contract, so a change to that contract fails this test.
 *
 * It pins three things:
 * 1. The checks in `CheckResult[]`, by `(category, name)` and order.
 * 2. The per-check rules of the Zod contract in `schema.ts`.
 * 3. The payload shape of the `diagnostic.executed` event.
 *
 * Several checks read the live host, so the test does not pin exact statuses.
 * Host inputs include git on PATH, the repo root, skills mtimes, the plugin
 * cache, and the store backend. It asserts `durationMs` and messages by type
 * and presence only.
 * The test runs `handleDoctor` with the real `ALL_CHECKS` and `buildProbes`
 * against this worktree. The only double is the event store.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { IntegrityResult } from '../../../../src/events/store.js';
import type { BundleIntegrityResult } from '../../../../src/events/bundle/integrity.js';
import {
  DoctorOutputSchema,
  type CheckResult,
  type DoctorOutput,
} from '../../../../src/verbs/doctor/schema.js';
import { DiagnosticExecutedDataSchema } from '../../../../src/events/schemas.js';
import { handleDoctor, ALL_CHECKS } from '../../../../src/verbs/doctor/index.js';

/**
 * The doctor checks, by `(category, name)` and order. `handleDoctor` keeps the order of `ALL_CHECKS`,
 * so the order is part of the observable contract. A change to this list is a deliberate contract change.
 */
const PINNED_CHECKS: ReadonlyArray<{
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

const VALID_STATUSES = ['Pass', 'Warning', 'Fail', 'Skipped'] as const;

/**
 * A `DispatchContext` with one double, the event store. Its `append` spy captures `diagnostic.executed`.
 * Its integrity checks return `skipped`, as an in-memory backend does, so the storage checks get a stable input.
 */
function fixtureContext(): {
  ctx: DispatchContext;
  appendSpy: ReturnType<typeof vi.fn>;
} {
  const appendSpy = vi.fn(async () => ({}));
  const ctx: DispatchContext = {
    stateDir: '/tmp/doctor-characterization-fixture',
    eventStore: {
      append: appendSpy,
      runIntegrityCheck: async (): Promise<IntegrityResult> => ({
        ok: 'skipped',
        reason: 'in-memory backend has no integrity pragma',
      }),
      runBundleIntegrityCheck: async (): Promise<BundleIntegrityResult> => ({
        ok: 'skipped',
        reason: 'in-memory backend does not enumerate streams',
      }),
    } as unknown as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
  return { ctx, appendSpy };
}

/** Waits one timer tick, so a pending event append settles before the assertions. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('doctor characterization (DR-9 baseline)', () => {
  /**
   * The handler parses its own output with `DoctorOutputSchema`. The test parses it again to pin the contract and to narrow the type.
   * A `Pass` or `Skipped` result carries no `fix`, because a fix is only for an actionable state.
   * The event goes to a diagnostic stream, not a workflow stream. The test pins the stream id by presence, not by value.
   */
  it('Doctor_SeventeenChecks_PinnedShape', async () => {
    const { ctx, appendSpy } = fixtureContext();

    const result = await handleDoctor({ timeoutMs: 5000 }, ctx);
    await flushMicrotasks();

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const output: DoctorOutput = DoctorOutputSchema.parse(result.data);
    const { checks, summary } = output;

    expect(ALL_CHECKS).toHaveLength(20);
    expect(checks).toHaveLength(20);

    const observedIdentity = checks.map((c) => ({
      category: c.category,
      name: c.name,
    }));
    expect(observedIdentity).toEqual(PINNED_CHECKS);

    const observedNames = new Set(checks.map((c) => c.name));
    expect(observedNames.size).toBe(20);
    for (const { name } of PINNED_CHECKS) {
      expect(observedNames.has(name)).toBe(true);
    }

    for (const c of checks) {
      expect(VALID_STATUSES).toContain(c.status);
      expect(typeof c.message).toBe('string');
      expect(c.message.length).toBeGreaterThan(0);
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);

      expect(typeof c.durationMs).toBe('number');
      expect(Number.isInteger(c.durationMs)).toBe(true);
      expect(c.durationMs).toBeGreaterThanOrEqual(0);

      if (c.status === 'Skipped') {
        expect(typeof c.reason).toBe('string');
        expect(c.reason && c.reason.length).toBeGreaterThan(0);
      }

      if (c.status === 'Warning' || c.status === 'Fail') {
        expect(typeof c.fix).toBe('string');
        expect(c.fix && c.fix.length).toBeGreaterThan(0);
      }

      if (c.status === 'Pass' || c.status === 'Skipped') {
        expect(c.fix).toBeUndefined();
      }
    }

    expect(
      summary.passed + summary.warnings + summary.failed + summary.skipped,
    ).toBe(checks.length);
    expect(summary.passed).toBe(checks.filter((c) => c.status === 'Pass').length);
    expect(summary.warnings).toBe(
      checks.filter((c) => c.status === 'Warning').length,
    );
    expect(summary.failed).toBe(checks.filter((c) => c.status === 'Fail').length);
    expect(summary.skipped).toBe(
      checks.filter((c) => c.status === 'Skipped').length,
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const [streamId, event] = appendSpy.mock.calls[0] as [
      string,
      { type: string; data: unknown },
    ];

    expect(typeof streamId).toBe('string');
    expect(streamId.length).toBeGreaterThan(0);

    expect(event.type).toBe('diagnostic.executed');

    const payload = DiagnosticExecutedDataSchema.parse(event.data);

    expect(payload.checkCount).toBe(checks.length);
    expect(payload.checkCount).toBe(20);
    expect(payload.summary).toEqual(summary);
    expect(payload.failedCheckNames).toEqual(
      checks.filter((c) => c.status === 'Fail').map((c) => c.name),
    );
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(payload.durationMs)).toBe(true);
  });
});
