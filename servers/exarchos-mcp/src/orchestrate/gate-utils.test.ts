// ─── Gate Utils Tests ─────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import {
  emitGateEvent,
  resolveRepoRoot,
  AUTO_REPO_ROOT,
  resolvePolicySkip,
  resolvePhaseMode,
} from './gate-utils.js';
import type { EventStore } from '../event-store/store.js';
import { resolveConfig } from '../config/resolve.js';
import type { VerificationPolicyOverlay } from '../config/yaml-schema.js';
import {
  VERIFICATION_GATE_NAMES,
  resolveVerificationSequence,
  type GateName,
  type RiskTier,
} from '../workflow/verification-policy.js';
import { classifyTask } from './prepare-delegation.js';

describe('emitGateEvent', () => {
  // ─── Test 1: Valid input appends gate.executed event ─────────────────────

  it('emitGateEvent_ValidInput_AppendsGateExecutedEvent', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    // Act
    await emitGateEvent(mockStore as any, 'stream-1', 'test-gate', 'CI', true);

    // Assert
    expect(mockStore.append).toHaveBeenCalledOnce();
    expect(mockStore.append).toHaveBeenCalledWith('stream-1', {
      type: 'gate.executed',
      data: { gateName: 'test-gate', layer: 'CI', passed: true },
    });
  });

  // ─── Test 2: With details includes details in payload ────────────────────

  it('emitGateEvent_WithDetails_IncludesDetailsInPayload', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };
    const details = { passCount: 10, failCount: 2 };

    // Act
    await emitGateEvent(mockStore as any, 'stream-2', 'test-suite', 'CI', false, details);

    // Assert
    expect(mockStore.append).toHaveBeenCalledWith('stream-2', {
      type: 'gate.executed',
      data: { gateName: 'test-suite', layer: 'CI', passed: false, details },
    });
  });

  // ─── Test 3: With custom layer uses provided layer ───────────────────────

  it('emitGateEvent_WithCustomLayer_UsesProvidedLayer', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    // Act
    await emitGateEvent(mockStore as any, 'stream-3', 'design-check', 'design', true);

    // Assert
    expect(mockStore.append).toHaveBeenCalledWith('stream-3', {
      type: 'gate.executed',
      data: { gateName: 'design-check', layer: 'design', passed: true },
    });
  });

  // ─── Test 4: Without details omits details from payload ──────────────────

  it('emitGateEvent_WithoutDetails_OmitsDetailsFromPayload', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    // Act
    await emitGateEvent(mockStore as any, 'stream-4', 'post-merge', 'post-merge', true);

    // Assert
    const calledEvent = mockStore.append.mock.calls[0]![1];
    expect(calledEvent.data).not.toHaveProperty('details');
  });
});

// ─── resolveRepoRoot (#1330 / T-04) ────────────────────────────────────────

describe('resolveRepoRoot', () => {
  function storeWith(events: Array<{ type: string; data: unknown }>): EventStore {
    return { query: vi.fn().mockResolvedValue(events) } as unknown as EventStore;
  }

  it('resolveRepoRoot_NoRepoRoot_DefaultsToProcessCwd', async () => {
    const store = storeWith([]);
    const result = await resolveRepoRoot({ featureId: 'feat-1' }, store);
    expect(result).toEqual({ ok: true, repoRoot: process.cwd() });
  });

  it('resolveRepoRoot_LiteralPath_ReturnedVerbatim', async () => {
    const store = storeWith([]);
    const result = await resolveRepoRoot(
      { featureId: 'feat-1', repoRoot: '/home/user/project' },
      store,
    );
    expect(result).toEqual({ ok: true, repoRoot: '/home/user/project' });
    // No event lookup needed for a literal path.
    expect((store.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('resolveRepoRoot_AutoWithWorktreePathArg_PrefersArg', async () => {
    const store = storeWith([
      { type: 'worktree.created', data: { taskId: 'task-9', path: '/from/event' } },
    ]);
    const result = await resolveRepoRoot(
      {
        featureId: 'feat-1',
        repoRoot: AUTO_REPO_ROOT,
        worktreePath: '/from/arg',
        taskId: 'task-9',
      },
      store,
    );
    expect(result).toEqual({ ok: true, repoRoot: '/from/arg' });
    // The explicit arg wins; no event lookup performed.
    expect((store.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('resolveRepoRoot_AutoNoArg_ResolvesLatestWorktreeCreatedEventForTask', async () => {
    const store = storeWith([
      { type: 'worktree.created', data: { taskId: 'task-9', path: '/old' } },
      { type: 'worktree.created', data: { taskId: 'other', path: '/wrong-task' } },
      { type: 'worktree.created', data: { taskId: 'task-9', path: '/latest' } },
    ]);
    const result = await resolveRepoRoot(
      { featureId: 'feat-1', repoRoot: AUTO_REPO_ROOT, taskId: 'task-9' },
      store,
    );
    expect(result).toEqual({ ok: true, repoRoot: '/latest' });
  });

  it('resolveRepoRoot_AutoUnresolvable_ReturnsError', async () => {
    const store = storeWith([]);
    const result = await resolveRepoRoot(
      { featureId: 'feat-1', repoRoot: AUTO_REPO_ROOT, taskId: 'task-9' },
      store,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('task-9');
  });
});

// ─── resolvePolicySkip (task 004) ───────────────────────────────────────────

const ALL_TIERS: readonly RiskTier[] = ['low', 'medium', 'high'];
const ALL_BOUNDARY: readonly boolean[] = [false, true];

function configWith(policy: VerificationPolicyOverlay) {
  return resolveConfig({ verification: { policy } });
}

describe('resolvePolicySkip', () => {
  it('ResolvePolicySkip_ConfiguredCellExcludesGate_SkipsWithConfigSource', () => {
    // A config cell that REPLACES the medium-base sequence with one that omits
    // `check_test_adequacy` must produce a skip for that gate, and the reason
    // must name the CONFIG source so a config-induced skip is never read as a
    // builtin decision.
    const overlay: VerificationPolicyOverlay = {
      // medium normally clears [static_analysis, test_adequacy]; drop the latter.
      medium: ['check_static_analysis'],
    };
    const config = configWith(overlay);

    const skip = resolvePolicySkip({
      gateName: 'check_test_adequacy',
      riskTier: 'medium',
      boundaryTouching: false,
      config,
    });
    expect(skip).not.toBeNull();
    expect(skip?.reason).toContain('policy: config');
    expect(skip?.reason).not.toContain('policy: builtin');

    // A gate that the config cell DOES include must still run (no skip).
    const noSkip = resolvePolicySkip({
      gateName: 'check_static_analysis',
      riskTier: 'medium',
      boundaryTouching: false,
      config,
    });
    expect(noSkip).toBeNull();
  });

  it('ResolvePolicySkip_BuiltinDecision_ReasonNamesBuiltinSource', () => {
    // No config (or a config whose cell is unset) → the builtin table decides.
    // A gate not in the builtin sequence for the profile is skipped, and the
    // reason names the BUILTIN source.
    const skip = resolvePolicySkip({
      gateName: 'check_integration_suite',
      riskTier: 'low',
      boundaryTouching: false,
    });
    expect(skip).not.toBeNull();
    expect(skip?.reason).toContain('policy: builtin');
    expect(skip?.reason).not.toContain('policy: config');

    // Same result when a config is present but its relevant cell is unset —
    // the builtin table still decides, source stays builtin.
    const config = configWith({ high: ['check_static_analysis'] });
    const skipUnsetCell = resolvePolicySkip({
      gateName: 'check_integration_suite',
      riskTier: 'low',
      boundaryTouching: false,
      config,
    });
    expect(skipUnsetCell).not.toBeNull();
    expect(skipUnsetCell?.reason).toContain('policy: builtin');
  });

  it('ResolvePolicySkip_PartialStamp_StillRunsUnconditionally', () => {
    // Characterization rail: a partial stamp (either field absent) returns null
    // so the gate runs unconditionally — preserved byte-identically. Config
    // presence must NOT change this (absent stamp dominates).
    const config = configWith({ medium: [] });

    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', boundaryTouching: false }),
    ).toBeNull();
    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', riskTier: 'medium' }),
    ).toBeNull();
    expect(resolvePolicySkip({ gateName: 'check_test_adequacy' })).toBeNull();

    // Same, with a config that would otherwise exclude the gate — the absent
    // stamp still dominates and the gate runs.
    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', riskTier: 'medium', config }),
    ).toBeNull();
    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', boundaryTouching: false, config }),
    ).toBeNull();
  });

  it('ResolvePolicySkip_BothStampsAbsent_ReasonAbsentByteIdenticalToNull', () => {
    // No config threaded: behavior must match the pre-task-004 absent-stamp path
    // exactly (null when either stamp is absent).
    for (const gate of VERIFICATION_GATE_NAMES) {
      expect(resolvePolicySkip({ gateName: gate })).toBeNull();
    }
  });
});

// ─── Round-trip: stamp ⇔ skip consistency (task 004) ────────────────────────

describe('StampAndSkip consistency', () => {
  it('StampAndSkip_SameConfig_NeverDisagree', () => {
    // For a matrix of (tier × boundary × config-variant), the stamped sequence
    // (`classifyTask`) and the per-gate skip decisions (`resolvePolicySkip`)
    // must be mutually consistent: a gate is skipped IFF it is NOT in the
    // stamped sequence. The two surfaces now share `resolveVerificationPolicy`,
    // so they can never diverge.
    type Variant = { readonly label: string; readonly config: ReturnType<typeof configWith> | undefined };

    for (const tier of ALL_TIERS) {
      for (const boundary of ALL_BOUNDARY) {
        // Per-cell config variants:
        //  - no config (builtin table)
        //  - a custom non-empty cell for THIS exact (tier, boundary) cell
        //  - an explicit empty cell for THIS exact (tier, boundary) cell
        const customCell: GateName[] = ['check_static_analysis', 'check_mock_boundary'];
        const custom = boundary
          ? ({ boundary: { [tier]: customCell } } as VerificationPolicyOverlay)
          : ({ [tier]: customCell } as VerificationPolicyOverlay);
        const empty = boundary
          ? ({ boundary: { [tier]: [] } } as VerificationPolicyOverlay)
          : ({ [tier]: [] } as VerificationPolicyOverlay);

        const variants: readonly Variant[] = [
          { label: 'no-config', config: undefined },
          { label: 'custom-cell', config: configWith(custom) },
          { label: 'empty-cell', config: configWith(empty) },
        ];

        for (const variant of variants) {
          // Stamp via the delegation classifier with explicit tier/boundary
          // overrides (so the derived profile is exactly this cell).
          const classification = classifyTask(
            {
              id: `t-${tier}-${boundary}`,
              title: 'round-trip task',
              riskTier: tier,
              boundaryTouching: boundary,
            },
            undefined,
            variant.config,
          );
          const stamped = classification.verificationSequence;

          // The classification's stamped profile must equal (tier, boundary).
          expect(classification.riskTier).toBe(tier);
          expect(classification.boundaryTouching).toBe(boundary);

          // For EVERY gate, skip ⇔ not-in-stamped-sequence.
          for (const gate of VERIFICATION_GATE_NAMES) {
            const skip = resolvePolicySkip({
              gateName: gate,
              riskTier: tier,
              boundaryTouching: boundary,
              config: variant.config,
            });
            const inSequence = stamped.includes(gate);
            const message =
              `tier=${tier} boundary=${boundary} variant=${variant.label} gate=${gate}: ` +
              `stamped=[${stamped.join(',')}] skip=${skip ? 'SKIP' : 'RUN'}`;
            // skipped IFF not in the stamped sequence.
            expect(skip === null, message).toBe(inSequence);
          }
        }
      }
    }
  });

  it('StampAndSkip_NoConfig_MatchesBuiltinTable', () => {
    // Belt-and-suspenders: with no config, the stamped sequence is exactly the
    // builtin table, and every skip decision agrees with it.
    for (const tier of ALL_TIERS) {
      for (const boundary of ALL_BOUNDARY) {
        const builtin = resolveVerificationSequence(tier, boundary);
        const stamped = classifyTask({
          id: 't',
          title: 'x',
          riskTier: tier,
          boundaryTouching: boundary,
        }).verificationSequence;
        expect(stamped).toEqual(builtin);

        for (const gate of VERIFICATION_GATE_NAMES) {
          const skip = resolvePolicySkip({ gateName: gate, riskTier: tier, boundaryTouching: boundary });
          expect(skip === null).toBe(builtin.includes(gate));
        }
      }
    }
  });
});

// ─── resolvePhaseMode (DR-16, #1546) ─────────────────────────────────────────

describe('resolvePhaseMode', () => {
  it('migratedGates_PlanReviewSynthesis_BindEnforceNotAudit', () => {
    // The migrated PLAN/REVIEW/SYNTHESIZE gates already BLOCKED under the
    // pre-binding playbooks, so they bind DIRECTLY to enforce (behavior-
    // preserving). Even on a workflow type whose IMPLEMENT phase graduates to
    // audit (oneshot), these kinds stay enforce — audit-first was only ever
    // correct for S2's genuinely-new IMPLEMENT coverage.
    for (const kind of ['PLAN', 'REVIEW', 'SYNTHESIZE'] as const) {
      expect(resolvePhaseMode(kind, 'oneshot')).toBe('enforce');
      expect(resolvePhaseMode(kind, 'feature')).toBe('enforce');
    }
  });

  it('implementKind_StillGraduatesPerWorkflowType', () => {
    // IMPLEMENT keeps its per-workflow audit→enforce graduation (DR-6).
    expect(resolvePhaseMode('IMPLEMENT', 'oneshot')).toBe('audit');
    expect(resolvePhaseMode('IMPLEMENT', 'feature')).toBe('enforce');
    expect(resolvePhaseMode('IMPLEMENT', 'debug')).toBe('enforce');
  });

  it('gatherKind_NoGates_DefaultsEnforce', () => {
    // GATHER carries no gates; enforce is the safe default (never silently
    // downgrade an unexpected kind).
    expect(resolvePhaseMode('GATHER', 'feature')).toBe('enforce');
  });
});
