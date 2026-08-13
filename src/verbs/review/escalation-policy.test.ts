import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_ITERATIONS,
  SDK_MIGRATION_CONTRACT,
  resolveEscalationPolicy,
  decideEscalation,
  classifyFinding,
  countShepherdIterations,
} from './escalation-policy.js';

describe('escalation-policy (DR-3, #1595)', () => {
  describe('EscalationPolicy_DefaultFive_PerLoopOverride', () => {
    it('resolves to the uniform default of 5 with no input', () => {
      expect(DEFAULT_MAX_ITERATIONS).toBe(5);
      expect(resolveEscalationPolicy()).toEqual({ maxIterations: 5 });
      expect(resolveEscalationPolicy({})).toEqual({ maxIterations: 5 });
    });

    it('honors a config-resolved bound', () => {
      expect(resolveEscalationPolicy({ configMaxIterations: 8 })).toEqual({ maxIterations: 8 });
    });

    it('honors a per-loop override', () => {
      expect(resolveEscalationPolicy({ perLoopOverride: 2 })).toEqual({ maxIterations: 2 });
    });

    it('lets the per-loop override win over the config value', () => {
      expect(
        resolveEscalationPolicy({ perLoopOverride: 2, configMaxIterations: 8 }),
      ).toEqual({ maxIterations: 2 });
    });

    it('ignores non-positive / non-integer values at each layer, falling through', () => {
      // Per-loop override is garbage → fall through to config.
      expect(
        resolveEscalationPolicy({ perLoopOverride: 0, configMaxIterations: 8 }),
      ).toEqual({ maxIterations: 8 });
      expect(
        resolveEscalationPolicy({ perLoopOverride: -3, configMaxIterations: 8 }),
      ).toEqual({ maxIterations: 8 });
      expect(
        resolveEscalationPolicy({ perLoopOverride: 2.5, configMaxIterations: 8 }),
      ).toEqual({ maxIterations: 8 });
      // Both layers garbage → fall through to the default.
      expect(
        resolveEscalationPolicy({ perLoopOverride: -1, configMaxIterations: 0 }),
      ).toEqual({ maxIterations: 5 });
      expect(
        resolveEscalationPolicy({ perLoopOverride: Number.NaN, configMaxIterations: Number.NaN }),
      ).toEqual({ maxIterations: 5 });
    });
  });

  describe('EscalationPolicy_MechanicalFinding_AutoFixesWithinBound', () => {
    it('auto-fixes a mechanical finding while under the bound', () => {
      const decision = decideEscalation({
        findingClass: 'mechanical',
        iteration: 2,
        policy: { maxIterations: 5 },
      });
      expect(decision.action).toBe('auto-fix');
    });

    it('escalates a mechanical finding once the bound is hit (bound-hit reason)', () => {
      const decision = decideEscalation({
        findingClass: 'mechanical',
        iteration: 5,
        policy: { maxIterations: 5 },
      });
      expect(decision.action).toBe('escalate');
      expect(decision.reason).toContain('auto-fix bound');
      expect(decision.reason).toContain('5');
    });

    it('escalates when the iteration exceeds the bound', () => {
      const decision = decideEscalation({
        findingClass: 'mechanical',
        iteration: 9,
        policy: { maxIterations: 5 },
      });
      expect(decision.action).toBe('escalate');
    });
  });

  describe('EscalationPolicy_IntentTouchingFinding_EscalatesImmediately', () => {
    it('escalates an intent-touching finding at iteration 0 (not bound-gated)', () => {
      const decision = decideEscalation({
        findingClass: 'intent-touching',
        iteration: 0,
        policy: { maxIterations: 5 },
      });
      expect(decision.action).toBe('escalate');
      expect(decision.reason).toContain('intent-touching');
    });

    it('escalates an intent-touching finding regardless of iteration', () => {
      for (const iteration of [0, 1, 4, 100]) {
        expect(
          decideEscalation({
            findingClass: 'intent-touching',
            iteration,
            policy: { maxIterations: 5 },
          }).action,
        ).toBe('escalate');
      }
    });
  });

  describe('classifyFinding', () => {
    it('classifies an explicitly intent-touching finding', () => {
      expect(classifyFinding({ intentTouching: true })).toBe('intent-touching');
    });

    it('classifies a spec-category finding as intent-touching', () => {
      expect(classifyFinding({ category: 'spec' })).toBe('intent-touching');
    });

    it('classifies lint/format/style/coverage findings as mechanical', () => {
      expect(classifyFinding({ category: 'lint' })).toBe('mechanical');
      expect(classifyFinding({ category: 'format' })).toBe('mechanical');
      expect(classifyFinding({ category: 'style' })).toBe('mechanical');
      expect(classifyFinding({ category: 'coverage' })).toBe('mechanical');
      expect(classifyFinding({})).toBe('mechanical');
      expect(classifyFinding({ intentTouching: false })).toBe('mechanical');
    });
  });

  describe('countShepherdIterations', () => {
    it('counts only shepherd.iteration events', () => {
      const events = [
        { type: 'shepherd.started' },
        { type: 'shepherd.iteration' },
        { type: 'task.completed' },
        { type: 'shepherd.iteration' },
        { type: 'shepherd.iteration' },
        { type: 'shepherd.completed' },
      ];
      expect(countShepherdIterations(events)).toBe(3);
    });

    it('returns 0 for an empty stream or a stream with no iterations', () => {
      expect(countShepherdIterations([])).toBe(0);
      expect(
        countShepherdIterations([{ type: 'shepherd.started' }, { type: 'shepherd.completed' }]),
      ).toBe(0);
    });
  });

  // ─── DR-6 divergence guard (#1598, task 023) ────────────────────────────────
  //
  // This is the DR-6 divergence guard. It pins the interim escalation defaults
  // to the documented Workflow SDK (#1258) combinator semantics recorded in
  // `docs/designs/archive/2026-06-23-ship-gate-sdk-migration.md` ("SDK-contract
  // values"), mirrored as `SDK_MIGRATION_CONTRACT`. The assertions run the LIVE
  // policy and compare it to that constant — never to hardcoded literals — so a
  // FAILURE here means the interim policy and the documented SDK semantics have
  // FORKED. Fix one or the other (code or the migration note + constant), never
  // silently let them drift.
  describe('DivergenceGuard_EscalationDefaults_MatchSdkRepeatUntilSemantics', () => {
    it("names the bound exactly the SDK repeatUntil option ('maxIterations')", () => {
      // The interim policy's bound field must be named identically to the SDK's
      // `repeatUntil(cond, body, { maxIterations })` option, so consolidation is
      // a rename of the call site, not a re-derivation.
      expect(SDK_MIGRATION_CONTRACT.repeatUntilOption).toBe('maxIterations');
      const policy = resolveEscalationPolicy();
      expect(SDK_MIGRATION_CONTRACT.repeatUntilOption in policy).toBe(true);
      // The bound field is the ONLY field — i.e. `maxIterations` is the policy's
      // bound, not some incidentally-present key.
      expect(Object.keys(policy)).toEqual([SDK_MIGRATION_CONTRACT.repeatUntilOption]);
    });

    it('inherits the contract default bound as the no-config default (kill-probe on DEFAULT_MAX_ITERATIONS)', () => {
      // Changing DEFAULT_MAX_ITERATIONS without updating the contract breaks
      // this guard: both the constant and the resolved no-config policy must
      // equal the documented SDK `repeatUntil({ maxIterations })` default.
      expect(DEFAULT_MAX_ITERATIONS).toBe(SDK_MIGRATION_CONTRACT.defaultMaxIterations);
      expect(resolveEscalationPolicy().maxIterations).toBe(
        SDK_MIGRATION_CONTRACT.defaultMaxIterations,
      );
    });

    it('maps the ask-user escalation onto the SDK awaitApproval combinator', () => {
      expect(SDK_MIGRATION_CONTRACT.approvalCombinator).toBe('awaitApproval');
    });

    it('escalates in EXACTLY the contract awaitApproval triggers, auto-fixing otherwise', () => {
      const policy = resolveEscalationPolicy(); // { maxIterations: 5 }, the no-config default

      // Drive `decideEscalation` across the behavioral axes and derive, from the
      // LIVE policy, the set of triggers under which it escalates. Each probe is
      // labelled with the contract trigger it is meant to exercise; `null` means
      // "must NOT escalate" (the `repeatUntil` body auto-fixes).
      const probes: ReadonlyArray<{
        readonly decision: ReturnType<typeof decideEscalation>;
        readonly expectedTrigger: 'bound-reached' | 'intent-touching' | null;
      }> = [
        // intent-touching at iteration 0 (well under bound): the
        // 'intent-touching' trigger fires regardless of remaining budget.
        {
          decision: decideEscalation({ findingClass: 'intent-touching', iteration: 0, policy }),
          expectedTrigger: 'intent-touching',
        },
        // mechanical under the bound: no trigger — auto-fix (the repeatUntil body).
        {
          decision: decideEscalation({ findingClass: 'mechanical', iteration: 0, policy }),
          expectedTrigger: null,
        },
        // mechanical at the bound: the 'bound-reached' trigger fires.
        {
          decision: decideEscalation({
            findingClass: 'mechanical',
            iteration: policy.maxIterations,
            policy,
          }),
          expectedTrigger: 'bound-reached',
        },
        // mechanical over the bound: still the 'bound-reached' trigger.
        {
          decision: decideEscalation({
            findingClass: 'mechanical',
            iteration: policy.maxIterations + 4,
            policy,
          }),
          expectedTrigger: 'bound-reached',
        },
      ];

      // 1. Each probe's live action must agree with whether a trigger is expected.
      for (const { decision, expectedTrigger } of probes) {
        expect(decision.action).toBe(expectedTrigger === null ? 'auto-fix' : 'escalate');
      }

      // 2. The set of triggers actually observed escalating from the LIVE policy
      //    must equal the documented contract set 1:1. Adding or removing an
      //    escalation case in `decideEscalation` without updating
      //    SDK_MIGRATION_CONTRACT.escalationTriggers breaks this guard.
      const observedTriggers = new Set(
        probes
          .filter((p) => p.decision.action === 'escalate')
          .map((p) => p.expectedTrigger),
      );
      expect(observedTriggers).toEqual(new Set(SDK_MIGRATION_CONTRACT.escalationTriggers));
    });
  });
});
