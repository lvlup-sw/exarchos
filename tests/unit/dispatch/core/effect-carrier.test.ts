import { describe, it, expect, vi } from 'vitest';
import {
  runEffect,
  succeeded,
  failed,
  plannedDryRun,
  isSuccess,
  isError,
  isDryRun,
  toEffectError,
  LIVE,
  DRY_RUN,
  type EffectPlan,
} from '../../../../src/dispatch/core/effect-carrier.js';

const PLAN: EffectPlan = {
  effectClass: 'filesystem',
  owner: 'test-owner',
  description: 'write a marker file',
  idempotent: true,
  compensation: 'delete the marker file',
};

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

describe('toEffectError', () => {
  it('derives a class-scoped code and preserves the cause', () => {
    const cause = new Error('nope');
    const err = toEffectError({ ...PLAN, effectClass: 'network' }, cause);
    expect(err.code).toBe('NETWORK_EFFECT_FAILED');
    expect(err.message).toBe('nope');
    expect(err.cause).toBe(cause);
  });
});
