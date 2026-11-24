import { describe, expect, it } from 'vitest';
import { isBuiltInEventType } from '../../src/events/schemas.js';
import {
  normalizeActionContract,
  type ActionContract,
} from '../../src/registry/action-contract.js';
import { worktreeActions } from '../../src/registry/actions/orchestrate/worktree.js';
import { TOOL_REGISTRY, type ToolAction } from '../../src/registry.js';

const FAMILY_ACTIONS: readonly ToolAction[] = [...worktreeActions];
const FAMILY_NAMES = new Set(FAMILY_ACTIONS.map((action) => action.name));

function readContract(action: ToolAction): ActionContract {
  if (!('actionContract' in action)) {
    throw new Error(`${action.name} is missing actionContract`);
  }
  return normalizeActionContract(Reflect.get(action, 'actionContract'), {
    annotations: { idempotent: action.annotations.idempotent },
  });
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
      'acquire_worktree',
      'release_worktree',
      'reconcile_worktrees',
    ]);
    const ledgerCoordination = ['acquire_worktree', 'release_worktree', 'reconcile_worktrees'];
    expect([...ledgerCoordination].sort()).toEqual([...FAMILY_NAMES].sort());
    const live = liveFamilyActions();
    expect(live.map((action) => action.name)).toEqual(FAMILY_ACTIONS.map((action) => action.name));
    for (const action of live) {
      const contract = assertCompleteContract(action);
      expect(readContract(action)).toEqual(contract);
    }
  });

  /**
   * The local merge actions were the only non-idempotent mutations of the family, and they are retired.
   * The ledger actions converge, so none of them needs a claim or a replay refusal.
   */
  it('Registry_NonIdempotentMutations_RequireClaimsOrRejectReplay', () => {
    const live = liveFamilyActions();
    expect(live.length).toBe(FAMILY_ACTIONS.length);
    expect(nonIdempotentMutations(live).map((action) => action.name)).toEqual([]);
    for (const action of live) {
      expect(action.annotations.idempotent, action.name).toBe(true);
      expect(assertCompleteContract(action).replay.kind, action.name).toBe('safe-repeat');
    }
  });
});
