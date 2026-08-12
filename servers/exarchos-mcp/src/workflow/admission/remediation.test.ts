// Exit-proof tests for P06-06 remediation (Transition tasks 025, 026).
//
// Proves the load-bearing obligations:
//   (a) every PolicyDenyReason yields a safe verb OR a stable terminal reason —
//       exhaustive, no gaps;
//   (b) no remediation verb mutates state — structural (import census + verb
//       deny-list) AND behavioural;
//   (c) every emitted next_action validates against the LIVE schema, and a
//       non-conforming action is rejected by that same schema;
//   (d) terminal reasons align to the P03-02 STABLE_ERROR_REGISTRY, not a
//       parallel vocabulary.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { NextAction } from '../../next-action.js';
import { STABLE_ERROR_REGISTRY } from '../../contract/error-families.js';
import { createEvidenceSubject } from './evidence-subject.js';
import {
  AdmissionRequirementV1Schema,
  PhaseAttemptIdSchema,
  type AdmissionRequirementV1,
} from './types.js';
import type { PolicyDenyReason } from './policy-evaluation.js';
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
} from './remediation.js';
import { auditRemediationPurity } from './remediation-purity.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

// ─── (a) Exhaustive: every reason → safe verb OR stable terminal reason ──────

describe('remediateDenial — exhaustive over PolicyDenyReason (no unexplained denial)', () => {
  it('ReasonCensus_MatchesThePolicyDenyReasonUnion', () => {
    // The runtime-iterable census is exactly the six sound deny reasons — the
    // basis on which "no gaps" is proven.
    expect([...POLICY_DENY_REASONS].sort()).toEqual(
      ['contradictory', 'failed', 'malformed', 'missing', 'stale', 'unauthorized'].sort(),
    );
  });

  it('EveryReason_ForEveryRequirementKind_YieldsAVerbOrTerminalReason', () => {
    for (const reason of POLICY_DENY_REASONS) {
      for (const requirement of ALL_REQUIREMENTS) {
        for (const waivable of [true, false]) {
          const outcome = remediateDenial(input(reason, requirement, waivable));

          // No third case: strictly action | terminal.
          expect(outcome.kind === 'action' || outcome.kind === 'terminal').toBe(true);
          expect(outcome.reason).toBe(reason);

          if (outcome.kind === 'action') {
            // A safe verb — from the closed safe set, schema-valid.
            expect(SAFE_REMEDIATION_VERBS).toContain(outcome.action.verb);
            expect(() => NextAction.parse(outcome.action)).not.toThrow();
          } else {
            // A stable terminal reason — aligned to the P03-02 registry.
            expect(REMEDIATION_TERMINAL_REASONS[outcome.terminalReason]).toBeDefined();
            expect(outcome.stableErrorCode in STABLE_ERROR_REGISTRY).toBe(true);
            expect(outcome.summary.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('ProducibleReasons_MapToTheProducingVerbByRequirementKind', () => {
    const producible: PolicyDenyReason[] = ['missing', 'failed', 'stale', 'malformed'];
    for (const reason of producible) {
      // Producing verb is chosen by requirement KIND, never by the reason.
      expect(verbOf(remediateDenial(input(reason, gateRequirement, false)))).toBe('run_gate');
      expect(verbOf(remediateDenial(input(reason, approvalRequirement, false)))).toBe(
        'request_approval',
      );
      expect(verbOf(remediateDenial(input(reason, corroborationRequirement, false)))).toBe(
        'collect_evidence',
      );
    }
  });

  it('StructuralReasons_RequestWaiverWhenWaivable_TerminateWhenNot', () => {
    for (const reason of ['unauthorized', 'contradictory'] as const) {
      // Waivable → a legitimate WAIVER REQUEST (a request, never a grant).
      const waivableOutcome = remediateDenial(input(reason, gateRequirement, true));
      expect(waivableOutcome.kind).toBe('action');
      expect(verbOf(waivableOutcome)).toBe('request_waiver');

      // Not waivable → a stable terminal reason; nothing safe to do in band.
      const terminalOutcome = remediateDenial(input(reason, gateRequirement, false));
      expect(terminalOutcome.kind).toBe('terminal');
      if (terminalOutcome.kind === 'terminal') {
        expect(terminalOutcome.stableErrorCode).toBe('AUTHORIZATION_DENIED');
      }
    }
  });

  it('StableReasonCode_ForEveryDenyReason_IsARegistryCode', () => {
    for (const reason of POLICY_DENY_REASONS) {
      const code = stableErrorCodeForDenyReason(reason);
      expect(code in STABLE_ERROR_REGISTRY).toBe(true);
      // Admission denials are authorization failures — the aligned family.
      expect(STABLE_ERROR_REGISTRY[code].layer).toBe('authorization');
    }
  });
});

// ─── (b) No remediation verb mutates state — structural + behavioural ─────────

describe('remediation is data, never a mutation', () => {
  it('SafeVerbs_AreDisjointFromStateMutationVerbs', () => {
    const safe = new Set<string>(SAFE_REMEDIATION_VERBS);
    for (const mutation of STATE_MUTATION_VERBS) {
      expect(safe.has(mutation)).toBe(false);
    }
    // request_waiver is safe (a request); grant_waiver would be a mutation.
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
    const remediationSource = readFileSync(new URL('./remediation.ts', import.meta.url), 'utf8');
    const explanationSource = readFileSync(
      new URL('./decision-explanation.ts', import.meta.url),
      'utf8',
    );

    const remediationVerdict = auditRemediationPurity('remediation.ts', remediationSource);
    const explanationVerdict = auditRemediationPurity(
      'decision-explanation.ts',
      explanationSource,
    );

    expect(remediationVerdict.forbidden).toEqual([]);
    expect(remediationVerdict.ok).toBe(true);
    expect(remediationVerdict.importCount).toBeGreaterThan(0);
    expect(explanationVerdict.forbidden).toEqual([]);
    expect(explanationVerdict.ok).toBe(true);
  });

  it('Structural_Census_ActuallyDetectsAForbiddenImport', () => {
    // The census must be able to FAIL — a stubbed detector that always passes
    // would be worthless. Feed it a module that reaches the event store.
    const tainted = [
      "import { AtomicAppender } from '../../events/atomic-appender.js';",
      "export const x = AtomicAppender;",
    ].join('\n');
    const verdict = auditRemediationPurity('tainted.ts', tainted);
    expect(verdict.ok).toBe(false);
    expect(verdict.forbidden.map((f) => f.marker)).toContain('event-store');
  });

  it('Structural_Census_IgnoresErasedTypeOnlyImports_ButCatchesValueImports', () => {
    // A type-only import of the mutator is erased at compile time — harmless.
    const typeOnly = "import type { TransitionDecided } from './transition-command.js';";
    expect(auditRemediationPurity('a.ts', typeOnly).ok).toBe(true);
    // A VALUE import of the same module could mutate — it must be caught.
    const valueImport = "import { runTransitionCommand } from './transition-command.js';";
    const verdict = auditRemediationPurity('a.ts', valueImport);
    expect(verdict.ok).toBe(false);
    expect(verdict.forbidden.map((f) => f.marker)).toContain('./transition-command');
  });

  it('Behavioural_RemediatingADenial_DoesNotMutateItsInputs', () => {
    const before = JSON.stringify(gateRequirement);
    const outcome = remediateDenial(input('failed', gateRequirement, false));
    // The requirement the remediation was derived from is untouched…
    expect(JSON.stringify(gateRequirement)).toBe(before);
    // …and the outcome is inert data (no functions to invoke an effect through).
    expect(typeof outcome).toBe('object');
    if (outcome.kind === 'action') {
      for (const value of Object.values(outcome.action)) {
        expect(typeof value).not.toBe('function');
      }
    }
  });
});

// ─── (c) Emitted next_actions validate against the LIVE schema ────────────────

describe('emitted next_actions conform to the live NextAction schema', () => {
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
    // The indeterminate retry verb also conforms.
    expect(() => NextAction.parse(remediateIndeterminate(phaseAttemptId))).not.toThrow();
  });

  it('LiveSchema_RejectsANonConformingAction_ProvingItIsTheRealGate', () => {
    // An empty idempotencyKey is rejected by the real schema (DR-MO-1); if our
    // "validation" were a stub this would pass. It must throw.
    expect(() =>
      NextAction.parse({ verb: 'run_gate', reason: 'x', idempotencyKey: '' }),
    ).toThrow();
    // A missing verb is rejected too.
    expect(() => NextAction.parse({ reason: 'x' })).toThrow();
  });
});

// ─── (d) Terminal reasons align to the stable registry ────────────────────────

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
