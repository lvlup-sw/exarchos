// @oracle-sources: ../../../../src/dispatch/core/effect-carrier.ts, the effect plans this file spells out as literals — written from the DECLARED obligation of each action rather than from a recorded run
//
// An effect plan is the carrier's reading of a contract. The second authority
// is the plan the test author derived independently from what the action
// promises; if it were captured from the carrier instead, a carrier that
// misread every contract identically would still pass.

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
    const outcome = succeeded(42, replayedEvidence('vcs.executed', 'a prior run'));
    expect(isSuccess(outcome)).toBe(true);
    expect(isError(outcome)).toBe(false);
    expect(isDryRun(outcome)).toBe(false);
    if (isSuccess(outcome)) {
      expect(outcome.value).toBe(42);
      // The value does not arrive alone: a success carrier cannot be built
      // without evidence, which is what makes reaching `T` mean the append
      // happened.
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

describe('the edges that universal declaration puts pressure on', () => {
  it('DryRun_EveryPlanDeclares_StillRecordsNothing', async () => {
    // Declaration is universal now, so the arm that must record NOTHING is the
    // one carrying the new pressure: a dry-run holds a plan that declares three
    // emissions and a capability able to write them, and must still write none.
    const trace: string[] = [];
    const recorder = emissionRecorder((emission) => {
      trace.push(emission.event);
    });
    const execute = vi.fn().mockResolvedValue('SHOULD NOT RUN');

    const outcome = await runEffect(DRY_RUN, LEDGER_PLAN, execute, recorder);

    expect(isDryRun(outcome)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    // The whole guarantee: a withheld effect leaves the ledger as silent as it
    // leaves the disk.
    expect(trace).toEqual([]);
  });

  it('DryRun_RecordsNothingPlan_IsAlsoSilent', async () => {
    // The other plan shape, for the same arm. An abstention in dry-run must not
    // be the case that quietly reaches the recorder.
    const sink = vi.fn();
    const outcome = await runEffect(DRY_RUN, PLAN, () => Promise.resolve(1), emissionRecorder(sink));
    expect(isDryRun(outcome)).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });

  it('RecordEmissions_NonReceiptMidSet_FailsWholeEffect', async () => {
    // A recorder that stops minting part-way through a declared set must fail
    // the WHOLE effect rather than record a prefix and commit. The ledger plan
    // declares one `before` emission, so the mid-set case needs a condition
    // carrying more than one — built here rather than borrowed, so the test
    // states its own subject.
    const multiIntent: EffectPlan = {
      ...LEDGER_PLAN,
      emits: records(
        { event: 'vcs.requested', when: 'before' },
        { event: 'vcs.executed', when: 'before' },
      ),
    };

    let minted = 0;
    const genuine = emissionRecorder(() => undefined);
    // Mints a real receipt for the first declaration, then returns a non-receipt.
    const halfway = forgeBrandedRecorder(async (emission, plan) => {
      minted += 1;
      return minted === 1 ? await genuine.record(emission, plan) : { notAReceipt: true };
    });

    const execute = vi.fn().mockResolvedValue('committed');
    await expect(runEffect(LIVE, multiIntent, execute, halfway)).rejects.toThrow(
      UnrecordedEmissionError,
    );
    // Truncation is not a partial success: the effect never ran at all.
    expect(execute).not.toHaveBeenCalled();
  });

  it('UnrecordedEmissionError_NamesPlanDeclarationAndCount', async () => {
    // A failing build has to say what to fix. The diagnostic names the plan, the
    // condition, and both counts — otherwise it reports that something is wrong
    // without saying what.
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

  it('SuccessArm_CarriesAReceiptPerDeclaredEmission', async () => {
    // The evidence is not decorative: it holds one minted receipt for each
    // declaration that fired — the intent and exactly one terminal.
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

  it('SuccessArm_RecordsNothingPlan_CarriesEmptyRecordedEvidence', async () => {
    // An abstention still commits through the `recorded` arm — with nothing in
    // it. That is the honest shape: this run recorded, and what it recorded was
    // nothing. Reaching for the replay witness here would claim a prior append
    // that never happened.
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
