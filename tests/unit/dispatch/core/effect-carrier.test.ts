// @oracle-sources: ../../../../src/dispatch/core/effect-carrier.ts, the effect plans this file spells out as literals — written from the DECLARED obligation of each action rather than from a recorded run
//
// An effect plan is how the carrier reads a contract. The test author derived the second authority
// from the promise of each action. A plan captured from the carrier also passes when the carrier
// misreads each contract in the same way.

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
  replayedEvidence,
  emissionRecorder,
  effectIdempotencyKey,
  effectPlanFromContract,
  idempotentFromReplay,
  isSuccess,
  isError,
  isDryRun,
  toEffectError,
  UnrecordedEmissionError,
  LIVE,
  DRY_RUN,
  type EffectPlan,
  type EffectEmission,
  type EffectPlanInput,
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
  /** The plan declares the abstention with a reason, so it differs from an omission. */
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
 * A genuine capability for a run whose subject is not the commit gate. Each live run needs one,
 * also for a plan that records nothing.
 */
const inertRecorder = (): EmissionRecorder => emissionRecorder(() => undefined);

const names = (emissions: readonly EffectEmission[]): readonly string[] =>
  emissions.map((emission) => emission.event);

/**
 * The one type bypass in this file. An untyped or transpiled caller can pass any shape as the
 * recorder, and only the runtime brand check catches that shape. All other code in this file uses
 * the real constructor.
 */
const asRecorder = (forgery: unknown): EmissionRecorder => forgery as EmissionRecorder;

/** A function with the `EmissionSink` signature and no brand. It records nothing. */
const PORT_SHAPED_NO_OP: EmissionSink = () => undefined;

/**
 * Copies the module-private capability brand from a genuine recorder. Production code cannot name
 * the unexported symbol. A test needs the copy to exercise the evidence gate apart from the
 * capability gate. A forgery that passes the brand check still cannot mint a receipt.
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
  /** `succeeded` requires evidence, so a success value means that the append occurred. */
  it('succeeded builds a success arm that only isSuccess narrows', () => {
    const outcome = succeeded(42, replayedEvidence('vcs.executed', 'a prior run'));
    expect(isSuccess(outcome)).toBe(true);
    expect(isError(outcome)).toBe(false);
    expect(isDryRun(outcome)).toBe(false);
    if (isSuccess(outcome)) {
      expect(outcome.value).toBe(42);
      expect(outcome.evidence.kind).toBe('replayed');
    }
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
  /**
   * `emits` is a set with a condition for each emission, not one event. One plan read through
   * three conditions gives three names, and no name belongs to two conditions. A plan can declare
   * one terminal only, and then the other conditions read as empty. A plan can also record
   * nothing, and nothing is inferred from `effectClass` or `owner`.
   */
  it('EffectPlan_Emits_IsAConditionedSet', () => {
    expect(names(emissionsWhen(LEDGER_PLAN, 'before'))).toEqual(['vcs.requested']);
    expect(names(emissionsWhen(LEDGER_PLAN, 'on-success'))).toEqual(['vcs.executed']);
    expect(names(emissionsWhen(LEDGER_PLAN, 'on-failure'))).toEqual(['vcs.compensated']);

    const perCondition = (['before', 'on-success', 'on-failure'] as const).flatMap((when) =>
      names(emissionsWhen(LEDGER_PLAN, when)),
    );
    expect(new Set(perCondition).size).toBe(perCondition.length);
    expect(perCondition).toHaveLength(declaredEmissions(LEDGER_PLAN).length);

    expect(names(emissionsWhen(PROMOTION_PLAN, 'on-success'))).toEqual(['promotion.executed']);
    expect(emissionsWhen(PROMOTION_PLAN, 'before')).toEqual([]);
    expect(emissionsWhen(PROMOTION_PLAN, 'on-failure')).toEqual([]);

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
  /**
   * The withheld plan still reports the emissions that a live run records. The live run of the
   * same plan is the control: it reaches the thunk and the recorder, so the port is not inert.
   */
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
    if (isDryRun(outcome)) expect(outcome.plan.emits).toEqual(LEDGER_PLAN.emits);

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
  /**
   * `noOps` holds each way to supply no capability. The first two are an omitted recorder and a
   * bare lambda forced past the compiler. The other two are a function with the sink signature and
   * an unbranded object with a `record` method. None reaches a `success` arm. The effect also does
   * not run, because an owner that cannot record must not mutate.
   */
  it('EffectCarrier_NoOpRecorder_CannotYieldACommittedValue', async () => {
    const noOps: readonly { readonly label: string; readonly recorder?: EmissionRecorder }[] = [
      { label: 'omitted' },
      { label: 'bare no-op lambda', recorder: asRecorder(() => undefined) },
      { label: 'port-shaped no-op', recorder: asRecorder(PORT_SHAPED_NO_OP) },
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
      expect(execute, label).not.toHaveBeenCalled();
    }
  });

  /**
   * The forgery passes the brand check, because the test copied the symbol from a real recorder.
   * Its `record` returns a plain object and not a minted receipt, so the run commits no value.
   */
  it('rejects a forged capability whose record mints no evidence', async () => {
    const execute = vi.fn().mockResolvedValue('COMMITTED');
    const forged = forgeBrandedRecorder((emission) =>
      Promise.resolve({ event: emission.event, when: emission.when }),
    );

    await expect(runEffect(LIVE, LEDGER_PLAN, execute, forged)).rejects.toThrow(
      UnrecordedEmissionError,
    );
  });

  /** The control for the rejections above: an implementation that never commits fails here. */
  it('commits once a genuine recorder has recorded the declared emissions', async () => {
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

  /**
   * A live run demands a recorder also for a plan that records nothing. The refusal comes before
   * the thunk, so the run mutates nothing.
   */
  it('RunEffect_RecordsNothingPlanWithNoRecorder_RefusesInLiveMode', async () => {
    const execute = vi.fn().mockResolvedValue('committed');
    await expect(
      runEffect(LIVE, PLAN, execute, undefined as unknown as EmissionRecorder),
    ).rejects.toThrow(UnrecordedEmissionError);
    expect(execute).not.toHaveBeenCalled();
  });

  /** A declared abstention is legal. The run requires the capability and then does not use it. */
  it('RunEffect_RecordsNothingPlanWithRecorder_CommitsAndRecordsNothing', async () => {
    const sink = vi.fn();
    const outcome = await runEffect(LIVE, PLAN, () => Promise.resolve('committed'), emissionRecorder(sink));
    expect(isSuccess(outcome)).toBe(true);
    if (isSuccess(outcome)) expect(outcome.value).toBe('committed');
    expect(sink).not.toHaveBeenCalled();
  });

  /**
   * The dry-run guarantee has priority over the commit gate. A withheld effect records nothing, so
   * no record is missing.
   */
  it('withholds the refusal in dry-run — neither thunk nor capability is reached', async () => {
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
  /**
   * The subject is rejection at construction, not a collision across streams. The composite
   * primary key of the claims table, `(streamId, idempotencyKey)`, already prevents that
   * collision, so an assertion on it proves nothing about this constructor. The control builds a
   * key with a real stream and reads the stream back from the composed value. A blank key fails
   * like a blank stream.
   */
  it('EffectIdempotency_KeyBuiltWithoutStream_IsRejectedAtConstruction', () => {
    expect(() => effectIdempotencyKey('', 'branch-create')).toThrow(TypeError);
    expect(() => effectIdempotencyKey('   ', 'branch-create')).toThrow(TypeError);
    expect(() => effectIdempotencyKey(undefined as unknown as string, 'branch-create')).toThrow(
      TypeError,
    );

    const built = effectIdempotencyKey('vcs-mutations', 'branch-create');
    expect(built.stream).toBe('vcs-mutations');
    expect(built.key).toBe('branch-create');
    expect(built.value).toBe('vcs-mutations:branch-create');

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

describe('the edges that universal declaration puts pressure on', () => {
  /**
   * The dry run holds a plan with three declared emissions and a recorder that can write them. It
   * must still write none.
   */
  it('DryRun_EveryPlanDeclares_StillRecordsNothing', async () => {
    const trace: string[] = [];
    const recorder = emissionRecorder((emission) => {
      trace.push(emission.event);
    });
    const execute = vi.fn().mockResolvedValue('SHOULD NOT RUN');

    const outcome = await runEffect(DRY_RUN, LEDGER_PLAN, execute, recorder);

    expect(isDryRun(outcome)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(trace).toEqual([]);
  });

  /** The same arm with the other plan shape. An abstention in dry-run must not reach the recorder. */
  it('DryRun_RecordsNothingPlan_IsAlsoSilent', async () => {
    const sink = vi.fn();
    const outcome = await runEffect(DRY_RUN, PLAN, () => Promise.resolve(1), emissionRecorder(sink));
    expect(isDryRun(outcome)).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });

  /**
   * A recorder that stops minting inside a declared set must fail the whole effect. `LEDGER_PLAN`
   * declares one `before` emission, so the test builds a plan with two. The recorder mints a real
   * receipt for the first and returns a non-receipt for the second. The effect does not run.
   */
  it('RecordEmissions_NonReceiptMidSet_FailsWholeEffect', async () => {
    const multiIntent: EffectPlan = {
      ...LEDGER_PLAN,
      emits: records(
        { event: 'vcs.requested', when: 'before' },
        { event: 'vcs.executed', when: 'before' },
      ),
    };

    let minted = 0;
    const genuine = emissionRecorder(() => undefined);
    const halfway = forgeBrandedRecorder(async (emission, plan) => {
      minted += 1;
      return minted === 1 ? await genuine.record(emission, plan) : { notAReceipt: true };
    });

    const execute = vi.fn().mockResolvedValue('committed');
    await expect(runEffect(LIVE, multiIntent, execute, halfway)).rejects.toThrow(
      UnrecordedEmissionError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  /** The diagnostic names the plan, the condition, and both counts, so it says what to fix. */
  it('UnrecordedEmissionError_NamesPlanDeclarationAndCount', async () => {
    const genuine = emissionRecorder(() => undefined);
    let minted = 0;
    const halfway = forgeBrandedRecorder(async (emission, plan) => {
      minted += 1;
      return minted === 1 ? await genuine.record(emission, plan) : { notAReceipt: true };
    });
    const multiIntent: EffectPlan = {
      ...LEDGER_PLAN,
      emits: records(
        { event: 'vcs.requested', when: 'before' },
        { event: 'vcs.executed', when: 'before' },
      ),
    };

    const error = await runEffect(LIVE, multiIntent, () => Promise.resolve(1), halfway).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(UnrecordedEmissionError);
    if (error instanceof UnrecordedEmissionError) {
      expect(error.plan.description).toBe(multiIntent.description);
      expect(error.when).toBe('before');
      expect(error.declared).toBe(2);
      expect(error.appended).toBe(1);
      expect(error.message).toContain(multiIntent.owner);
      expect(error.message).toContain('2');
    }
  });

  /** The evidence holds one minted receipt for each declaration that fired: the intent and one terminal. */
  it('SuccessArm_CarriesAReceiptPerDeclaredEmission', async () => {
    const outcome = await runEffect(
      LIVE,
      LEDGER_PLAN,
      () => Promise.resolve('committed'),
      emissionRecorder(() => undefined),
    );

    expect(isSuccess(outcome)).toBe(true);
    if (isSuccess(outcome) && outcome.evidence.kind === 'recorded') {
      expect(outcome.evidence.receipts.map((receipt) => receipt.event)).toEqual([
        'vcs.requested',
        'vcs.executed',
      ]);
    } else {
      expect.unreachable('a live ledger run must carry recorded evidence');
    }
  });

  /**
   * An abstention commits through the `recorded` arm with no receipts. The replay witness is wrong
   * here, because it claims an earlier append that did not occur.
   */
  it('SuccessArm_RecordsNothingPlan_CarriesEmptyRecordedEvidence', async () => {
    const outcome = await runEffect(
      LIVE,
      PLAN,
      () => Promise.resolve('committed'),
      emissionRecorder(() => undefined),
    );
    expect(isSuccess(outcome)).toBe(true);
    if (isSuccess(outcome)) {
      expect(outcome.evidence.kind).toBe('recorded');
      if (outcome.evidence.kind === 'recorded') expect(outcome.evidence.receipts).toEqual([]);
    }
  });
});

const PLAN_FIELDS: EffectPlanInput = {
  effectClass: PLAN.effectClass,
  owner: PLAN.owner,
  description: PLAN.description,
  compensation: PLAN.compensation,
  emits: PLAN.emits,
};

describe('effect plan replay binding', () => {
  it('Replay_EffectPlanIdempotent_DerivesFromContract', () => {
    expect(idempotentFromReplay({ kind: 'safe-repeat' })).toBe(true);
    expect(
      idempotentFromReplay({ kind: 'claim-required', scope: 'stream-subject-request' }),
    ).toBe(false);
    expect(
      idempotentFromReplay({ kind: 'reject-replay', because: 'external side effect' }),
    ).toBe(false);

    expect(
      effectPlanFromContract(PLAN_FIELDS, { replay: { kind: 'safe-repeat' } }).idempotent,
    ).toBe(true);
    expect(
      effectPlanFromContract(PLAN_FIELDS, {
        replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      }).idempotent,
    ).toBe(false);
    expect(
      effectPlanFromContract(PLAN_FIELDS, {
        replay: { kind: 'reject-replay', because: 'external side effect' },
      }).idempotent,
    ).toBe(false);

    const disagreeing = { ...PLAN_FIELDS, idempotent: true };
    expect(
      effectPlanFromContract(disagreeing, {
        replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      }).idempotent,
    ).toBe(false);
  });
});

describe('effect plan emission binding', () => {
  const siblingEmit = records({ event: 'gate.executed', when: 'before' });
  const contractEmission = {
    event: 'workflow.started' as const,
    condition: 'always' as const,
    owner: 'workflow',
    role: 'primary' as const,
  };

  it('derives emit identity and owner/role from the nested contract', () => {
    const plan = effectPlanFromContract(
      {
        ...PLAN_FIELDS,
        owner: 'effect-owner',
        emits: records({ event: 'gate.executed', when: 'on-success', owner: 'sibling', role: 'recovery' }),
      },
      {
        replay: { kind: 'safe-repeat' },
        emissions: { kind: 'declared', values: [contractEmission] },
      },
    );
    expect(declaredEmissions(plan)).toEqual([
      { event: 'workflow.started', when: 'on-success', owner: 'workflow', role: 'primary' },
    ]);
    expect(plan.owner).toBe('effect-owner');
  });

  it('keeps per-effect when independent of the contract condition', () => {
    const plan = effectPlanFromContract(
      {
        ...PLAN_FIELDS,
        emits: records({ event: 'workflow.started', when: 'before' }),
      },
      {
        replay: { kind: 'safe-repeat' },
        emissions: { kind: 'declared', values: [contractEmission] },
      },
    );
    expect(declaredEmissions(plan)[0]?.when).toBe('before');
    expect(declaredEmissions(plan)[0]?.event).toBe('workflow.started');
    expect(plan.emits.kind).toBe('records');
  });

  it('a reasoned none wins over sibling records', () => {
    const plan = effectPlanFromContract(
      { ...PLAN_FIELDS, emits: siblingEmit },
      {
        replay: { kind: 'safe-repeat' },
        emissions: { kind: 'none', because: 'this action appends nothing' },
      },
    );
    expect(plan.emits).toEqual(recordsNothing('this action appends nothing'));
  });
});
