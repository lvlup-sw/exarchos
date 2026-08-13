// ─── DR-25 kill fixture + INV-4 fallback contract ───────────────────────────
//
// DR-25 added a `dispatch` field to every provisioning verb that declares a
// `posture`, and `validateProvisionedDispatch` is the guard that rejects a
// payload which declares a posture it does not BIND. A guard with no currently
// failing subject has not been shown to work — and DR-25 removed its subject
// from the codebase, because `prepare_review` now always emits `dispatch`.
//
// So the subject is FROZEN rather than live. `fixtures/prepare-review-pre-dr25.json`
// is the verbatim `handlePrepareReview({ scope: 'plan', … })` result captured on
// the commit immediately BEFORE the fix, committed on its own so its provenance
// is auditable. It carries `data.posture: "read-only"` and no `data.dispatch`:
// the exact output that produced the 2026-08-07 incident (a `read-only` panel
// dispatched with `name` and no isolation → three phantom teammates, zero
// verdicts, agents invisible to `ListAgents`).
//
// The fixture is a HISTORICAL ARTIFACT, not a golden snapshot. It is never
// regenerated: a re-capture would carry the post-DR-25 `dispatch` field and
// silently defeat the kill test. The first arm below fails loudly if that ever
// happens, so the defeat cannot be silent.
//
// ── The two authorities (DR-30) ────────────────────────────────────────────
//
// The claims here are "this frozen payload FAILS this guard" and "this table
// resolves against these runtimes' own declarations". Neither side may be the
// other wearing a second name:
//
//   ./fixtures/prepare-review-pre-dr25.json — a payload produced by code that
//       predates the guard entirely. It cannot have been shaped to agree with
//       a validator that did not exist when it was captured.
//   ../../runtime/agents/dispatch-shape.ts          — the table, the resolver, and the
//       guard under test.
//   ../../runtime/agents/adapters/codex.ts          — the Codex runtime's OWN
//       capability declaration, written by adapter authors with no knowledge of
//       the posture table.
//
// None of the three reaches either of the others in the static import graph.
//
// @oracle-sources: ./fixtures/prepare-review-pre-dr25.json, ../../runtime/agents/dispatch-shape.ts, ../../runtime/agents/adapters/codex.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DISPATCH_SHAPE_UNSUPPORTED,
  dispatchShapeFor,
  resolveDispatchShape,
  validateProvisionedDispatch,
  type DispatchResolution,
  type DispatchValidation,
  type RuntimeCapabilityDeclaration,
} from '../../runtime/agents/dispatch-shape.js';
import { AgentPosture } from '../../runtime/agents/spec.js';
import { Capability } from '../../runtime/agents/capabilities.js';
import { buildSupportMap } from '../../runtime/agents/adapters/support-levels.js';
import { codexAdapter } from '../../runtime/agents/adapters/codex.js';
import type { SupportLevel } from '../../runtime/agents/adapters/types.js';
import { handlePrepareReview } from '../team/prepare-review.js';
import { EventStore } from '../../events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

// ─── typed access to an untrusted payload (no `any`) ────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/prepare-review-pre-dr25.json', import.meta.url),
);

/** Raw bytes of the frozen fixture — read, never written. */
function frozenFixtureText(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

/** The `data` payload of the frozen `ToolResult`, still untrusted. */
function frozenProvisioning(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(frozenFixtureText());
  if (!isRecord(parsed)) throw new Error(`${FIXTURE_PATH} is not a JSON object`);
  const data: unknown = parsed.data;
  if (!isRecord(data)) throw new Error(`${FIXTURE_PATH} carries no \`data\` object`);
  return data;
}

/**
 * The failure text of a validation, or `null` when it passed.
 *
 * Asserting on `null` rather than on `ok === true` is deliberate: when the
 * guard refuses something it should have accepted, the diff prints the refusal
 * reason instead of `false !== true`.
 */
function refusalReason(verdict: DispatchValidation): string | null {
  return verdict.ok ? null : verdict.reason;
}

// ─── 1. The kill fixture ────────────────────────────────────────────────────

describe('the pre-DR-25 prepare_review output is a live failing subject (DR-25)', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'dr25-kill-fixture-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  /**
   * BLOCKING CLAIM — the frozen pre-DR-25 provisioning must be REFUSED by
   * `validateProvisionedDispatch`, and refused for the stated reason (an
   * unbound launch shape), not incidentally.
   *
   * NEGATIVE TWIN — the seam this kills is the missing-`dispatch` branch of
   * `validateProvisionedDispatch`. The twin is the SAME frozen payload with the
   * one field DR-25 added spliced in: it must PASS. Red and green then differ
   * by exactly that one field, so the refusal is attributable to the guard
   * rather than to some unrelated property of an archived payload. Delete the
   * missing-`dispatch` branch and the blocking arm goes red; make the guard
   * refuse everything and the twin goes red. Both were run.
   */
  it('PrepareReview_CurrentOutput_LacksDispatchField', async () => {
    const rawText = frozenFixtureText();
    const frozen = frozenProvisioning();

    // ── Provenance precondition. The fixture's whole value is that it predates
    // the fix. If someone re-captures it from today's handler it gains a
    // `"dispatch":` key, every arm below starts passing for the wrong reason,
    // and the kill test becomes decorative. Fail here instead, loudly.
    expect(
      /"dispatch"\s*:/.test(rawText),
      'the frozen fixture now carries a `dispatch` key — it was regenerated, which defeats the kill test. Restore the committed copy (see the sibling README).',
    ).toBe(false);
    expect(Object.hasOwn(frozen, 'posture')).toBe(true);
    expect(frozen.posture).toBe('read-only');
    expect(Object.hasOwn(frozen, 'dispatch')).toBe(false);

    // ── BLOCKING ARM. The guard refuses it, and names the unbound launch shape
    // as the reason. Asserting only `ok === false` would be satisfied by the
    // malformed-`dispatch` branch too, so the reason carries the claim.
    const verdict = validateProvisionedDispatch(frozen);
    expect(verdict.ok).toBe(false);
    expect(refusalReason(verdict)).toContain('no `dispatch` field');
    expect(refusalReason(verdict)).toContain('read-only');

    // ── NEGATIVE TWIN. The same payload, same guard, plus the bound launch
    // shape DR-25 introduced. A validator that rejected every payload would
    // satisfy the arm above while enforcing nothing; this is what stops that.
    const repaired = { ...frozen, dispatch: dispatchShapeFor('read-only') };
    const twin = validateProvisionedDispatch(repaired);
    expect(refusalReason(twin)).toBeNull();
    expect(twin.ok).toBe(true);

    // ── The differential, measured against production rather than asserted.
    // Today's real handler, same verb, same scope, emits a payload that PASSES
    // the guard the frozen one fails — while agreeing with it on the fields
    // DR-25 did not touch. The delta between refused and accepted is DR-25.
    const result = await handlePrepareReview(
      {
        featureId: 'dr25-kill-fixture',
        scope: 'plan',
        artifact: 'docs/specs/2026-08-06-internal-mechanics-overhaul.md',
      },
      stateDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    const live: unknown = result.data;
    if (!isRecord(live)) throw new Error('prepare_review returned no provisioning payload');

    expect(refusalReason(validateProvisionedDispatch(live))).toBeNull();
    expect(live.mode).toBe(frozen.mode);
    expect(live.posture).toBe(frozen.posture);
    expect(live.adversarial).toBe(frozen.adversarial);
    expect(Object.hasOwn(live, 'dispatch')).toBe(true);

    // And the field that closed the gap is the TABLE's row, not a restatement
    // the verb could drift from.
    expect(live.dispatch).toBe(dispatchShapeFor('read-only'));
  });
});

// ─── 2. INV-4: an undeclared capability is a fallback or a typed error ──────

/** A runtime that declares every capability native except `withheld`. */
function runtimeWithout(withheld: Capability, level: SupportLevel): RuntimeCapabilityDeclaration {
  const overrides: Partial<Record<Capability, SupportLevel>> = {};
  overrides[withheld] = level;
  return {
    runtime: `harness-without-${withheld}@${level}`,
    supportLevels: buildSupportMap('native', overrides),
  };
}

/**
 * The two ways a runtime can fail to declare a capability `native`.
 * `advisory` is included deliberately: the adapter contract defines it as
 * "accepted without error, but the runtime has no primitive to enforce or
 * expose it", which IS the silent-degradation surface. A shape whose isolation
 * is merely tolerated is a shape whose isolation does not exist.
 */
const NON_NATIVE_LEVELS: readonly SupportLevel[] = ['advisory', 'unsupported'];

/** Would this launch spawn something that never runs the prompt? */
function isMailboxShape(naming: string, workspace: string): boolean {
  return naming === 'named' && workspace !== 'worktree';
}

describe('DispatchShape runtime resolution never degrades silently (DR-25, INV-4)', () => {
  /**
   * BLOCKING CLAIM — for every declared posture, withholding any capability
   * that posture's shape REQUIRES must produce either the declared fallback
   * (visibly degraded) or a typed `DISPATCH_SHAPE_UNSUPPORTED` error. The
   * outcome this forbids is the third one: `honoured` and NOT `degraded`, i.e.
   * the canonical shape handed straight back to a harness that cannot run it.
   * That is the silent no-op, and it is what the 2026-08-07 incident was.
   *
   * NEGATIVE TWIN — the seam is the unmet-capability branch of
   * `resolveDispatchShape`. The twin is the fully-native control runtime at the
   * end: every posture must resolve UNDEGRADED against it. A resolver that
   * always errored, or always degraded, would satisfy every negative arm above
   * while binding nothing; the control is what makes the withheld capability —
   * and not the resolver's temperament — the cause of each outcome.
   */
  it('DispatchShape_UnsupportedRuntimeCapability_ReturnsTypedError', () => {
    let fallbackOutcomes = 0;
    let typedErrorOutcomes = 0;

    for (const posture of AgentPosture.options) {
      const declared = dispatchShapeFor(posture);
      expect(declared.requires.length).toBeGreaterThan(0);

      for (const withheld of declared.requires) {
        for (const level of NON_NATIVE_LEVELS) {
          const runtime = runtimeWithout(withheld, level);
          const at = `${posture} withholding ${withheld} (${level})`;

          // A resolution is a VALUE, never a throw — a thrown resolver would be
          // indistinguishable from a crashed one at the dispatch site.
          const resolved: DispatchResolution = resolveDispatchShape(posture, runtime);
          expect(isRecord(resolved), at).toBe(true);
          expect(typeof resolved.honoured, at).toBe('boolean');

          // ── THE FORBIDDEN OUTCOME. Honoured-and-undegraded means the caller
          // was handed the canonical shape for a harness that cannot run it,
          // with nothing in the result saying so. Silent no-op.
          expect(
            resolved.honoured && !resolved.degraded,
            `${at}: resolver returned the undegraded canonical shape despite an unmet requirement — that is a silent no-op`,
          ).toBe(false);

          if (resolved.honoured) {
            expect(resolved.degraded, at).toBe(true);
            if (!resolved.degraded) throw new Error('unreachable');

            // The DECLARED fallback by identity — not an improvised look-alike
            // the resolver assembled on the spot.
            expect(resolved.shape, at).toBe(declared.fallback);
            expect(resolved.declaredShape, at).toBe(declared);

            // Visible, not quiet: the caller can see what it lost and say so.
            expect(resolved.unmet, at).toContain(withheld);
            expect(resolved.reason.length, at).toBeGreaterThan(0);

            // A fallback may trade away isolation or freshness. It may never
            // trade away RUNNING THE PROMPT.
            expect(
              isMailboxShape(resolved.shape.naming, resolved.shape.workspace),
              `${at}: fallback degraded to the named-without-isolation mailbox shape`,
            ).toBe(false);
            fallbackOutcomes += 1;
            continue;
          }

          // ── TYPED ERROR. Discriminated by an exported code, carrying the
          // posture, the runtime, and the capabilities that could not be met.
          expect(resolved.error.code, at).toBe(DISPATCH_SHAPE_UNSUPPORTED);
          expect(resolved.error.posture, at).toBe(posture);
          expect(resolved.error.runtime, at).toBe(runtime.runtime);
          expect(resolved.error.unmet.length, at).toBeGreaterThan(0);
          expect(resolved.error.message, at).toContain(runtime.runtime);
          expect(resolved.error.message, at).toContain(posture);

          // The distinction that separates a typed error from a silent no-op at
          // the CALL SITE: a refused resolution carries NO dispatchable shape.
          // A caller cannot read one off it and launch anyway.
          expect(
            Object.hasOwn(resolved, 'shape'),
            `${at}: a refused resolution still carries a dispatchable shape — a caller could launch it and never know`,
          ).toBe(false);
          typedErrorOutcomes += 1;
        }
      }
    }

    // Both outcomes are genuinely exercised. Without this, a table whose every
    // posture happened to be terminal would make the fallback arm vacuous, and
    // vice versa.
    expect(fallbackOutcomes).toBeGreaterThan(0);
    expect(typedErrorOutcomes).toBeGreaterThan(0);

    // ── The example DR-25 names by name, against a REAL adapter's own
    // declaration rather than a synthetic one: worktree isolation on a runtime
    // without native support.
    expect(Capability.options).toContain('isolation:worktree');
    expect(codexAdapter.supportLevels['isolation:worktree']).not.toBe('native');
    const onCodex = resolveDispatchShape('task-isolated', codexAdapter);
    expect(onCodex.honoured && !onCodex.degraded, 'codex must not resolve task-isolated silently').toBe(
      false,
    );
    expect(onCodex.honoured).toBe(true);
    if (!onCodex.honoured) throw new Error('unreachable');
    if (!onCodex.degraded) throw new Error('unreachable');
    expect(onCodex.shape).toBe(dispatchShapeFor('task-isolated').fallback);
    expect(onCodex.unmet).toContain('isolation:worktree');
    expect(isMailboxShape(onCodex.shape.naming, onCodex.shape.workspace)).toBe(false);

    // ── NEGATIVE TWIN / control. Restore every capability and the SAME resolver
    // returns the canonical shape, undegraded, for every posture. This is what
    // proves the withheld capability caused each outcome above.
    const fullyNative: RuntimeCapabilityDeclaration = {
      runtime: 'fully-native-harness',
      supportLevels: buildSupportMap('native'),
    };
    for (const posture of AgentPosture.options) {
      const control = resolveDispatchShape(posture, fullyNative);
      expect(control.honoured, `control ${posture}`).toBe(true);
      if (!control.honoured) throw new Error('unreachable');
      expect(control.degraded, `control ${posture}`).toBe(false);
      expect(control.shape, `control ${posture}`).toBe(dispatchShapeFor(posture));
    }

    // Refusal is returned, never thrown.
    expect(() =>
      resolveDispatchShape('shared-mutating', runtimeWithout('fs:write', 'unsupported')),
    ).not.toThrow();
  });
});
