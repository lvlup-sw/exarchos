import { describe, it, expect, vi } from 'vitest';
import {
  runEffect,
  succeeded,
  failed,
  plannedDryRun,
  emissionsWhen,
  declaredEmissions,
  records,
  recordsNothing,
  emissionRecorder,
  effectIdempotencyKey,
  isSuccess,
  isError,
  isDryRun,
  toEffectError,
  UnrecordedEmissionError,
  LIVE,
  DRY_RUN,
  type EffectPlan,
  type EffectEmission,
  type EmissionRecorder,
  type EmissionSink,
} from '../../../../src/dispatch/core/effect-carrier.js';
import { EventTypes } from '../../../../src/events/schemas.js';

const PLAN: EffectPlan = {
  effectClass: 'filesystem',
  owner: 'test-owner',
  description: 'write a marker file',
  idempotent: true,
  compensation: 'delete the marker file',
  // The abstention is DECLARED now. It used to be expressed by saying nothing,
  // which is the same thing an author who never considered it would have written.
  emits: recordsNothing('the marker file is scratch state; nothing durable follows from it'),
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
  emits: records(
    { event: 'vcs.requested', when: 'before' },
    { event: 'vcs.executed', when: 'on-success' },
    { event: 'vcs.compensated', when: 'on-failure' },
  ),
};

/** The tree-promotion shape: one terminal, no intent — a different subset. */
const PROMOTION_PLAN: EffectPlan = {
  effectClass: 'install',
  owner: 'install/atomic-promotion',
  description: 'atomically promote a staged tree',
  idempotent: true,
  emits: records({ event: 'promotion.executed', when: 'on-success' }),
};

/**
 * A genuine capability for runs whose subject is NOT the commit gate.
 *
 * Every live run needs one now, including a plan that records nothing: the
 * demand is unconditional, so tests about unrelated behaviour have to satisfy
 * it before they can reach the behaviour they are about.
 */
const inertRecorder = (): EmissionRecorder => emissionRecorder(() => undefined);

const names = (emissions: readonly EffectEmission[]): readonly string[] =>
  emissions.map((emission) => emission.event);

/**
 * The one deliberate type bypass in this file, isolated to a single helper.
 *
 * It exists to reach the boundary the compile-time proofs cannot: an untyped or
 * transpiled caller can put any shape on the recorder parameter, and the runtime
 * brand check is what catches it there. Everything else in this file goes
 * through the real constructor.
 */
const asRecorder = (forgery: unknown): EmissionRecorder => forgery as EmissionRecorder;

/** Exactly the signature the port used to have, and exactly as inert as before. */
const PORT_SHAPED_NO_OP: EmissionSink = () => undefined;

/**
 * Copy the module-private capability brand off a genuine recorder.
 *
 * No production caller can do this — the symbol is unexported and unnameable —
 * but a test can, and it is the only way to exercise the SECOND gate (evidence)
 * independently of the first (capability). A forgery that clears the brand check
 * still has to produce receipts it cannot mint.
 */
function forgeBrandedRecorder(
  record: (emission: EffectEmission, plan: EffectPlan) => unknown,
): EmissionRecorder {
  const genuine = emissionRecorder(() => undefined);
  const [brand] = Object.getOwnPropertySymbols(genuine);
  expect(brand).toBeDefined();
  return asRecorder({ [brand]: true, record });
}

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
    const outcome = await runEffect(LIVE, PLAN, execute, inertRecorder());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('success');
    if (isSuccess(outcome)) expect(outcome.value).toBe('done');
  });

  it('captures a thrown error into an error carrier instead of rejecting', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('disk full'));
    const outcome = await runEffect(LIVE, PLAN, execute, inertRecorder());
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
    const outcome = await runEffect(DRY_RUN, PLAN, execute, inertRecorder());

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
    const outcome = await runEffect(DRY_RUN, PLAN, execute, inertRecorder());
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
    expect(perCondition).toHaveLength(declaredEmissions(LEDGER_PLAN).length);

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
      for (const emission of declaredEmissions(plan)) {
        expect(registered.has(emission.event)).toBe(true);
      }
    }
  });
});

describe('runEffect — declared emissions', () => {
  it('EffectPlan_DryRunArm_ReachesNeitherThunkNorRecorder', async () => {
    const execute = vi.fn().mockResolvedValue('SHOULD NOT RUN');
    const recorded: EffectEmission[] = [];
    const recorder = emissionRecorder((emission) => {
      recorded.push(emission);
    });

    const outcome = await runEffect(DRY_RUN, LEDGER_PLAN, execute, recorder);

    expect(execute).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    expect(outcome.kind).toBe('dry-run');
    // The withheld plan still reports what it WOULD have recorded.
    if (isDryRun(outcome)) expect(outcome.plan.emits).toEqual(LEDGER_PLAN.emits);

    // Control: the same plan and the same recorder in live mode reach BOTH, so
    // the assertions above measure the dry-run arm rather than an inert port.
    const liveExecute = vi.fn().mockResolvedValue('ran');
    const liveRecorded: EffectEmission[] = [];
    const liveRecorder = emissionRecorder((emission) => {
      liveRecorded.push(emission);
    });
    await runEffect(LIVE, LEDGER_PLAN, liveExecute, liveRecorder);
    expect(liveExecute).toHaveBeenCalledTimes(1);
    expect(names(liveRecorded)).toEqual(['vcs.requested', 'vcs.executed']);
  });

  it('records the intent before the thunk and exactly one terminal after it', async () => {
    const trace: string[] = [];
    const recorder = emissionRecorder((emission) => {
      trace.push(emission.event);
    });

    const success = await runEffect(
      LIVE,
      LEDGER_PLAN,
      () => {
        trace.push('<effect>');
        return Promise.resolve('ok');
      },
      recorder,
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
      recorder,
    );
    expect(failure.kind).toBe('error');
    expect(trace).toEqual(['vcs.requested', '<effect>', 'vcs.compensated']);
  });

  it('records nothing when the plan declares nothing', async () => {
    const sink = vi.fn();
    const outcome = await runEffect(LIVE, PLAN, () => Promise.resolve(1), emissionRecorder(sink));
    expect(isSuccess(outcome)).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('runEffect — the record is on the way to a committed value', () => {
  it('EffectCarrier_NoOpRecorder_CannotYieldACommittedValue', async () => {
    // The population: every way a caller can "supply nothing" and still expect
    // the effect to commit. None of them may reach a `success` arm.
    const noOps: readonly { readonly label: string; readonly recorder?: EmissionRecorder }[] = [
      // 1. The omitted recorder — this is the shape that USED to commit, because
      //    the port defaulted to an inert no-op.
      { label: 'omitted' },
      // 2. The bare lambda the type now rejects, forced past the compiler the way
      //    an untyped caller would.
      { label: 'bare no-op lambda', recorder: asRecorder(() => undefined) },
      // 3. The port's OLD signature, typed as such — records nothing. Getting
      //    the shape right is not getting the capability.
      { label: 'port-shaped no-op', recorder: asRecorder(PORT_SHAPED_NO_OP) },
      // 4. An object literal carrying a `record` method but no brand.
      {
        label: 'unbranded record method',
        recorder: asRecorder({ record: () => Promise.resolve() }),
      },
    ];

    for (const { label, recorder } of noOps) {
      const execute = vi.fn().mockResolvedValue('COMMITTED');
      await expect(
        runEffect(LIVE, LEDGER_PLAN, execute, recorder),
        label,
      ).rejects.toThrow(UnrecordedEmissionError);
      // No committed value, and no effect either: an owner that cannot record
      // must not perform the mutation and then discover it has no ledger.
      expect(execute, label).not.toHaveBeenCalled();
    }
  });

  it('rejects a forged capability whose record mints no evidence', async () => {
    // Clears the brand check (the symbol was copied off a real recorder) but
    // records nothing and returns a plain object instead of a minted receipt.
    // The effect runs — the forgery got that far — but the value is still not
    // committed, because the terminal produced no evidence.
    const execute = vi.fn().mockResolvedValue('COMMITTED');
    const forged = forgeBrandedRecorder((emission) =>
      Promise.resolve({ event: emission.event, when: emission.when }),
    );

    await expect(runEffect(LIVE, LEDGER_PLAN, execute, forged)).rejects.toThrow(
      UnrecordedEmissionError,
    );
  });

  it('commits once a genuine recorder has recorded the declared emissions', async () => {
    // The control that keeps the four rejections above from passing against an
    // implementation that simply never commits anything.
    const recorded: string[] = [];
    const execute = vi.fn().mockResolvedValue('COMMITTED');
    const outcome = await runEffect(
      LIVE,
      LEDGER_PLAN,
      execute,
      emissionRecorder((emission) => {
        recorded.push(emission.event);
      }),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(isSuccess(outcome)).toBe(true);
    if (isSuccess(outcome)) expect(outcome.value).toBe('COMMITTED');
    expect(recorded).toEqual(['vcs.requested', 'vcs.executed']);
  });

  it('RunEffect_RecordsNothingPlanWithNoRecorder_RefusesInLiveMode', async () => {
    // INVERTED, deliberately. This case used to commit: nothing was declared,
    // so nothing was missing, and the carrier waved it through. That was the
    // abstention hole one level down — the plan making the strongest claim
    // ("this effect records nothing") was the only one nobody had to equip to
    // stand behind it. The demand is unconditional now.
    const execute = vi.fn().mockResolvedValue('committed');
    await expect(
      runEffect(LIVE, PLAN, execute, undefined as unknown as EmissionRecorder),
    ).rejects.toThrow(UnrecordedEmissionError);
    // Refused BEFORE the thunk: nothing was mutated on the way to the refusal.
    expect(execute).not.toHaveBeenCalled();
  });

  it('RunEffect_RecordsNothingPlanWithRecorder_CommitsAndRecordsNothing', async () => {
    // The other half: declaring an abstention is legal and stays inert. The
    // capability is required, and then never used.
    const sink = vi.fn();
    const outcome = await runEffect(LIVE, PLAN, () => Promise.resolve('committed'), emissionRecorder(sink));
    expect(isSuccess(outcome)).toBe(true);
    if (isSuccess(outcome)) expect(outcome.value).toBe('committed');
    expect(sink).not.toHaveBeenCalled();
  });

  it('withholds the refusal in dry-run — neither thunk nor capability is reached', async () => {
    // The dry-run guarantee outranks the commit gate: a withheld effect records
    // nothing, so it cannot be missing a record either.
    const execute = vi.fn().mockResolvedValue('SHOULD NOT RUN');
    const outcome = await runEffect(DRY_RUN, LEDGER_PLAN, execute, inertRecorder());
    expect(execute).not.toHaveBeenCalled();
    expect(isDryRun(outcome)).toBe(true);
  });

  it('propagates a sink failure instead of capturing it into the error arm', async () => {
    const execute = vi.fn().mockResolvedValue('COMMITTED');
    const recorder = emissionRecorder(() => {
      throw new Error('ledger unavailable');
    });

    await expect(runEffect(LIVE, LEDGER_PLAN, execute, recorder)).rejects.toThrow(
      'ledger unavailable',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('effectIdempotencyKey', () => {
  it('EffectIdempotency_KeyBuiltWithoutStream_IsRejectedAtConstruction', () => {
    // The falsifier this test exists for: construction-time rejection, not a
    // cross-stream collision. The claims table's composite primary key
    // (`PRIMARY KEY (streamId, idempotencyKey)`) already makes two streams
    // reusing the same key text impossible to collide once a claim lands —
    // asserting THAT would pass identically whether or not the stream
    // dimension is folded into the key's own construction, and would measure
    // nothing about this change. What did not hold before this constructor
    // existed: a key built with no stream in view at all could still be
    // built. That is the omission this test seeds.
    expect(() => effectIdempotencyKey('', 'branch-create')).toThrow(TypeError);
    expect(() => effectIdempotencyKey('   ', 'branch-create')).toThrow(TypeError);
    expect(() => effectIdempotencyKey(undefined as unknown as string, 'branch-create')).toThrow(
      TypeError,
    );

    // Control: the same call, with a real stream, builds — and the stream is
    // legible in the composed value, not merely accepted and discarded.
    const built = effectIdempotencyKey('vcs-mutations', 'branch-create');
    expect(built.stream).toBe('vcs-mutations');
    expect(built.key).toBe('branch-create');
    expect(built.value).toBe('vcs-mutations:branch-create');

    // A blank key is rejected on the same terms as a blank stream.
    expect(() => effectIdempotencyKey('vcs-mutations', '')).toThrow(TypeError);
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
