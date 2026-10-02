import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_ITERATIONS,
  SDK_MIGRATION_CONTRACT,
  resolveEscalationPolicy,
  decideEscalation,
  classifyFinding,
  countShepherdIterations,
} from '../../../../src/verbs/review/escalation-policy.js';

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

    /**
     * A bad per-loop override falls through to the config value. If both layers
     * are bad, the default applies.
     */
    it('ignores non-positive / non-integer values at each layer, falling through', () => {
      expect(
        resolveEscalationPolicy({ perLoopOverride: 0, configMaxIterations: 8 }),
      ).toEqual({ maxIterations: 8 });
      expect(
        resolveEscalationPolicy({ perLoopOverride: -3, configMaxIterations: 8 }),
      ).toEqual({ maxIterations: 8 });
      expect(
        resolveEscalationPolicy({ perLoopOverride: 2.5, configMaxIterations: 8 }),
      ).toEqual({ maxIterations: 8 });
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

  /**
   * A divergence guard. It runs the live policy and compares it to
   * `SDK_MIGRATION_CONTRACT`, the recorded combinator semantics of the Workflow
   * SDK, not to literals. A failure means that the interim policy and the SDK
   * semantics differ. Fix the code or the contract constant.
   */
  describe('DivergenceGuard_EscalationDefaults_MatchSdkRepeatUntilSemantics', () => {
    /**
     * The bound field has the name of the `maxIterations` option of the SDK
     * `repeatUntil`, so a move to the SDK renames only the call site. It is the
     * only field of the policy.
     */
    it("names the bound exactly the SDK repeatUntil option ('maxIterations')", () => {
      expect(SDK_MIGRATION_CONTRACT.repeatUntilOption).toBe('maxIterations');
      const policy = resolveEscalationPolicy();
      expect(SDK_MIGRATION_CONTRACT.repeatUntilOption in policy).toBe(true);
      expect(Object.keys(policy)).toEqual([SDK_MIGRATION_CONTRACT.repeatUntilOption]);
    });

    /** A change to `DEFAULT_MAX_ITERATIONS` without a change to the contract fails this test. */
    it('inherits the contract default bound as the no-config default (kill-probe on DEFAULT_MAX_ITERATIONS)', () => {
      expect(DEFAULT_MAX_ITERATIONS).toBe(SDK_MIGRATION_CONTRACT.defaultMaxIterations);
      expect(resolveEscalationPolicy().maxIterations).toBe(
        SDK_MIGRATION_CONTRACT.defaultMaxIterations,
      );
    });

    it('maps the ask-user escalation onto the SDK awaitApproval combinator', () => {
      expect(SDK_MIGRATION_CONTRACT.approvalCombinator).toBe('awaitApproval');
    });

    /**
     * Each probe names the contract trigger that it exercises, or `null` for an
     * auto-fix. The no-config policy escalates an intent-touching finding at any
     * iteration, and a mechanical finding at or over the bound. The live action
     * of each probe must match its label. The set of escalating labels must equal
     * `SDK_MIGRATION_CONTRACT.escalationTriggers`.
     */
    it('escalates in EXACTLY the contract awaitApproval triggers, auto-fixing otherwise', () => {
      const policy = resolveEscalationPolicy();

      const probes: ReadonlyArray<{
        readonly decision: ReturnType<typeof decideEscalation>;
        readonly expectedTrigger: 'bound-reached' | 'intent-touching' | null;
      }> = [
        {
          decision: decideEscalation({ findingClass: 'intent-touching', iteration: 0, policy }),
          expectedTrigger: 'intent-touching',
        },
        {
          decision: decideEscalation({ findingClass: 'mechanical', iteration: 0, policy }),
          expectedTrigger: null,
        },
        {
          decision: decideEscalation({
            findingClass: 'mechanical',
            iteration: policy.maxIterations,
            policy,
          }),
          expectedTrigger: 'bound-reached',
        },
        {
          decision: decideEscalation({
            findingClass: 'mechanical',
            iteration: policy.maxIterations + 4,
            policy,
          }),
          expectedTrigger: 'bound-reached',
        },
      ];

      for (const { decision, expectedTrigger } of probes) {
        expect(decision.action).toBe(expectedTrigger === null ? 'auto-fix' : 'escalate');
      }

      const observedTriggers = new Set(
        probes
          .filter((p) => p.decision.action === 'escalate')
          .map((p) => p.expectedTrigger),
      );
      expect(observedTriggers).toEqual(new Set(SDK_MIGRATION_CONTRACT.escalationTriggers));
    });
  });
});
