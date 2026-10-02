import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  emitGateEvent,
  resolveRepoRoot,
  AUTO_REPO_ROOT,
  resolvePolicySkip,
  resolvePhaseMode,
  getDiff,
  normalizeGateVerdict,
  readGateSkipDescriptor,
  SKIPPED_BY_POLICY,
} from '../../../../src/verbs/gates/gate-utils.js';
import type { ToolResult } from '../../../../src/format.js';
import type { EventStore } from '../../../../src/events/store.js';
import { resolveConfig } from '../../../../src/config/resolve.js';
import type { VerificationPolicyOverlay } from '../../../../src/config/yaml-schema.js';
import {
  VERIFICATION_GATE_NAMES,
  resolveVerificationSequence,
  type GateName,
  type RiskTier,
} from '../../../../src/workflow/verification-policy.js';
import { classifyTask } from '../../../../src/verbs/team/prepare-delegation.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

describe('emitGateEvent', () => {
  it('emitGateEvent_ValidInput_AppendsGateExecutedEvent', async () => {
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    await emitGateEvent(mockStore as any, 'stream-1', 'test-gate', 'CI', true);

    expect(mockStore.append).toHaveBeenCalledOnce();
    expect(mockStore.append).toHaveBeenCalledWith('stream-1', {
      type: 'gate.executed',
      data: { gateName: 'test-gate', layer: 'CI', passed: true },
    });
  });

  it('emitGateEvent_WithDetails_IncludesDetailsInPayload', async () => {
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };
    const details = { passCount: 10, failCount: 2 };

    await emitGateEvent(mockStore as any, 'stream-2', 'test-suite', 'CI', false, details);

    expect(mockStore.append).toHaveBeenCalledWith('stream-2', {
      type: 'gate.executed',
      data: { gateName: 'test-suite', layer: 'CI', passed: false, details },
    });
  });

  it('emitGateEvent_WithCustomLayer_UsesProvidedLayer', async () => {
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    await emitGateEvent(mockStore as any, 'stream-3', 'design-check', 'design', true);

    expect(mockStore.append).toHaveBeenCalledWith('stream-3', {
      type: 'gate.executed',
      data: { gateName: 'design-check', layer: 'design', passed: true },
    });
  });

  it('emitGateEvent_WithoutDetails_OmitsDetailsFromPayload', async () => {
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    await emitGateEvent(mockStore as any, 'stream-4', 'post-merge', 'post-merge', true);

    const calledEvent = mockStore.append.mock.calls[0][1];
    expect(calledEvent.data).not.toHaveProperty('details');
  });
});

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

/**
 * An advisory-skip carrier holds `passed: true` and `skipped: true`. A skip is not proof, so its verdict is `indeterminate`.
 * Each case separates "did not run" from "ran and passed".
 * A guard that reads `skipped === true && passed !== true` fails the first two cases.
 */
describe('normalizeGateVerdict — an explicit skip is never proof (DR-7)', () => {
  const carrier = (data: unknown): ToolResult => ({ success: true, data });

  /** The input is the carrier that `handleTestAdequacy` returns when `resolvePolicySkip` skips the gate. */
  it('NormalizeGateVerdict_SkippedCarrierWithPassedTrue_IsIndeterminate', () => {
    const policySkip = carrier({
      passed: true,
      skipped: true,
      disposition: 'advisory-skip',
      redObserved: false,
      restoredClean: true,
      probedTests: [],
      discriminant: SKIPPED_BY_POLICY,
      reason: 'skipped by verification policy — not in the resolved sequence',
    });

    expect(normalizeGateVerdict(policySkip)).toBe('indeterminate');
    expect(normalizeGateVerdict(policySkip)).not.toBe('pass');
  });

  /** A skipped carrier produces neither proof nor a finding, so the value of `passed` has no effect. */
  it('NormalizeGateVerdict_SkippedCarrier_IsIndeterminateWhateverPassedSays', () => {
    for (const passed of [true, false, undefined]) {
      const result = carrier({ skipped: true, ...(passed === undefined ? {} : { passed }) });
      expect(normalizeGateVerdict(result)).toBe('indeterminate');
    }
  });

  /** A gate that ran keeps its verdict. An implementation that returns `indeterminate` for each input fails this test. */
  it('NormalizeGateVerdict_RanToAVerdict_StillMapsPassAndFail', () => {
    expect(normalizeGateVerdict(carrier({ passed: true }))).toBe('pass');
    expect(normalizeGateVerdict(carrier({ passed: false }))).toBe('fail');
    expect(normalizeGateVerdict(carrier({ passed: true, skipped: false }))).toBe('pass');
    expect(normalizeGateVerdict(carrier({ ready: true }))).toBe('pass');
    expect(normalizeGateVerdict(carrier({ verdict: 'APPROVED' }))).toBe('pass');
    expect(normalizeGateVerdict(carrier({ verdict: 'BLOCKED' }))).toBe('fail');
    expect(normalizeGateVerdict({ success: false, error: { code: 'X', message: 'y' } }))
      .toBe('indeterminate');
  });

  /**
   * A skip carrier returns its discriminant and reason. Other shapes are not skips.
   * A predicate that claims too much makes each ordinary gate `indeterminate`.
   * A skip without a discriminant is still a skip.
   */
  it('ReadGateSkipDescriptor_SkipCarrier_CarriesDiscriminantAndReason', () => {
    expect(
      readGateSkipDescriptor(
        carrier({ passed: true, skipped: true, discriminant: SKIPPED_BY_POLICY, reason: 'why' }),
      ),
    ).toEqual({ skipped: true, discriminant: SKIPPED_BY_POLICY, reason: 'why' });

    expect(readGateSkipDescriptor(carrier({ passed: true }))).toBeUndefined();
    expect(readGateSkipDescriptor(carrier({ skipped: 'yes' }))).toBeUndefined();
    expect(readGateSkipDescriptor(carrier(null))).toBeUndefined();
    expect(readGateSkipDescriptor(carrier([{ skipped: true }]))).toBeUndefined();
    expect(readGateSkipDescriptor(carrier({ skipped: true }))).toEqual({ skipped: true });
  });
});

const ALL_TIERS: readonly RiskTier[] = ['low', 'medium', 'high'];
const ALL_BOUNDARY: readonly boolean[] = [false, true];

function configWith(policy: VerificationPolicyOverlay) {
  return resolveConfig({ verification: { policy } });
}

describe('resolvePolicySkip', () => {
  /**
   * The config cell replaces the medium sequence and omits `check_test_adequacy`, so that gate skips.
   * The reason names the config source, so nobody reads the skip as a builtin decision.
   * A gate that the cell includes still runs.
   */
  it('ResolvePolicySkip_ConfiguredCellExcludesGate_SkipsWithConfigSource', () => {
    const overlay: VerificationPolicyOverlay = {
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

    const noSkip = resolvePolicySkip({
      gateName: 'check_static_analysis',
      riskTier: 'medium',
      boundaryTouching: false,
      config,
    });
    expect(noSkip).toBeNull();
  });

  /**
   * With no config, or a config with an unset cell, the builtin table decides.
   * A gate outside the builtin sequence skips, and the reason names the builtin source.
   */
  it('ResolvePolicySkip_BuiltinDecision_ReasonNamesBuiltinSource', () => {
    const skip = resolvePolicySkip({
      gateName: 'check_integration_suite',
      riskTier: 'low',
      boundaryTouching: false,
    });
    expect(skip).not.toBeNull();
    expect(skip?.reason).toContain('policy: builtin');
    expect(skip?.reason).not.toContain('policy: config');

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

  /** A partial stamp, with either field absent, returns null, so the gate runs. A config that excludes the gate does not change this. */
  it('ResolvePolicySkip_PartialStamp_StillRunsUnconditionally', () => {
    const config = configWith({ medium: [] });

    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', boundaryTouching: false }),
    ).toBeNull();
    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', riskTier: 'medium' }),
    ).toBeNull();
    expect(resolvePolicySkip({ gateName: 'check_test_adequacy' })).toBeNull();

    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', riskTier: 'medium', config }),
    ).toBeNull();
    expect(
      resolvePolicySkip({ gateName: 'check_test_adequacy', boundaryTouching: false, config }),
    ).toBeNull();
  });

  it('ResolvePolicySkip_BothStampsAbsent_ReasonAbsentByteIdenticalToNull', () => {
    for (const gate of VERIFICATION_GATE_NAMES) {
      expect(resolvePolicySkip({ gateName: gate })).toBeNull();
    }
  });
});

describe('StampAndSkip consistency', () => {
  /**
   * For each tier, boundary, and config variant, `classifyTask` stamps a sequence.
   * `resolvePolicySkip` skips a gate exactly when the gate is not in that sequence.
   * The variants are no config, a custom cell, and an empty cell for the same tier and boundary.
   */
  it('StampAndSkip_SameConfig_NeverDisagree', () => {
    type Variant = { readonly label: string; readonly config: ReturnType<typeof configWith> | undefined };

    for (const tier of ALL_TIERS) {
      for (const boundary of ALL_BOUNDARY) {
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

          expect(classification.riskTier).toBe(tier);
          expect(classification.boundaryTouching).toBe(boundary);

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
            expect(skip === null, message).toBe(inSequence);
          }
        }
      }
    }
  });

  /** With no config, the stamped sequence equals the builtin table, and each skip decision agrees with it. */
  it('StampAndSkip_NoConfig_MatchesBuiltinTable', () => {
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

describe('resolvePhaseMode', () => {
  /** PLAN, REVIEW, and SYNTHESIZE gates block, so they bind to enforce. They stay enforce even under oneshot, where IMPLEMENT is audit. */
  it('migratedGates_PlanReviewSynthesis_BindEnforceNotAudit', () => {
    for (const kind of ['PLAN', 'REVIEW', 'SYNTHESIZE'] as const) {
      expect(resolvePhaseMode(kind, 'oneshot')).toBe('enforce');
      expect(resolvePhaseMode(kind, 'feature')).toBe('enforce');
    }
  });

  it('implementKind_StillGraduatesPerWorkflowType', () => {
    expect(resolvePhaseMode('IMPLEMENT', 'oneshot')).toBe('audit');
    expect(resolvePhaseMode('IMPLEMENT', 'feature')).toBe('enforce');
    expect(resolvePhaseMode('IMPLEMENT', 'debug')).toBe('enforce');
  });

  /** GATHER has no gates. The default is enforce, so an unexpected kind cannot downgrade a gate. */
  it('gatherKind_NoGates_DefaultsEnforce', () => {
    expect(resolvePhaseMode('GATHER', 'feature')).toBe('enforce');
  });
});

/**
 * `repoWithDiffOfAtLeast` builds a throwaway repo whose `main...HEAD` diff exceeds `approxBytes`.
 * The new file holds only added lines, so each of its bytes is in the unified diff body.
 */
describe('getDiff', () => {
  async function repoWithDiffOfAtLeast(approxBytes: number): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-utils-diff-'));
    const git = async (...args: string[]): Promise<void> => {
      await execFileAsync('git', args, { cwd: root });
    };
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
    await git('add', '.');
    await git('commit', '-m', 'seed');

    await git('checkout', '-b', 'feature');
    const line = `${'x'.repeat(99)}\n`;
    fs.writeFileSync(path.join(root, 'big.txt'), line.repeat(Math.ceil(approxBytes / line.length)));
    await git('add', '.');
    await git('commit', '-m', 'big');
    return root;
  }

  /**
   * The default `maxBuffer` of `execFileSync` is 1 MiB, and a larger output raises `ENOBUFS`.
   * A null diff makes the three callers report `DIFF_ERROR`.
   * Two MiB is above the Node default and far below the `getDiff` ceiling.
   */
  it('getDiff_DiffLargerThanNodeDefaultMaxBuffer_ReturnsTheDiff', async () => {
    const root = await repoWithDiffOfAtLeast(2 * 1024 * 1024);
    try {
      const diff = getDiff(root, 'main');
      expect(diff).not.toBeNull();
      expect(diff!.length).toBeGreaterThan(1024 * 1024);
      expect(diff).toContain('big.txt');
    } finally {
      rmrf(root);
    }
  });

  /** The negative control: a `getDiff` that never returns null fails this test. */
  it('getDiff_UnresolvableBaseRef_ReturnsNull', async () => {
    const root = await repoWithDiffOfAtLeast(1024);
    try {
      expect(getDiff(root, 'no-such-base-ref')).toBeNull();
    } finally {
      rmrf(root);
    }
  });
});
