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
} from './verb.js';
import { TIER1_HARNESSES } from './harness-registry.js';
import { deriveWorktreePath } from './topology.js';

// A POSIX base whose parent is deterministic, so derived sibling paths are
// stable across hosts for the pure-derivation assertions.
const POSIX_BASE = '/repo/base-worktree';

describe('exarchos <harness> launcher verb (DR-1)', () => {
  it('Verb_Schema_ConstrainsEnum', () => {
    // Rejects a non-enum harness at the schema level...
    expect(LauncherVerbSchema.safeParse({ harness: 'not-a-harness' }).success).toBe(false);
    expect(LauncherVerbSchema.safeParse({ harness: 'generic' }).success).toBe(false);
    expect(LauncherVerbSchema.safeParse({ harness: '' }).success).toBe(false);

    // ...and accepts each of the five Tier-1 harnesses.
    for (const harness of TIER1_HARNESSES) {
      const parsed = LauncherVerbSchema.safeParse({ harness });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.harness).toBe(harness);
        // dryRun defaults to false when omitted.
        expect(parsed.data.dryRun).toBe(false);
      }
    }
  });

  it('Verb_DryRun_ShowsPathAndPlanNoSpawn', async () => {
    // Real temp dir as the base so "no worktree created" is a genuine
    // filesystem assertion, not a tautology over a non-existent path.
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

      // Shows the derived path...
      expect(plan.worktreePath).toBe(deriveWorktreePath(base, plan.worktreeId));
      // ...and the full ordered event plan.
      expect(plan.eventPlan).toEqual(LAUNCH_EVENT_PLAN);

      const rendered = renderDryRunPlan(plan);
      expect(rendered).toContain(plan.worktreePath);
      for (const event of LAUNCH_EVENT_PLAN) {
        expect(rendered).toContain(event);
      }

      // NO spawn: the lifecycle runner is never invoked on the dry-run path.
      expect(lifecycle).not.toHaveBeenCalled();
      // NO worktree creation: the derived sibling path does not exist on disk.
      expect(fs.existsSync(plan.worktreePath)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('Verb_DryRun_NoEnforcementClaimInOutput', async () => {
    const result = await runLauncherVerb(
      { harness: 'codex', feature: 'demo-feature', dryRun: true },
      { base: POSIX_BASE },
    );
    expect(result.success).toBe(true);
    const plan = result.data as DryRunPlan;
    const rendered = renderDryRunPlan(plan).toLowerCase();

    // Filesystem-write confinement / space enforcement is an explicit non-goal
    // of this launcher — no such claim may leak into the dry-run output.
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

  it('Verb_DryRun_DerivesPathViaSameGuardAsCreation', async () => {
    // With a feature (drives the worktree-id derivation).
    const withFeature = await runLauncherVerb(
      { harness: 'cursor', feature: 'my-feat', dryRun: true },
      { base: POSIX_BASE },
    );
    expect(withFeature.success).toBe(true);
    const planA = withFeature.data as DryRunPlan;
    // The dry-run path is EXACTLY what the shared creation guard produces for
    // the same base + id — proving reuse, not a re-implementation.
    expect(planA.worktreePath).toBe(deriveWorktreePath(planA.base, planA.worktreeId));
    expect(planA.worktreeId).toBe(deriveLaunchWorktreeId('cursor', 'my-feat'));

    // And without a feature.
    const noFeature = await runLauncherVerb(
      { harness: 'opencode', dryRun: true },
      { base: POSIX_BASE },
    );
    expect(noFeature.success).toBe(true);
    const planB = noFeature.data as DryRunPlan;
    expect(planB.worktreePath).toBe(deriveWorktreePath(planB.base, planB.worktreeId));
    expect(planB.worktreePath).toBe('/repo/exarchos-opencode');
  });

  it('launcherVerb_DryRun_PrintsResolvedChannelAndPayload', async () => {
    // Deterministic payload injected so the preview is hermetic (no reliance on
    // the repo `binding/standard/block.md` being on disk under the test cwd).
    const payload = 'ORIENT-BLOCK-CONTENT: route workflow ops through Exarchos.';

    const result = await runLauncherVerb(
      { harness: 'claude-code', dryRun: true },
      { base: POSIX_BASE, orientationContent: payload },
    );

    expect(result.success).toBe(true);
    const plan = result.data as DryRunPlan;

    // The resolved channel is the PROBE-FREE preview: claude's primary candidate.
    expect(plan.injection.channel).toBe('flag:--append-system-prompt-file');
    expect(plan.injection.payload).toBe(payload);

    const rendered = renderDryRunPlan(plan);
    // The render prints BOTH the resolved channel and the payload.
    expect(rendered).toContain('orientation channel: flag:--append-system-prompt-file');
    expect(rendered).toContain(payload);

    // Cursor has NO native channel — the preview reports `none`.
    const cursor = await runLauncherVerb(
      { harness: 'cursor', dryRun: true },
      { base: POSIX_BASE, orientationContent: payload },
    );
    const cursorPlan = cursor.data as DryRunPlan;
    expect(cursorPlan.injection.channel).toBe('none');
    expect(renderDryRunPlan(cursorPlan)).toContain('orientation channel: none');
  });

  it('launcherVerb_DryRun_PayloadUnavailable_RendersGracefully', async () => {
    const result = await runLauncherVerb(
      { harness: 'opencode', dryRun: true },
      { base: POSIX_BASE, orientationContent: '' },
    );
    const plan = result.data as DryRunPlan;
    // Empty string is treated as unavailable → null payload, graceful render.
    expect(plan.injection.payload).toBeNull();
    expect(plan.injection.channel).toBe('env:OPENCODE_CONFIG_CONTENT');
    expect(renderDryRunPlan(plan)).toContain('orientation payload: (unavailable');
  });

  it('Verb_Unknown_ReturnsValidTargets', async () => {
    const result = await runLauncherVerb({ harness: 'jetbrains', dryRun: true });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    // The structured error carries the five enum members as validTargets.
    expect(result.error?.validTargets).toEqual(TIER1_HARNESSES);
    expect(result.error?.validTargets).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'copilot',
      'opencode',
    ]);
  });

  // ─── Seam contract (non-dry-run) ──────────────────────────────────────────

  it('Verb_NonDryRun_UnwiredReturnsNotWired', async () => {
    // No explicit `lifecycle` AND no `lifecycleDeps` → the verb has no event-store
    // substrate to supervise a launch, so it returns a structured NOT_WIRED
    // rather than throwing or spawning against a bare base path.
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
