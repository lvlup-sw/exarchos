/**
 * Representative real-input kills: start from the live ActionId collection
 * and corrupt one representation. The evaluator must drop closure.
 */
import { describe, expect, it } from 'vitest';
import {
  collectLiveActionContractSubjects,
  collectedSubjectsCoverLiveDenominator,
  evaluateActionContractClosure,
  evaluateCollectedActionContractClosure,
  type ActionContractClosureSubject,
} from '../../src/contract/action-contract-closure.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function liveSubjects(): readonly ActionContractClosureSubject[] {
  const subjects = collectLiveActionContractSubjects();
  expect(subjects.length, 'live collector returned no ActionIds').toBeGreaterThan(0);
  expect(collectedSubjectsCoverLiveDenominator(subjects)).toBe(true);
  return subjects;
}

function codes(subjects: readonly ActionContractClosureSubject[]): string[] {
  return evaluateActionContractClosure({ subjects }).findings.map((finding) => finding.code);
}

describe('action-contract closure kill fixtures', () => {
  it('Closure_KillDescribe_DropsClosure', () => {
    const target = liveSubjects().find(
      (subject) =>
        subject.contract !== undefined &&
        (subject.projections ?? []).some((projection) => projection.name === 'describe'),
    );
    expect(target, 'live tree has no describe projection to drop').toBeDefined();

    const killed: ActionContractClosureSubject = {
      ...target!,
      projections: (target!.projections ?? []).map((projection) =>
        projection.name === 'describe' ? { name: projection.name } : projection,
      ),
    };
    const result = evaluateActionContractClosure({ subjects: [killed] });
    expect(result.closed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('PROJECTION_DRIFT');
  });

  it('Closure_KillStaleReference_DropsClosure', () => {
    const target = liveSubjects().find((subject) => isRecord(subject.contract));
    expect(target, 'live tree has no declared contract to stale').toBeDefined();

    const killed: ActionContractClosureSubject = {
      ...target!,
      contract: {
        ...(target!.contract as Record<string, unknown>),
        needs: { kind: 'declared', values: ['host:browser'] },
      },
    };
    const result = evaluateActionContractClosure({ subjects: [killed] });
    expect(result.closed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('STALE_REFERENCE');
  });

  it('Closure_KillAdmissionParity_DropsClosure', () => {
    const target = liveSubjects().find(
      (subject) => subject.advertised !== undefined && subject.executed !== undefined,
    );
    expect(target, 'live tree has no advertised/executed pair to disagree').toBeDefined();

    const executed = isRecord(target!.executed) ? target!.executed : {};
    const killed: ActionContractClosureSubject = {
      ...target!,
      executed: {
        ...executed,
        needs: { kind: 'declared', values: ['fs:read'] },
      },
    };
    const result = evaluateActionContractClosure({ subjects: [killed] });
    expect(result.closed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('PARITY_DISAGREEMENT');
  });

  it('Closure_NarrowedDenominator_Fails', () => {
    const subjects = liveSubjects();
    const narrowed = subjects.slice(1);
    expect(narrowed.length).toBeLessThan(subjects.length);
    expect(collectedSubjectsCoverLiveDenominator(narrowed)).toBe(false);

    const narrowedResult = evaluateCollectedActionContractClosure(narrowed);
    expect(narrowedResult.closed).toBe(false);
    expect(narrowedResult.findings.map((finding) => finding.code)).toContain('EMPTY_DENOMINATOR');

    const empty = evaluateCollectedActionContractClosure([]);
    expect(empty.closed).toBe(false);
    expect(empty.subjectCount).toBe(0);
    expect(empty.findings.map((finding) => finding.code)).toEqual(['EMPTY_DENOMINATOR']);
    expect(codes([])).toEqual(['EMPTY_DENOMINATOR']);
  });
});
