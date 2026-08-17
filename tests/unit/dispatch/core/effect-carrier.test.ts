import { describe, it, expect, vi } from 'vitest';
import {
  runEffect,
  succeeded,
  failed,
  plannedDryRun,
  emissionsWhen,
  isSuccess,
  isError,
  isDryRun,
  toEffectError,
  LIVE,
  DRY_RUN,
  type EffectPlan,
  type EffectEmission,
  type EmissionAppender,
} from '../../../../src/dispatch/core/effect-carrier.js';
import { EventTypes } from '../../../../src/events/schemas.js';

const PLAN: EffectPlan = {
  effectClass: 'filesystem',
  owner: 'test-owner',
  description: 'write a marker file',
  idempotent: true,
  compensation: 'delete the marker file',
};

/**
 * The mutation owner's shape: an intent before the effect and one of two
 * mutually-exclusive terminals after it.
 */
const LEDGER_PLAN: EffectPlan = {
  effectClass: 'vcs',
  owner: 'vcs-mutation-owner',
  description: 'create a worktree',
  idempotent: true,
  compensation: 'remove the worktree and delete the branch',
  emits: [
    { event: 'vcs.requested', when: 'before' },
    { event: 'vcs.executed', when: 'on-success' },
    { event: 'vcs.compensated', when: 'on-failure' },
  ],
};

/** The tree-promotion shape: one terminal, no intent — a different subset. */
const PROMOTION_PLAN: EffectPlan = {
  effectClass: 'install',
  owner: 'install/atomic-promotion',
  description: 'atomically promote a staged tree',
  idempotent: true,
  emits: [{ event: 'promotion.executed', when: 'on-success' }],
};

const names = (emissions: readonly EffectEmission[]): readonly string[] =>
  emissions.map((emission) => emission.event);

describe('effect carrier constructors + guards', () => {
  it('succeeded builds a success arm that only isSuccess narrows', () => {
    const outcome = succeeded(42);
    expect(isSuccess(outcome)).toBe(true);
    expect(isError(outcome)).toBe(false);
    expect(isDryRun(outcome)).toBe(false);
    if (isSuccess(outcome)) expect(outcome.value).toBe(42);
  });

  it('failed builds an error arm carrying the structured error', () => {
    const outcome = failed<number>({ code: 'X', message: 'boom' });
    expect(isError(outcome)).toBe(true);
    if (isError(outcome)) expect(outcome.error.code).toBe('X');
  });

  it('plannedDryRun builds a dry-run arm carrying the plan', () => {
    const outcome = plannedDryRun<number>(PLAN);
    expect(isDryRun(outcome)).toBe(true);
    if (isDryRun(outcome)) expect(outcome.plan.owner).toBe('test-owner');
  });
});

describe('runEffect — live mode', () => {
  it('invokes execute and wraps the value in a success carrier', async () => {
    const execute = vi.fn().mockResolvedValue('done');
    const outcome = await runEffect(LIVE, PLAN, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('success');
    if (isSuccess(outcome)) expect(outcome.value).toBe('done');
  });

  it('captures a thrown error into an error carrier instead of rejecting', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('disk full'));
    const outcome = await runEffect(LIVE, PLAN, execute);
    expect(outcome.kind).toBe('error');
    if (isError(outcome)) {
      expect(outcome.error.message).toBe('disk full');
      expect(outcome.error.code).toBe('FILESYSTEM_EFFECT_FAILED');
    }
  });
});

describe('runEffect — dry-run mode (provably no real effect)', () => {
  it('does NOT invoke execute and returns the withheld plan', async () => {
    const execute = vi.fn().mockResolvedValue('SHOULD NOT RUN');
    const outcome = await runEffect(DRY_RUN, PLAN, execute);

    // The load-bearing guarantee: the effect thunk is never reached in dry-run.
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('dry-run');
    if (isDryRun(outcome)) {
      expect(outcome.plan).toEqual(PLAN);
    }
  });

  it('withholds even an effect that would throw — no throw escapes', async () => {
    const execute = vi.fn().mockImplementation(() => {
      throw new Error('this effect must never run in dry-run');
    });
    const outcome = await runEffect(DRY_RUN, PLAN, execute);
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('dry-run');
  });
});

describe('EffectPlan emissions', () => {
  it('EffectPlan_Emits_IsAConditionedSet', () => {
    // Conditioned, not a single event: reading the SAME plan through three
    // different conditions yields three different names. A single `emits`
    // string could not answer these three questions apart.
    expect(names(emissionsWhen(LEDGER_PLAN, 'before'))).toEqual(['vcs.requested']);
    expect(names(emissionsWhen(LEDGER_PLAN, 'on-success'))).toEqual(['vcs.executed']);
    expect(names(emissionsWhen(LEDGER_PLAN, 'on-failure'))).toEqual(['vcs.compensated']);

    // The conditions partition the set — no name is reachable through two of
    // them, so "the intent landed" and "a terminal landed" stay distinguishable.
    const perCondition = (['before', 'on-success', 'on-failure'] as const).flatMap((when) =>
      names(emissionsWhen(LEDGER_PLAN, when)),
    );
    expect(new Set(perCondition).size).toBe(perCondition.length);
    expect(perCondition).toHaveLength(LEDGER_PLAN.emits?.length ?? 0);

    // Not a fixed intent+two-terminals triple either: a plan may condition a
    // single terminal and nothing else, and the empty conditions read empty
    // rather than falling back to some other axis.
    expect(names(emissionsWhen(PROMOTION_PLAN, 'on-success'))).toEqual(['promotion.executed']);
    expect(emissionsWhen(PROMOTION_PLAN, 'before')).toEqual([]);
    expect(emissionsWhen(PROMOTION_PLAN, 'on-failure')).toEqual([]);

    // A plan may promise no record at all; nothing is inferred from
    // `effectClass` or `owner`.
    expect(emissionsWhen(PLAN, 'before')).toEqual([]);
    expect(emissionsWhen(PLAN, 'on-success')).toEqual([]);
  });

  it('resolves every declared name against the registered event catalog', () => {
    const registered = new Set<string>(EventTypes);
    for (const plan of [LEDGER_PLAN, PROMOTION_PLAN]) {
      for (const emission of plan.emits ?? []) {
        expect(registered.has(emission.event)).toBe(true);
      }
    }
  });
});

describe('runEffect — declared emissions', () => {
  it('EffectPlan_DryRunArm_ReachesNeitherThunkNorAppender', async () => {
    const execute = vi.fn().mockResolvedValue('SHOULD NOT RUN');
    const appended: EffectEmission[] = [];
    const append: EmissionAppender = (emission) => {
      appended.push(emission);
    };

    const outcome = await runEffect(DRY_RUN, LEDGER_PLAN, execute, append);

    expect(execute).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
    expect(outcome.kind).toBe('dry-run');
    // The withheld plan still reports what it WOULD have recorded.
    if (isDryRun(outcome)) expect(outcome.plan.emits).toEqual(LEDGER_PLAN.emits);

    // Control: the same plan and the same appender in live mode reach BOTH, so
    // the assertions above measure the dry-run arm rather than an inert port.
    const liveExecute = vi.fn().mockResolvedValue('ran');
    const liveAppended: EffectEmission[] = [];
    const liveAppend: EmissionAppender = (emission) => {
      liveAppended.push(emission);
    };
    await runEffect(LIVE, LEDGER_PLAN, liveExecute, liveAppend);
    expect(liveExecute).toHaveBeenCalledTimes(1);
    expect(names(liveAppended)).toEqual(['vcs.requested', 'vcs.executed']);
  });

  it('appends the intent before the thunk and exactly one terminal after it', async () => {
    const trace: string[] = [];
    const append: EmissionAppender = (emission) => {
      trace.push(emission.event);
    };

    const success = await runEffect(
      LIVE,
      LEDGER_PLAN,
      () => {
        trace.push('<effect>');
        return Promise.resolve('ok');
      },
      append,
    );
    expect(success.kind).toBe('success');
    expect(trace).toEqual(['vcs.requested', '<effect>', 'vcs.executed']);

    trace.length = 0;
    const failure = await runEffect(
      LIVE,
      LEDGER_PLAN,
      () => {
        trace.push('<effect>');
        return Promise.reject(new Error('worktree exists'));
      },
      append,
    );
    expect(failure.kind).toBe('error');
    expect(trace).toEqual(['vcs.requested', '<effect>', 'vcs.compensated']);
  });

  it('appends nothing when the plan declares nothing', async () => {
    const append = vi.fn();
    const outcome = await runEffect(LIVE, PLAN, () => Promise.resolve(1), append);
    expect(isSuccess(outcome)).toBe(true);
    expect(append).not.toHaveBeenCalled();
  });
});

describe('toEffectError', () => {
  it('derives a class-scoped code and preserves the cause', () => {
    const cause = new Error('nope');
    const err = toEffectError({ ...PLAN, effectClass: 'network' }, cause);
    expect(err.code).toBe('NETWORK_EFFECT_FAILED');
    expect(err.message).toBe('nope');
    expect(err.cause).toBe(cause);
  });
});
