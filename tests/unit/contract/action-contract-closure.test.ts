import { fc } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  evaluateActionContractClosure,
  type ActionContractClosureFinding,
  type ActionContractClosureSubject,
} from '../../../src/contract/action-contract-closure.js';

const NONE = { kind: 'none' as const, because: 'read-only query has no additional obligations' };
const FIXED_NOW = new Date('2026-08-22T00:00:00.000Z');

function closedContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requires: NONE,
    ensures: NONE,
    needs: NONE,
    touches: { frame: 'single-machine', resources: NONE },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: NONE,
    ...overrides,
  };
}

const ALLOW_DIGEST = { algorithm: 'sha256' as const, value: 'a'.repeat(64) };

function allowDecision() {
  return { verdict: 'allow' as const, digest: ALLOW_DIGEST };
}

function subject(
  actionId: string,
  overrides: Partial<ActionContractClosureSubject> = {},
): ActionContractClosureSubject {
  return {
    actionId,
    contract: closedContract(),
    advertised: allowDecision(),
    executed: allowDecision(),
    ...overrides,
  };
}

function evaluate(subjects: readonly ActionContractClosureSubject[]) {
  return evaluateActionContractClosure({ subjects, now: FIXED_NOW });
}

function codes(findings: readonly ActionContractClosureFinding[]): string[] {
  return findings.map((finding) => finding.code);
}

describe('action-contract closure', () => {
  it('Closure_OmittedDimension_IsReported', () => {
    const { requires: _requires, ...rest } = closedContract();
    const result = evaluate([subject('exarchos_workflow.get', { contract: rest })]);
    expect(result.closed).toBe(false);
    expect(codes(result.findings)).toContain('OMITTED_DIMENSION');
    expect(result.findings.some((finding) => finding.dimension === 'requires')).toBe(true);
  });

  it('Closure_BlankAbstention_IsReported', () => {
    const result = evaluate([
      subject('exarchos_view.pipeline', {
        contract: closedContract({ emissions: { kind: 'none', because: '   ' } }),
      }),
    ]);
    expect(result.closed).toBe(false);
    expect(codes(result.findings)).toContain('BLANK_ABSTENTION');
    expect(result.findings.some((finding) => finding.dimension === 'emissions')).toBe(true);
  });

  it('Closure_StaleReference_IsReported', () => {
    const result = evaluate([
      subject('exarchos_orchestrate.spawn', {
        contract: closedContract({
          needs: { kind: 'declared', values: ['host:browser'] },
        }),
      }),
    ]);
    expect(result.closed).toBe(false);
    expect(codes(result.findings)).toContain('STALE_REFERENCE');
    expect(result.findings.some((finding) => finding.dimension === 'needs')).toBe(true);
  });

  it('Closure_RoleExpiryConflict_IsReported', () => {
    const result = evaluate([
      subject('exarchos_event.append', {
        contract: closedContract({
          emissions: {
            kind: 'declared',
            values: [
              {
                event: 'workflow.transitioned',
                condition: 'always',
                owner: 'exarchos_event.append',
                role: 'recovery',
                recoveryExpiresAt: '2020-01-01T00:00:00.000Z',
              },
            ],
          },
        }),
      }),
    ]);
    expect(result.closed).toBe(false);
    expect(codes(result.findings)).toContain('ROLE_EXPIRY_CONFLICT');
  });

  it('Closure_OrphanProjection_IsReported', () => {
    const result = evaluate([
      subject('exarchos_workflow.describe', {
        contract: undefined,
        projections: [{ name: 'compiler', contract: closedContract() }],
      }),
    ]);
    expect(result.closed).toBe(false);
    expect(codes(result.findings)).toContain('ORPHAN_PROJECTION');
  });

  it('Closure_ProjectionDrift_IsReported', () => {
    const result = evaluate([
      subject('exarchos_workflow.init', {
        contract: closedContract(),
        projections: [
          {
            name: 'describe',
            contract: closedContract({ requires: { kind: 'none', because: 'a different reason' } }),
          },
        ],
      }),
    ]);
    expect(result.closed).toBe(false);
    expect(codes(result.findings)).toContain('PROJECTION_DRIFT');
  });

  it('Closure_EmptyDenominator_Fails', () => {
    const result = evaluate([]);
    expect(result.closed).toBe(false);
    expect(result.subjectCount).toBe(0);
    expect(codes(result.findings)).toEqual(['EMPTY_DENOMINATOR']);
  });

  it('Closure_ParityDisagreement_IsReported', () => {
    const result = evaluate([
      subject('exarchos_view.status', {
        advertised: allowDecision(),
        executed: { verdict: 'deny', digest: ALLOW_DIGEST },
      }),
    ]);
    expect(result.closed).toBe(false);
    expect(codes(result.findings)).toContain('PARITY_DISAGREEMENT');
  });

  it('a well-formed subject closes', () => {
    const result = evaluate([subject('exarchos_view.pipeline')]);
    expect(result.closed).toBe(true);
    expect(result.subjectCount).toBe(1);
    expect(result.findings).toEqual([]);
  });
});

describe('action-contract closure properties', () => {
  const mixedSubjects: readonly ActionContractClosureSubject[] = [
    subject('exarchos_workflow.get', { contract: (({ requires: _r, ...rest }) => rest)(closedContract()) }),
    subject('exarchos_view.pipeline', {
      contract: closedContract({ ensures: { kind: 'none', because: '' } }),
    }),
    subject('exarchos_orchestrate.spawn', {
      contract: closedContract({ needs: { kind: 'declared', values: ['host:browser'] } }),
    }),
    subject('exarchos_event.append', {
      projections: [{ name: 'compiler', contract: closedContract({ replay: { kind: 'claim-required' } }) }],
    }),
    subject('exarchos_workflow.init', {
      advertised: allowDecision(),
      executed: { verdict: 'deny', digest: ALLOW_DIGEST },
    }),
    subject('exarchos_view.status'),
  ];

  it('input ordering does not change findings', () => {
    const canonical = evaluate(mixedSubjects).findings;
    expect(canonical.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.shuffledSubarray(mixedSubjects, { minLength: mixedSubjects.length }), (shuffled) => {
        expect(evaluate(shuffled).findings).toEqual(canonical);
      }),
      { numRuns: 25 },
    );
  });

  it('zero subjects never close', () => {
    fc.assert(
      fc.property(fc.constant([] as ActionContractClosureSubject[]), (subjects) => {
        const result = evaluate(subjects);
        expect(result.closed).toBe(false);
        expect(result.subjectCount).toBe(0);
        expect(codes(result.findings)).toContain('EMPTY_DENOMINATOR');
      }),
    );
    expect(evaluateActionContractClosure({ subjects: [] }).closed).toBe(false);
  });
});
