// ─── DR-6: per-workflow severity + audit→enforce graduation (implement phases) ─
//
// task-006 (epic #1546). These tests prove the IMPLEMENT-phase obligation
// surface honors:
//  1. per-workflow SEVERITY — `oneshot:implementing` is advisory; the same
//     ladder-gate failure on `debug-implement`/`delegate`/`polish-implement`
//     (debug/feature/refactor) BLOCKS (the graduated `enforce`-mode end state);
//  2. a per-binding MODE (`audit` | `enforce`) — in `audit` a failing ladder
//     gate is downgraded to advisory (finding already emitted as the handler's
//     `gate.executed`) WITHOUT blocking, regardless of severity; newly-covered
//     phases default to `audit`;
//  3. the existing `.exarchos.yml review.gates.<gate>` override — it changes the
//     resolved behavior for IMPLEMENT phases identically to `feature:delegate`.
//
// The obligation surface under test is `applyLadderGateSeverity` (the block-vs-
// advise decision a ladder verdict flows through) plus the workflow-type→mode
// map. Severity itself is workflow-specific, NOT kind-universal (INV-6): the
// map lives next to the KIND_OBLIGATIONS *consumers* here, never in the kind
// table.

import { describe, it, expect } from 'vitest';
import {
  applyLadderGateSeverity,
  resolveImplementMode,
  IMPLEMENT_PHASE_MODE,
} from './gate-utils.js';
import { DEFAULTS } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { VERIFICATION_GATE_NAMES } from '../workflow/verification-policy.js';

// A real verification-ladder gate name — these are the only gates the
// per-workflow severity default applies to.
const LADDER_GATE = VERIFICATION_GATE_NAMES[0]; // 'check_static_analysis'

/** A failing ladder verdict — the INV-5b advisory carrier shape. */
function failingVerdict(): { success: true; data: { passed: false } } {
  return { success: true, data: { passed: false } };
}

function configWith(overrides: Partial<ResolvedProjectConfig['review']>): ResolvedProjectConfig {
  return { ...DEFAULTS, review: { ...DEFAULTS.review, ...overrides } };
}

// The workflow type each newly-covered (and the already-covered) IMPLEMENT
// phase resolves to, per DR-4 routing:
//   oneshot:implementing → 'oneshot'   (advisory)
//   debug-implement      → 'debug'     (blocking)
//   delegate             → 'feature'   (blocking, already covered)
//   polish-implement     → 'refactor'  (blocking)
const ONESHOT = 'oneshot';
const BLOCKING_WORKFLOWS = ['debug', 'feature', 'refactor'] as const;

describe('DR-6 implement-phase severity', () => {
  it('ImplementSeverity_Oneshot_Advisory', () => {
    // A failing ladder gate on `oneshot:implementing` is advisory: the workflow
    // proceeds (no blocking `passed:false` envelope is *re-asserted as failure*)
    // and a warning carries the finding. We exercise the graduated end state by
    // putting the binding in `enforce` mode so the only thing that can downgrade
    // it is the per-workflow severity (oneshot → warning).
    const result = applyLadderGateSeverity(
      LADDER_GATE,
      'D2',
      DEFAULTS,
      failingVerdict(),
      ONESHOT,
      'enforce',
    );
    // Still an advisory carrier (never throws), now downgraded NON-blocking: the
    // blocking signal is cleared (data.passed → true) and a warning carries the
    // finding. data.passed is the exact field the orchestrator consumes.
    expect(result.success).toBe(true);
    expect((result.data as { passed?: unknown }).passed).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });

  it('ImplementSeverity_FeatureDebugRefactor_Blocking', () => {
    // The SAME failing ladder verdict on debug/feature/refactor, under the
    // graduated `enforce` mode, is NOT downgraded — the orchestrator still reads
    // `data.passed:false` and blocks. No warning is attached.
    for (const workflowType of BLOCKING_WORKFLOWS) {
      const result = applyLadderGateSeverity(
        LADDER_GATE,
        'D2',
        DEFAULTS,
        failingVerdict(),
        workflowType,
        'enforce',
      );
      expect((result.data as { passed?: unknown }).passed).toBe(false);
      expect(result.warnings ?? []).toHaveLength(0);
    }
  });

  it('ImplementMode_AuditMode_DoesNotBlock', () => {
    // In `audit` mode a failing ladder gate is downgraded to advisory REGARDLESS
    // of severity — including a blocking workflow type. The `gate.executed`
    // finding is emitted by the handler itself (before this post-processing), so
    // audit mode surfaces the finding without re-asserting a blocking verdict.
    for (const workflowType of BLOCKING_WORKFLOWS) {
      const result = applyLadderGateSeverity(
        LADDER_GATE,
        'D2',
        DEFAULTS,
        failingVerdict(),
        workflowType,
        'audit',
      );
      // Audit mode never blocks: a warning carries the finding, and the result
      // is no longer a re-asserted blocking failure for the orchestrator.
      expect(result.success).toBe(true);
      // The blocking signal must actually be cleared, not merely annotated —
      // data.passed:false is what the orchestrator reads to block.
      expect((result.data as { passed?: unknown }).passed).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
    }
  });

  it('ImplementMode_AuditMode_NoConfig_StillDoesNotBlock', () => {
    // DR-6 fix: audit mode is resolved from the workflow type
    // (IMPLEMENT_PHASE_MODE) — config-INDEPENDENT — so a failing ladder gate is
    // downgraded to advisory even when NO project config is resolved (the
    // optional `DispatchContext.projectConfig` / legacy path). Before the fix the
    // `!config` early-return made audit mode silently inert here, letting a
    // newly-covered implement phase surface a blocking verdict in a no-config
    // project.
    for (const workflowType of [ONESHOT, 'debug'] as const) {
      const result = applyLadderGateSeverity(
        LADDER_GATE,
        'D2',
        undefined, // no resolved project config
        failingVerdict(),
        workflowType,
        'audit',
      );
      expect(result.success).toBe(true);
      // The blocking signal must actually be cleared, not merely annotated —
      // data.passed:false is what the orchestrator reads to block.
      expect((result.data as { passed?: unknown }).passed).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
    }
  });

  it('ImplementSeverity_NoConfig_EnforceStillBlocks', () => {
    // Contrast that bounds the fix: severity-based downgrade reads
    // `config.review.gates.*`, so without a config an `enforce` binding cannot
    // downgrade — the verdict still blocks (legacy / no-config severity
    // passthrough). Only audit mode, being config-independent, escapes it.
    const result = applyLadderGateSeverity(
      LADDER_GATE,
      'D2',
      undefined,
      failingVerdict(),
      ONESHOT,
      'enforce',
    );
    expect((result.data as { passed?: unknown }).passed).toBe(false);
    expect(result.warnings ?? []).toHaveLength(0);
  });

  it('ImplementOverride_ReviewGatesConfig_AppliesToImplementPhases', () => {
    // A `.exarchos.yml review.gates.<gate>` override changes the resolved
    // behavior for IMPLEMENT phases identically to `feature:delegate`. Pin the
    // ladder gate to warning-only: even on a blocking workflow type in `enforce`
    // mode the verdict downgrades to advisory — parity with how the override
    // behaves for the already-covered `feature:delegate` phase.
    const config = configWith({
      gates: { [LADDER_GATE]: { enabled: true, blocking: false, params: {} } },
    });
    const feature = applyLadderGateSeverity(
      LADDER_GATE,
      'D2',
      config,
      failingVerdict(),
      'feature', // delegate
      'enforce',
    );
    const debug = applyLadderGateSeverity(
      LADDER_GATE,
      'D2',
      config,
      failingVerdict(),
      'debug', // debug-implement, newly covered
      'enforce',
    );
    // Override downgrades to advisory on both — identical resolved behavior:
    // blocking signal cleared (data.passed → true) + warning attached.
    expect(feature.success).toBe(true);
    expect((feature.data as { passed?: unknown }).passed).toBe(true);
    expect(feature.warnings!.length).toBeGreaterThan(0);
    expect(debug.success).toBe(true);
    expect((debug.data as { passed?: unknown }).passed).toBe(true);
    expect(debug.warnings!.length).toBeGreaterThan(0);
  });
});

describe('DR-6 implement-phase mode map', () => {
  it('ImplementPhaseMode_OneshotAudit_BlockingWorkflowsEnforce', () => {
    // INV-6: the mode map is workflow-specific, keyed by workflow type, NOT by
    // kind. Per the DR-6 severity policy + acceptance criteria, `oneshot` (whose
    // severity is already advisory) lands in `audit`; the blocking workflows —
    // `feature:delegate` (already covered), `debug-implement`, `polish-implement`
    // — are `enforce` so a failing gate still blocks.
    expect(resolveImplementMode('oneshot')).toBe('audit');
    expect(resolveImplementMode('feature')).toBe('enforce');
    expect(resolveImplementMode('debug')).toBe('enforce');
    expect(resolveImplementMode('refactor')).toBe('enforce');
    // An unknown workflow type falls back to the safe enforce default.
    expect(resolveImplementMode('unknown-future-type')).toBe('enforce');
  });

  it('ImplementPhaseMode_TableIsFrozen', () => {
    // The map is a frozen DATA TABLE — adding a workflow type is a single-line
    // entry, never new control flow.
    expect(Object.isFrozen(IMPLEMENT_PHASE_MODE)).toBe(true);
  });
});
