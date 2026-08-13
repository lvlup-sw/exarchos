/**
 * Characterization test (Feathers baseline) — DR-9, epic task 002.
 *
 * PINS the CURRENT observable output of the production `doctor` orchestrate
 * handler so the onboard/doctor consolidation (DR-1…DR-8) has a regression
 * oracle. This test MUST PASS against current code; if a post-fold change
 * alters the doctor contract, this file is the canary.
 *
 * What is pinned (the stable contract — NOT environment-dependent noise):
 *   1. The exact set of 15 checks returned as `CheckResult[]`, identified by
 *      their `(category, name)` pair and stable order. (DR-8 added
 *      `session-start-hook`; task 009 added `verification-toolchain`; Task 017
 *      added `onramp-block-drift` + `retired-hooks-present`.)
 *   2. The per-check shape invariants from the Zod contract (schema.ts):
 *        - every result carries category/name/status/message/durationMs
 *        - status === 'Skipped'  ⇒ non-empty `reason`
 *        - status ∈ {Warning,Fail} ⇒ non-empty `fix` (the fix-hint)
 *        - status ∈ {Pass,Skipped}  ⇒ no `fix`
 *   3. The `diagnostic.executed` event payload shape emitted on completion
 *      (summary tally, checkCount, failedCheckNames, durationMs).
 *
 * Why statuses are NOT pinned exactly: several checks read live environment
 * (git on PATH, cwd-relative repo root for `.exarchos.yml`, skills mtimes,
 * plugin cache presence, EventStore backend kind). Pass/Warn/Fail/Skip for
 * those is machine-dependent; pinning them would make this guard brittle.
 * The task contract (DR-9) explicitly asks to pin the *name/category set* and
 * the *contract*, not the exact statuses where they depend on the host. We
 * instead assert the universal invariants above, which hold on every host.
 *
 * Machine-specific noise normalized away: node version string, absolute
 * paths inside messages, and `durationMs` are not asserted by value — only
 * for presence / type / non-negativity.
 *
 * Invocation: production path via `handleDoctor` with the REAL `ALL_CHECKS`
 * and the REAL `buildProbes` factory — i.e. the genuine 11 checks run against
 * this worktree as the fixture repo. The only injected double is the
 * EventStore (a spy `append` + a deterministic `runIntegrityCheck` so the
 * sqlite-health check has a stable backend to map), mirroring the existing
 * `index.test.ts` fixture style.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { IntegrityResult } from '../../../../src/events/store.js';
import {
  DoctorOutputSchema,
  type CheckResult,
  type DoctorOutput,
} from '../../../../src/verbs/doctor/schema.js';
import { DiagnosticExecutedDataSchema } from '../../../../src/events/schemas.js';
import { handleDoctor, ALL_CHECKS } from '../../../../src/verbs/doctor/index.js';

// ─── Pinned canonical check identity ────────────────────────────────────────

/**
 * The fifteen checks, pinned by `(category, name)` and ORDER. `handleDoctor`
 * preserves `ALL_CHECKS` order in its output (callers scan top-to-bottom for
 * the first Fail), so the order is part of the observable contract.
 *
 * DR-8 (#1485) added `session-start-hook` — the SessionStart binding presence
 * check — placed with the other `agent`-category checks so its `diff` `hook`
 * PlanStep lands when the binding is missing.
 *
 * DELIBERATE PIN UPDATE (task 009, design §4.6): the `verification-toolchain`
 * entry (category `verification`) was added consciously — the read-only check
 * reporting whether the verification ladder's runtime resolves (12 → 13).
 *
 * DELIBERATE PIN UPDATE (Task 017, DR-5/DR-7): `onramp-block-drift` (the Task 013
 * drift finding, previously unregistered) and `retired-hooks-present` (the
 * uninstall-reachability check) were added to the `agent` block, in that order.
 * The count + diagnostic.executed `checkCount` invariant below are updated
 * 13 → 15 on purpose; this and the roster pin are the intended contract change.
 * (Task 011 added `stale-skill-dirs`, 15 → 16.)
 *
 * DELIBERATE PIN UPDATE (Task 019, DR-11 B-5): `store-path-divergence` (category
 * `storage`) was added in the storage block, after `storage-sqlite-health`, as a
 * CONSCIOUS act. The count + `checkCount` invariants are updated 16 → 17.
 *
 * DELIBERATE PIN UPDATE (P05-04): `install-freshness` (category `plugin`) was
 * added in the plugin block, after `plugin-version-match`, as a CONSCIOUS act.
 * The count + `checkCount` invariants are updated 17 → 18.
 */
const PINNED_CHECKS: ReadonlyArray<{
  category: CheckResult['category'];
  name: string;
}> = [
  { category: 'runtime', name: 'node-version' },
  { category: 'storage', name: 'state-dir' },
  { category: 'storage', name: 'storage-sqlite-health' },
  { category: 'storage', name: 'store-path-divergence' },
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
  { category: 'verification', name: 'verification-toolchain' },
];

const VALID_STATUSES = ['Pass', 'Warning', 'Fail', 'Skipped'] as const;

// ─── Fixture context ────────────────────────────────────────────────────────

/**
 * A DispatchContext whose only injected double is the EventStore: an
 * `append` spy (to capture `diagnostic.executed`) and a deterministic
 * `runIntegrityCheck` returning `{ok:'skipped'}` — the same branch an
 * InMemoryBackend reports in test fixtures, so the sqlite-health check has a
 * stable backend to project. Everything else runs through the real
 * `buildProbes` against this worktree.
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
    } as unknown as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
  return { ctx, appendSpy };
}

/** Yield to the microtask queue so the fire-and-forget
 * `void emitDiagnosticEvent(...)` append settles before assertions. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ─── Characterization ───────────────────────────────────────────────────────

describe('doctor characterization (DR-9 baseline)', () => {
  it('Doctor_SeventeenChecks_PinnedShape', async () => {
    // Arrange
    const { ctx, appendSpy } = fixtureContext();

    // Act — production path: real ALL_CHECKS + real buildProbes.
    const result = await handleDoctor({ timeoutMs: 5000 }, ctx);
    await flushMicrotasks();

    // ── Top-level result envelope ───────────────────────────────────────────
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    // The handler validates its own output through DoctorOutputSchema before
    // returning; re-parse here to pin that the returned data still satisfies
    // the contract (and to narrow the type without an `any`).
    const output: DoctorOutput = DoctorOutputSchema.parse(result.data);
    const { checks, summary } = output;

    // ── 1. The eighteen checks, pinned by (category, name) and order ──────
    // (13 → 15 updated by Task 017: onramp-block-drift + retired-hooks-present;
    // 15 → 16 by Task 011: stale-skill-dirs; 16 → 17 by Task 019:
    // store-path-divergence; 17 → 18 by P05-04: install-freshness.)
    expect(ALL_CHECKS).toHaveLength(18);
    expect(checks).toHaveLength(18);

    const observedIdentity = checks.map((c) => ({
      category: c.category,
      name: c.name,
    }));
    expect(observedIdentity).toEqual(PINNED_CHECKS);

    // The name set is exactly the pinned set (no dupes, no strays).
    const observedNames = new Set(checks.map((c) => c.name));
    expect(observedNames.size).toBe(18);
    for (const { name } of PINNED_CHECKS) {
      expect(observedNames.has(name)).toBe(true);
    }

    // ── 2. Per-check shape + contract invariants ────────────────────────────
    for (const c of checks) {
      // Universal field presence (machine-independent).
      expect(VALID_STATUSES).toContain(c.status);
      expect(typeof c.message).toBe('string');
      expect(c.message.length).toBeGreaterThan(0);
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);

      // durationMs: normalized noise — pin type + non-negativity only.
      expect(typeof c.durationMs).toBe('number');
      expect(Number.isInteger(c.durationMs)).toBe(true);
      expect(c.durationMs).toBeGreaterThanOrEqual(0);

      // Contract: Skipped ⇒ non-empty reason (no silent skips).
      if (c.status === 'Skipped') {
        expect(typeof c.reason).toBe('string');
        expect(c.reason && c.reason.length).toBeGreaterThan(0);
      }

      // Contract: Warning/Fail ⇒ non-empty fix-hint.
      if (c.status === 'Warning' || c.status === 'Fail') {
        expect(typeof c.fix).toBe('string');
        expect(c.fix && c.fix.length).toBeGreaterThan(0);
      }

      // Contract: Pass/Skipped carry no fix-hint (fix is a remediation
      // affordance only attached to actionable non-green states).
      if (c.status === 'Pass' || c.status === 'Skipped') {
        expect(c.fix).toBeUndefined();
      }
    }

    // ── Summary tally is internally consistent (pinned invariant) ───────────
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

    // ── 3. diagnostic.executed event payload shape ──────────────────────────
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const [streamId, event] = appendSpy.mock.calls[0] as [
      string,
      { type: string; data: unknown },
    ];

    // Stream id: a non-empty diagnostic stream (DOCTOR_STREAM_ID), not tied
    // to any workflow stream. Pin presence, not the literal value.
    expect(typeof streamId).toBe('string');
    expect(streamId.length).toBeGreaterThan(0);

    expect(event.type).toBe('diagnostic.executed');

    // The payload must satisfy the canonical DiagnosticExecutedDataSchema.
    const payload = DiagnosticExecutedDataSchema.parse(event.data);

    // Pinned cross-field invariants between the event and the doctor output.
    expect(payload.checkCount).toBe(checks.length);
    expect(payload.checkCount).toBe(18);
    expect(payload.summary).toEqual(summary);
    expect(payload.failedCheckNames).toEqual(
      checks.filter((c) => c.status === 'Fail').map((c) => c.name),
    );
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(payload.durationMs)).toBe(true);
  });
});
