import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  LauncherVerbSchema,
  LAUNCH_EVENT_PLAN,
  runLauncherVerb,
  renderDryRunPlan,
  deriveLaunchWorktreeId,
  isDryRunPlan,
  type DryRunPlan,
  type LifecycleRunner,
} from '../../../../src/runtime/launcher/verb.js';
import { TIER1_HARNESSES } from '../../../../src/runtime/launcher/harness-registry.js';
import { deriveWorktreePath } from '../../../../src/runtime/launcher/topology.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/** A POSIX base path, so the derived sibling paths are the same on each host. */
const POSIX_BASE = '/repo/base-worktree';

describe('exarchos <harness> launcher verb (DR-1)', () => {
  /** The schema refuses a value outside the enum, accepts each Tier-1 harness, and defaults `dryRun` to false. */
  it('Verb_Schema_ConstrainsEnum', () => {
    expect(LauncherVerbSchema.safeParse({ harness: 'not-a-harness' }).success).toBe(false);
    expect(LauncherVerbSchema.safeParse({ harness: 'generic' }).success).toBe(false);
    expect(LauncherVerbSchema.safeParse({ harness: '' }).success).toBe(false);

    for (const harness of TIER1_HARNESSES) {
      const parsed = LauncherVerbSchema.safeParse({ harness });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.harness).toBe(harness);
        expect(parsed.data.dryRun).toBe(false);
      }
    }
  });

  /**
   * The base is a real temp directory, so the derived sibling path has a real parent directory.
   * The dry run must not call the lifecycle runner and must not create that sibling path.
   */
  it('Verb_DryRun_ShowsPathAndPlanNoSpawn', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-dryrun-'));
    try {
      const lifecycle = vi.fn<LifecycleRunner>();

      const result = await runLauncherVerb(
        { harness: 'claude-code', dryRun: true },
        { base, lifecycle },
      );

      expect(result.success).toBe(true);
      expect(isDryRunPlan(result.data)).toBe(true);
      const plan = result.data as DryRunPlan;

      expect(plan.worktreePath).toBe(deriveWorktreePath(base, plan.worktreeId));
      expect(plan.eventPlan).toEqual(LAUNCH_EVENT_PLAN);

      const rendered = renderDryRunPlan(plan);
      expect(rendered).toContain(plan.worktreePath);
      for (const event of LAUNCH_EVENT_PLAN) {
        expect(rendered).toContain(event);
      }

      expect(lifecycle).not.toHaveBeenCalled();
      expect(fs.existsSync(plan.worktreePath)).toBe(false);
    } finally {
      rmrf(base);
    }
  });

  /** Write confinement is not a goal of the launcher, so the dry-run output must not claim it. */
  it('Verb_DryRun_NoEnforcementClaimInOutput', async () => {
    const result = await runLauncherVerb(
      { harness: 'codex', feature: 'demo-feature', dryRun: true },
      { base: POSIX_BASE },
    );
    expect(result.success).toBe(true);
    const plan = result.data as DryRunPlan;
    const rendered = renderDryRunPlan(plan).toLowerCase();

    for (const forbidden of [
      'space',
      'enforce',
      'enforcement',
      'confine',
      'confinement',
      'sandbox',
      'boundary',
      'tier',
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  /**
   * With and without a feature, the dry-run path equals the result of `deriveWorktreePath` for the same
   * base and id. The dry run does not run the containment guard.
   */
  it('Verb_DryRun_DerivesPathViaSameGuardAsCreation', async () => {
    const withFeature = await runLauncherVerb(
      { harness: 'cursor', feature: 'my-feat', dryRun: true },
      { base: POSIX_BASE },
    );
    expect(withFeature.success).toBe(true);
    const planA = withFeature.data as DryRunPlan;
    expect(planA.worktreePath).toBe(deriveWorktreePath(planA.base, planA.worktreeId));
    expect(planA.worktreeId).toBe(deriveLaunchWorktreeId('cursor', 'my-feat'));

    const noFeature = await runLauncherVerb(
      { harness: 'opencode', dryRun: true },
      { base: POSIX_BASE },
    );
    expect(noFeature.success).toBe(true);
    const planB = noFeature.data as DryRunPlan;
    expect(planB.worktreePath).toBe(deriveWorktreePath(planB.base, planB.worktreeId));
    expect(planB.worktreePath).toBe('/repo/exarchos-opencode');
  });

  /**
   * The test injects the payload, so the verb does not read `binding/standard/block.md`.
   * The previewed channel is the first declared candidate of the harness, with no help probe.
   * Cursor declares no native channel, so its preview reports `none`.
   */
  it('launcherVerb_DryRun_PrintsResolvedChannelAndPayload', async () => {
    const payload = 'ORIENT-BLOCK-CONTENT: route workflow ops through Exarchos.';

    const result = await runLauncherVerb(
      { harness: 'claude-code', dryRun: true },
      { base: POSIX_BASE, orientationContent: payload },
    );

    expect(result.success).toBe(true);
    const plan = result.data as DryRunPlan;

    expect(plan.injection.channel).toBe('flag:--append-system-prompt-file');
    expect(plan.injection.payload).toBe(payload);

    const rendered = renderDryRunPlan(plan);
    expect(rendered).toContain('orientation channel: flag:--append-system-prompt-file');
    expect(rendered).toContain(payload);

    const cursor = await runLauncherVerb(
      { harness: 'cursor', dryRun: true },
      { base: POSIX_BASE, orientationContent: payload },
    );
    const cursorPlan = cursor.data as DryRunPlan;
    expect(cursorPlan.injection.channel).toBe('none');
    expect(renderDryRunPlan(cursorPlan)).toContain('orientation channel: none');
  });

  /** An empty payload string counts as unavailable, so the plan holds a `null` payload. */
  it('launcherVerb_DryRun_PayloadUnavailable_RendersGracefully', async () => {
    const result = await runLauncherVerb(
      { harness: 'opencode', dryRun: true },
      { base: POSIX_BASE, orientationContent: '' },
    );
    const plan = result.data as DryRunPlan;
    expect(plan.injection.payload).toBeNull();
    expect(plan.injection.channel).toBe('env:OPENCODE_CONFIG_CONTENT');
    expect(renderDryRunPlan(plan)).toContain('orientation payload: (unavailable');
  });

  it('Verb_Unknown_ReturnsValidTargets', async () => {
    const result = await runLauncherVerb({ harness: 'jetbrains', dryRun: true });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.validTargets).toEqual(TIER1_HARNESSES);
    expect(result.error?.validTargets).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'copilot',
      'opencode',
    ]);
  });

  /** With no `lifecycle` and no `lifecycleDeps`, the verb has no event store, so it returns `NOT_WIRED` and does not throw. */
  it('Verb_NonDryRun_UnwiredReturnsNotWired', async () => {
    const result = await runLauncherVerb(
      { harness: 'claude-code', dryRun: false },
      { base: POSIX_BASE },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_WIRED');
    expect(result.error?.message).toContain('lifecycle substrate');
  });

  it('Verb_NonDryRun_DelegatesToInjectedLifecycle', async () => {
    const lifecycle = vi.fn<LifecycleRunner>(async (launch) => ({
      success: true,
      data: { spawned: launch.harness, worktreePath: launch.worktreePath },
    }));

    const result = await runLauncherVerb(
      { harness: 'copilot', feature: 'x', dryRun: false },
      { base: POSIX_BASE, lifecycle },
    );

    expect(lifecycle).toHaveBeenCalledTimes(1);
    const launchArg = lifecycle.mock.calls[0][0];
    expect(launchArg.harness).toBe('copilot');
    expect(launchArg.runtimeId).toBe('copilot');
    expect(launchArg.feature).toBe('x');
    expect(launchArg.worktreePath).toBe(deriveWorktreePath(POSIX_BASE, launchArg.worktreeId));
    expect(result.success).toBe(true);
  });
});
