// ─── worktree-provisioner: outcome mapping (P04-05) ──────────────────────────
//
// Unit coverage for the pure carrier→provision-outcome mapping the setup-worktree
// handler depends on. The owner-backed provisioner's live git/EventStore path is
// exercised end-to-end in `verbs/team/setup-worktree.integration.test.ts`; here
// we pin the three-way discrimination (success / error / dry-run) that decides
// whether the report reads "created", "already exists", or "failed".

import { describe, it, expect } from 'vitest';
import {
  failed,
  plannedDryRun,
  succeeded,
  replayedEvidence,
  records,
  type EffectPlan,
} from '../../../src/dispatch/core/effect-carrier.js';
import type { WorktreeCreateResult } from '../../../src/vcs/mutation-owner.js';
import { mapWorktreeOutcome } from '../../../src/vcs/worktree-provisioner.js';

const plan: EffectPlan = {
  effectClass: 'vcs',
  owner: 'vcs-mutation-owner',
  description: 'create worktree',
  idempotent: true,
  emits: records({ event: 'vcs.executed', when: 'on-success' }),
};

describe('mapWorktreeOutcome', () => {
  it('maps a fresh-create success to ok with both created flags true', () => {
    const outcome = succeeded<WorktreeCreateResult>({
      worktreePath: '/repo/.worktrees/x',
      branch: 'feature/x',
      createdBranch: true,
      createdWorktree: true,
    }, replayedEvidence('vcs.executed', 'test fixture'));
    expect(mapWorktreeOutcome(outcome)).toEqual({
      ok: true,
      branchCreated: true,
      worktreeCreated: true,
    });
  });

  it('maps an idempotent no-op success (already existed) to ok with created flags false', () => {
    const outcome = succeeded<WorktreeCreateResult>({
      worktreePath: '/repo/.worktrees/x',
      branch: 'feature/x',
      createdBranch: false,
      createdWorktree: false,
    }, replayedEvidence('vcs.executed', 'test fixture'));
    expect(mapWorktreeOutcome(outcome)).toEqual({
      ok: true,
      branchCreated: false,
      worktreeCreated: false,
    });
  });

  it('maps an error carrier to not-ok, surfacing the failure message', () => {
    const outcome = failed<WorktreeCreateResult>({
      code: 'VCS_TERMINAL_APPEND_FAILED',
      message: 'terminal append failed',
    });
    const mapped = mapWorktreeOutcome(outcome);
    expect(mapped.ok).toBe(false);
    expect(mapped.branchCreated).toBe(false);
    expect(mapped.worktreeCreated).toBe(false);
    expect(mapped.failureDetail).toBe('terminal append failed');
  });

  it('maps a dry-run carrier to a typed not-ok non-provision (capability degrade)', () => {
    const outcome = plannedDryRun<WorktreeCreateResult>(plan);
    const mapped = mapWorktreeOutcome(outcome);
    expect(mapped.ok).toBe(false);
    expect(mapped.branchCreated).toBe(false);
    expect(mapped.worktreeCreated).toBe(false);
    expect(mapped.failureDetail).toMatch(/dry-run/i);
  });
});
