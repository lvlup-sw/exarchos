/**
 * The doctor check that carries the ActionId closure verdict to a user.
 *
 * The roster characterization proves the check RUNS and stamps its identity.
 * That is not the same as proving it reports the verdict it reads, which is
 * the whole reason it exists — so each arm is driven here against a stubbed
 * evaluator, including the empty-denominator arm that a live tree cannot
 * produce on demand.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const collectLiveActionContractSubjects = vi.fn();
const evaluateCollectedActionContractClosure = vi.fn();

vi.mock('../../../../src/contract/action-contract-closure.js', () => ({
  collectLiveActionContractSubjects: (): unknown => collectLiveActionContractSubjects(),
  evaluateCollectedActionContractClosure: (subjects: unknown): unknown =>
    evaluateCollectedActionContractClosure(subjects),
}));

const { actionContractClosure } = await import(
  '../../../../src/verbs/doctor/checks/action-contract-closure.js'
);

const probes = {} as never;
const signal = new AbortController().signal;

function subjects(count: number): readonly { actionId: string }[] {
  return Array.from({ length: count }, (_, i) => ({ actionId: `tool.action-${i}` }));
}

describe('doctor check — action-contract closure', () => {
  beforeEach(() => {
    collectLiveActionContractSubjects.mockReset();
    evaluateCollectedActionContractClosure.mockReset();
  });

  it('ClosureCheck_ClosedTree_PassesAndNamesTheDenominator', async () => {
    collectLiveActionContractSubjects.mockReturnValue(subjects(124));
    evaluateCollectedActionContractClosure.mockReturnValue({
      closed: true,
      subjectCount: 124,
      findings: [],
    });

    const result = await actionContractClosure(probes, signal);

    expect(result.status).toBe('Pass');
    // The count is the point: a Pass that does not say how many actions it
    // judged is indistinguishable from a Pass over none.
    expect(result.message).toContain('124');
  });

  it('ClosureCheck_OpenTree_WarnsAndNamesTheOffendingActions', async () => {
    collectLiveActionContractSubjects.mockReturnValue(subjects(124));
    evaluateCollectedActionContractClosure.mockReturnValue({
      closed: false,
      subjectCount: 124,
      findings: [
        { actionId: 'exarchos_event.append', code: 'PROJECTION_DRIFT' },
        { actionId: 'exarchos_view.pipeline', code: 'OMITTED_DIMENSION' },
      ],
    });

    const result = await actionContractClosure(probes, signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('exarchos_event.append');
    expect(result.message).toContain('PROJECTION_DRIFT');
    expect(result.message).toContain('2 of 124');
  });

  it('ClosureCheck_ManyFindings_NamesSomeAndCountsTheRest', async () => {
    collectLiveActionContractSubjects.mockReturnValue(subjects(10));
    evaluateCollectedActionContractClosure.mockReturnValue({
      closed: false,
      subjectCount: 10,
      findings: Array.from({ length: 9 }, (_, i) => ({
        actionId: `tool.action-${i}`,
        code: 'PROJECTION_DRIFT',
      })),
    });

    const result = await actionContractClosure(probes, signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('+6 more');
  });

  it('ClosureCheck_EmptyDenominator_WarnsRatherThanPassing', async () => {
    // Zero subjects close vacuously. Reporting that as health is the exact
    // failure this arm exists to prevent, and a live tree cannot produce it
    // on demand — which is why it is stubbed rather than left uncovered.
    collectLiveActionContractSubjects.mockReturnValue([]);
    evaluateCollectedActionContractClosure.mockReturnValue({
      closed: true,
      subjectCount: 0,
      findings: [],
    });

    const result = await actionContractClosure(probes, signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('0 registered actions');
  });

  it('ClosureCheck_EvaluatorThrows_WarnsInsteadOfFailingDoctor', async () => {
    collectLiveActionContractSubjects.mockImplementation(() => {
      throw new Error('malformed contract on tool.action-3');
    });

    const result = await actionContractClosure(probes, signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('malformed contract on tool.action-3');
  });
});
