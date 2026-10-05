// Tests for the remediation of admission denials.
//
// Each `PolicyDenyReason` yields a safe verb or a stable terminal reason.
// No remediation verb mutates state. An import census, a verb deny-list and behavior tests check this.
// Each emitted next action passes the live `NextAction` schema, and that schema rejects a non-conforming action.
// Terminal reasons use codes from `STABLE_ERROR_REGISTRY`.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { NextAction } from '../../../../src/next-action.js';
import { STABLE_ERROR_REGISTRY } from '../../../../src/contract/error-families.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import {
  AdmissionRequirementV1Schema,
  PhaseAttemptIdSchema,
  type AdmissionRequirementV1,
} from '../../../../src/workflow/admission/types.js';
import type { PolicyDenyReason } from '../../../../src/workflow/admission/policy-evaluation.js';
import {
  POLICY_DENY_REASONS,
  REMEDIATION_TERMINAL_REASONS,
  SAFE_REMEDIATION_VERBS,
  STATE_MUTATION_VERBS,
  remediateDenial,
  remediateIndeterminate,
  stableErrorCodeForDenyReason,
  terminalForMissingDefinition,
  type RemediationInput,
  type RemediationOutcome,
} from '../../../../src/workflow/admission/remediation.js';
import { auditRemediationPurity } from '../../../../src/workflow/admission/remediation-purity.js';
import { lexModule } from '../../../../tools/test-helpers/module-lexer.js';

const phaseAttemptId = PhaseAttemptIdSchema.parse('pa.remediation-001');
const subject = createEvidenceSubject(
  { kind: 'phase-attempt', phaseAttemptId },
  { phase: 'gather', attempt: 1 },
);

const gateRequirement: AdmissionRequirementV1 = AdmissionRequirementV1Schema.parse({
  contractVersion: '1.0',
  kind: 'gate-evidence',
  requirementId: 'req.gate',
  phaseAttemptId,
  subject,
  gateId: 'gate.static-analysis',
});

const approvalRequirement: AdmissionRequirementV1 = AdmissionRequirementV1Schema.parse({
  contractVersion: '1.0',
  kind: 'approval',
  requirementId: 'req.approval',
  phaseAttemptId,
  subject,
  approvalClass: 'release-owner',
  minimumApprovals: 2,
});

const corroborationRequirement: AdmissionRequirementV1 = AdmissionRequirementV1Schema.parse({
  contractVersion: '1.0',
  kind: 'corroboration',
  requirementId: 'req.corroboration',
  phaseAttemptId,
  subject,
  sourceRequirementId: 'req.gate',
  minimumIndependentSources: 2,
});

const ALL_REQUIREMENTS: readonly AdmissionRequirementV1[] = [
  gateRequirement,
  approvalRequirement,
  corroborationRequirement,
];

const input = (
  reason: PolicyDenyReason,
  requirement: AdmissionRequirementV1,
  waivable: boolean,
): RemediationInput => ({ reason, requirement, waivable, phaseAttemptId });

function verbOf(outcome: RemediationOutcome): string | undefined {
  return outcome.kind === 'action' ? outcome.action.verb : undefined;
}

describe('remediateDenial — exhaustive over PolicyDenyReason (no unexplained denial)', () => {
  /** The census holds the six deny reasons. The exhaustive tests iterate this census. */
  it('ReasonCensus_MatchesThePolicyDenyReasonUnion', () => {
    expect([...POLICY_DENY_REASONS].sort()).toEqual(
      ['contradictory', 'failed', 'malformed', 'missing', 'stale', 'unauthorized'].sort(),
    );
  });

  /** An action carries a safe, schema-valid verb. A terminal carries a registry code and a summary. */
  it('EveryReason_ForEveryRequirementKind_YieldsAVerbOrTerminalReason', () => {
    for (const reason of POLICY_DENY_REASONS) {
      for (const requirement of ALL_REQUIREMENTS) {
        for (const waivable of [true, false]) {
          const outcome = remediateDenial(input(reason, requirement, waivable));

          expect(outcome.kind === 'action' || outcome.kind === 'terminal').toBe(true);
          expect(outcome.reason).toBe(reason);

          if (outcome.kind === 'action') {
            expect(SAFE_REMEDIATION_VERBS).toContain(outcome.action.verb);
            expect(() => NextAction.parse(outcome.action)).not.toThrow();
          } else {
            expect(REMEDIATION_TERMINAL_REASONS[outcome.terminalReason]).toBeDefined();
            expect(outcome.stableErrorCode in STABLE_ERROR_REGISTRY).toBe(true);
            expect(outcome.summary.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  /** The requirement kind selects the verb. The reason does not. */
  it('ProducibleReasons_MapToTheProducingVerbByRequirementKind', () => {
    const producible: PolicyDenyReason[] = ['missing', 'failed', 'stale', 'malformed'];
    for (const reason of producible) {
      expect(verbOf(remediateDenial(input(reason, gateRequirement, false)))).toBe('run_gate');
      expect(verbOf(remediateDenial(input(reason, approvalRequirement, false)))).toBe(
        'request_approval',
      );
      expect(verbOf(remediateDenial(input(reason, corroborationRequirement, false)))).toBe(
        'collect_evidence',
      );
    }
  });

  /**
   * A waivable requirement gets a waiver request, not a grant.
   * A requirement that is not waivable gets the `AUTHORIZATION_DENIED` terminal.
   */
  it('StructuralReasons_RequestWaiverWhenWaivable_TerminateWhenNot', () => {
    for (const reason of ['unauthorized', 'contradictory'] as const) {
      const waivableOutcome = remediateDenial(input(reason, gateRequirement, true));
      expect(waivableOutcome.kind).toBe('action');
      expect(verbOf(waivableOutcome)).toBe('request_waiver');

      const terminalOutcome = remediateDenial(input(reason, gateRequirement, false));
      expect(terminalOutcome.kind).toBe('terminal');
      if (terminalOutcome.kind === 'terminal') {
        expect(terminalOutcome.stableErrorCode).toBe('AUTHORIZATION_DENIED');
      }
    }
  });

  /** Each deny-reason code belongs to the `authorization` layer. */
  it('StableReasonCode_ForEveryDenyReason_IsARegistryCode', () => {
    for (const reason of POLICY_DENY_REASONS) {
      const code = stableErrorCodeForDenyReason(reason);
      expect(code in STABLE_ERROR_REGISTRY).toBe(true);
      expect(STABLE_ERROR_REGISTRY[code].layer).toBe('authorization');
    }
  });
});

describe('remediation is data, never a mutation', () => {
  /** `request_waiver` is a safe verb. `grant_waiver` is a mutation verb. */
  it('SafeVerbs_AreDisjointFromStateMutationVerbs', () => {
    const safe = new Set<string>(SAFE_REMEDIATION_VERBS);
    for (const mutation of STATE_MUTATION_VERBS) {
      expect(safe.has(mutation)).toBe(false);
    }
    expect(safe.has('request_waiver')).toBe(true);
    expect([...STATE_MUTATION_VERBS]).toContain('grant_waiver');
  });

  it('EveryEmittableVerb_IsInTheSafeSet_NeverAMutationVerb', () => {
    const emitted = new Set<string>();
    for (const reason of POLICY_DENY_REASONS) {
      for (const requirement of ALL_REQUIREMENTS) {
        for (const waivable of [true, false]) {
          const outcome = remediateDenial(input(reason, requirement, waivable));
          if (outcome.kind === 'action') emitted.add(outcome.action.verb);
        }
      }
    }
    emitted.add(remediateIndeterminate(phaseAttemptId).verb);

    for (const verb of emitted) {
      expect(SAFE_REMEDIATION_VERBS).toContain(verb);
      expect(STATE_MUTATION_VERBS as readonly string[]).not.toContain(verb);
    }
  });

  it('Structural_RemediationModule_ImportsNoStateMutationSurface', () => {
    const remediationSource = readFileSync(new URL('../../../../src/workflow/admission/remediation.ts', import.meta.url), 'utf8');
    const explanationSource = readFileSync(
      new URL('../../../../src/workflow/admission/decision-explanation.ts', import.meta.url),
      'utf8',
    );

    const remediationVerdict = auditRemediationPurity(
      'remediation.ts',
      remediationSource,
      lexModule,
    );
    const explanationVerdict = auditRemediationPurity(
      'decision-explanation.ts',
      explanationSource,
      lexModule,
    );

    expect(remediationVerdict.forbidden).toEqual([]);
    expect(remediationVerdict.ok).toBe(true);
    expect(remediationVerdict.importCount).toBeGreaterThan(0);
    expect(explanationVerdict.forbidden).toEqual([]);
    expect(explanationVerdict.ok).toBe(true);
  });

  /** A detector that always passes proves nothing. This module reaches the event store, so the census must flag it. */
  it('Structural_Census_ActuallyDetectsAForbiddenImport', () => {
    const tainted = [
      "import { AtomicAppender } from '../../events/atomic-appender.js';",
      "export const x = AtomicAppender;",
    ].join('\n');
    const verdict = auditRemediationPurity('tainted.ts', tainted, lexModule);
    expect(verdict.ok).toBe(false);
    expect(verdict.forbidden.map((f) => f.marker)).toContain('events/');
  });

  /** A type-only import is erased at compile time. A value import of the same module is forbidden. */
  it('Structural_Census_IgnoresErasedTypeOnlyImports_ButCatchesValueImports', () => {
    const typeOnly = "import type { TransitionDecided } from './transition-command.js';";
    expect(auditRemediationPurity('a.ts', typeOnly, lexModule).ok).toBe(true);
    const valueImport = "import { runTransitionCommand } from './transition-command.js';";
    const verdict = auditRemediationPurity('a.ts', valueImport, lexModule);
    expect(verdict.ok).toBe(false);
    expect(verdict.forbidden.map((f) => f.marker)).toContain('./transition-command');
  });

  /** The input requirement stays unchanged, and the action holds no function values. */
  it('Behavioural_RemediatingADenial_DoesNotMutateItsInputs', () => {
    const before = JSON.stringify(gateRequirement);
    const outcome = remediateDenial(input('failed', gateRequirement, false));
    expect(JSON.stringify(gateRequirement)).toBe(before);
    expect(typeof outcome).toBe('object');
    if (outcome.kind === 'action') {
      for (const value of Object.values(outcome.action)) {
        expect(typeof value).not.toBe('function');
      }
    }
  });
});

describe('emitted next_actions conform to the live NextAction schema', () => {
  /** The indeterminate retry verb also passes the schema. */
  it('ProducingAndWaiverActions_RoundTripThroughTheLiveSchema', () => {
    const samples: RemediationOutcome[] = [
      remediateDenial(input('missing', gateRequirement, false)),
      remediateDenial(input('failed', approvalRequirement, false)),
      remediateDenial(input('stale', corroborationRequirement, false)),
      remediateDenial(input('unauthorized', gateRequirement, true)),
      remediateDenial(input('contradictory', approvalRequirement, true)),
    ];
    for (const sample of samples) {
      expect(sample.kind).toBe('action');
      if (sample.kind === 'action') {
        const parsed = NextAction.parse(sample.action);
        expect(parsed).toEqual(sample.action);
        expect(sample.action.reason.length).toBeGreaterThan(0);
      }
    }
    expect(() => NextAction.parse(remediateIndeterminate(phaseAttemptId))).not.toThrow();
  });

  /** The schema rejects an empty `idempotencyKey` and a missing verb. A stub validator does not throw. */
  it('LiveSchema_RejectsANonConformingAction_ProvingItIsTheRealGate', () => {
    expect(() =>
      NextAction.parse({ verb: 'run_gate', reason: 'x', idempotencyKey: '' }),
    ).toThrow();
    expect(() => NextAction.parse({ reason: 'x' })).toThrow();
  });
});

describe('terminal reasons align to the P03-02 STABLE_ERROR_REGISTRY', () => {
  it('EveryTerminalReason_ReferencesARegistryCode', () => {
    for (const spec of Object.values(REMEDIATION_TERMINAL_REASONS)) {
      expect(spec.stableErrorCode in STABLE_ERROR_REGISTRY).toBe(true);
      expect(spec.summary.length).toBeGreaterThan(0);
    }
  });

  it('MissingDefinitionTerminal_IsAnInternalError_NotAnUnexplainedDenial', () => {
    const outcome = terminalForMissingDefinition('missing');
    expect(outcome.kind).toBe('terminal');
    expect(outcome.terminalReason).toBe('REQUIREMENT_DEFINITION_UNAVAILABLE');
    expect(outcome.stableErrorCode).toBe('INTERNAL_ERROR');
  });
});
