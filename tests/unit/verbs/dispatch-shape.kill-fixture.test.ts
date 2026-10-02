// Kill fixture for the dispatch guard, and the fallback contract for unmet capabilities.
//
// `validateProvisionedDispatch` refuses a payload that declares a `posture` but no
// `dispatch` shape. `prepare_review` always emits `dispatch`, so live code gives the
// guard no failing subject. `fixtures/prepare-review-pre-dr25.json` is a frozen
// `prepare_review` result captured before the guard existed, with `posture: "read-only"`
// and no `dispatch`. Never regenerate it. A new capture carries `dispatch` and defeats the test.
//
// The fixture, `dispatch-shape.ts` and the Codex adapter declaration do not import
// each other, so no side can agree with another by construction.
//
// @oracle-sources: ./fixtures/prepare-review-pre-dr25.json, ../../../src/runtime/agents/dispatch-shape.ts, ../../../src/runtime/agents/adapters/codex.ts

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
} from '../../../src/runtime/agents/dispatch-shape.js';
import { AgentPosture } from '../../../src/runtime/agents/spec.js';
import { Capability } from '../../../src/runtime/agents/capabilities.js';
import { buildSupportMap } from '../../../src/runtime/agents/adapters/support-levels.js';
import { codexAdapter } from '../../../src/runtime/agents/adapters/codex.js';
import type { SupportLevel } from '../../../src/runtime/agents/adapters/types.js';
import { handlePrepareReview } from '../../../src/verbs/team/prepare-review.js';
import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const FIXTURE_PATH = fileURLToPath(
  new URL('fixtures/prepare-review-pre-dr25.json', import.meta.url),
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
 * The failure text of a validation, or `null` when it passed. A wrong refusal
 * then prints its reason in the diff, not `false !== true`.
 */
function refusalReason(verdict: DispatchValidation): string | null {
  return verdict.ok ? null : verdict.reason;
}

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
   * The frozen payload must fail `validateProvisionedDispatch` for the
   * missing-`dispatch` reason, not for a malformed shape. The twin adds only the
   * table's `dispatch` row and must pass, so the refusal comes from the guard.
   * The live `prepare_review` output must pass, match the frozen `mode`, `posture`
   * and `adversarial`, and carry the table row by identity.
   */
  it('PrepareReview_CurrentOutput_LacksDispatchField', async () => {
    const rawText = frozenFixtureText();
    const frozen = frozenProvisioning();

    expect(
      /"dispatch"\s*:/.test(rawText),
      'the frozen fixture now carries a `dispatch` key — it was regenerated, which defeats the kill test. Restore the committed copy (see the sibling README).',
    ).toBe(false);
    expect(Object.hasOwn(frozen, 'posture')).toBe(true);
    expect(frozen.posture).toBe('read-only');
    expect(Object.hasOwn(frozen, 'dispatch')).toBe(false);

    const verdict = validateProvisionedDispatch(frozen);
    expect(verdict.ok).toBe(false);
    expect(refusalReason(verdict)).toContain('no `dispatch` field');
    expect(refusalReason(verdict)).toContain('read-only');

    const repaired = { ...frozen, dispatch: dispatchShapeFor('read-only') };
    const twin = validateProvisionedDispatch(repaired);
    expect(refusalReason(twin)).toBeNull();
    expect(twin.ok).toBe(true);

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

    expect(live.dispatch).toBe(dispatchShapeFor('read-only'));
  });
});

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

/** True for a named launch without worktree isolation, which never runs the prompt. */
function isMailboxShape(naming: string, workspace: string): boolean {
  return naming === 'named' && workspace !== 'worktree';
}

describe('DispatchShape runtime resolution never degrades silently (DR-25, INV-4)', () => {
  /**
   * For each posture, withholding a required capability must give the declared
   * fallback, marked degraded, or a typed `DISPATCH_SHAPE_UNSUPPORTED` error with
   * no `shape`. An honoured, undegraded result is a silent no-op. A fallback must
   * not be the named shape without isolation. Both outcomes must occur.
   *
   * The Codex adapter lacks native worktree isolation and must degrade
   * `task-isolated`. The fully native control resolves every posture undegraded,
   * so the withheld capability causes each outcome. The resolver never throws.
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

          const resolved: DispatchResolution = resolveDispatchShape(posture, runtime);
          expect(isRecord(resolved), at).toBe(true);
          expect(typeof resolved.honoured, at).toBe('boolean');

          expect(
            resolved.honoured && !resolved.degraded,
            `${at}: resolver returned the undegraded canonical shape despite an unmet requirement — that is a silent no-op`,
          ).toBe(false);

          if (resolved.honoured) {
            expect(resolved.degraded, at).toBe(true);
            if (!resolved.degraded) throw new Error('unreachable');

            expect(resolved.shape, at).toBe(declared.fallback);
            expect(resolved.declaredShape, at).toBe(declared);

            expect(resolved.unmet, at).toContain(withheld);
            expect(resolved.reason.length, at).toBeGreaterThan(0);

            expect(
              isMailboxShape(resolved.shape.naming, resolved.shape.workspace),
              `${at}: fallback degraded to the named-without-isolation mailbox shape`,
            ).toBe(false);
            fallbackOutcomes += 1;
            continue;
          }

          expect(resolved.error.code, at).toBe(DISPATCH_SHAPE_UNSUPPORTED);
          expect(resolved.error.posture, at).toBe(posture);
          expect(resolved.error.runtime, at).toBe(runtime.runtime);
          expect(resolved.error.unmet.length, at).toBeGreaterThan(0);
          expect(resolved.error.message, at).toContain(runtime.runtime);
          expect(resolved.error.message, at).toContain(posture);

          expect(
            Object.hasOwn(resolved, 'shape'),
            `${at}: a refused resolution still carries a dispatchable shape — a caller could launch it and never know`,
          ).toBe(false);
          typedErrorOutcomes += 1;
        }
      }
    }

    expect(fallbackOutcomes).toBeGreaterThan(0);
    expect(typedErrorOutcomes).toBeGreaterThan(0);

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

    expect(() =>
      resolveDispatchShape('shared-mutating', runtimeWithout('fs:write', 'unsupported')),
    ).not.toThrow();
  });
});
