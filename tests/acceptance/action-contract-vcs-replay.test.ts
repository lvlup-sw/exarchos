import { fc } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { isBuiltInEventType } from '../../src/events/schemas.js';
import {
  normalizeActionContract,
  type ActionContract,
} from '../../src/registry/action-contract.js';
import { mergeActions } from '../../src/registry/actions/orchestrate/merge.js';
import { vcsActions } from '../../src/registry/actions/orchestrate/vcs.js';
import { worktreeActions } from '../../src/registry/actions/orchestrate/worktree.js';
import { TOOL_REGISTRY, type ToolAction } from '../../src/registry.js';

const FAMILY_ACTIONS: readonly ToolAction[] = [...mergeActions, ...vcsActions, ...worktreeActions];
const FAMILY_NAMES = new Set(FAMILY_ACTIONS.map((action) => action.name));

function readContract(action: ToolAction): ActionContract {
  if (!('actionContract' in action) || action.actionContract === undefined) {
    throw new Error(`${action.name} is missing actionContract`);
  }
  return action.actionContract;
}

function assertCompleteContract(action: ToolAction): ActionContract {
  const normalized = normalizeActionContract(readContract(action), {
    annotations: { idempotent: action.annotations.idempotent },
  });
  for (const dimension of [normalized.requires, normalized.ensures, normalized.needs, normalized.emissions] as const) {
    if (dimension.kind === 'none') {
      expect(dimension.because.trim().length).toBeGreaterThan(0);
    } else {
      expect(dimension.values.length).toBeGreaterThan(0);
    }
  }
  expect(normalized.touches.frame).toBe('single-machine');
  if (normalized.touches.resources.kind === 'none') {
    expect(normalized.touches.resources.because.trim().length).toBeGreaterThan(0);
  } else {
    expect(normalized.touches.resources.values.length).toBeGreaterThan(0);
  }
  expect(normalized.executionAuthority.kind === 'local' || normalized.executionAuthority.kind === 'host').toBe(true);
  if (normalized.executionAuthority.kind === 'local') {
    expect(normalized.executionAuthority).toEqual({ kind: 'local' });
  } else {
    expect(normalized.executionAuthority.obligation).toMatch(
      /^(agent-spawn|human-approval|interactive-authentication|host-ui)$/,
    );
  }
  expect(['safe-repeat', 'claim-required', 'reject-replay']).toContain(normalized.replay.kind);
  if (normalized.emissions.kind === 'declared') {
    for (const emission of normalized.emissions.values) {
      expect(emission.owner.trim().length).toBeGreaterThan(0);
      expect(emission.role === 'primary' || emission.role === 'recovery').toBe(true);
      expect(isBuiltInEventType(emission.event)).toBe(true);
    }
  }
  return normalized;
}

function liveFamilyActions(): readonly ToolAction[] {
  const orchestrate = TOOL_REGISTRY.find((tool) => tool.name === 'exarchos_orchestrate');
  if (orchestrate === undefined) throw new Error('exarchos_orchestrate is missing from TOOL_REGISTRY');
  return orchestrate.actions.filter((action) => FAMILY_NAMES.has(action.name));
}

function nonIdempotentMutations(actions: readonly ToolAction[]): readonly ToolAction[] {
  return actions.filter((action) => action.annotations.readOnly === false && action.annotations.idempotent === false);
}

describe('merge VCS worktree action contracts', () => {
  it('Registry_MergeVcsWorktreeActions_HaveCompleteContracts', () => {
    expect(FAMILY_ACTIONS.map((action) => action.name)).toEqual([
      'merge_orchestrate',
      'create_pr',
      'merge_pr',
      'check_ci',
      'list_prs',
      'get_pr_comments',
      'add_pr_comment',
      'create_issue',
      'acquire_worktree',
      'release_worktree',
      'prune_worktrees',
      'reconcile_worktrees',
      'serialize_merge',
    ]);
    const live = liveFamilyActions();
    expect(live.map((action) => action.name)).toEqual(FAMILY_ACTIONS.map((action) => action.name));
    for (const action of live) {
      const contract = assertCompleteContract(action);
      expect(readContract(action)).toEqual(contract);
    }
  });

  it('Registry_NonIdempotentMutations_RequireClaimsOrRejectReplay', () => {
    const mutations = nonIdempotentMutations(liveFamilyActions());
    expect(mutations.map((action) => action.name).sort()).toEqual([
      'add_pr_comment',
      'create_issue',
      'create_pr',
      'merge_orchestrate',
      'merge_pr',
      'serialize_merge',
    ]);
    for (const action of mutations) {
      const replay = assertCompleteContract(action).replay;
      expect(replay.kind === 'claim-required' || replay.kind === 'reject-replay').toBe(true);
      if (replay.kind === 'claim-required') {
        expect(replay.scope).toBe('stream-subject-request');
      }
    }
    const mergeReplay = assertCompleteContract(
      mutations.find((action) => action.name === 'merge_orchestrate')!,
    ).replay;
    expect(mergeReplay.kind).toBe('claim-required');
    expect(mergeReplay).toEqual({ kind: 'claim-required', scope: 'stream-subject-request' });
  });

  it('non-idempotent mutations declare claim-required or reject-replay', () => {
    const mutations = nonIdempotentMutations(liveFamilyActions());
    expect(mutations.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.constantFrom(...mutations), (action) => {
        const replay = readContract(action).replay;
        expect(replay.kind === 'claim-required' || replay.kind === 'reject-replay').toBe(true);
      }),
    );
  });
});
