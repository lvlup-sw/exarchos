// ─── Provenance Chain Action Tests ──────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock pure TS provenance-chain module ───────────────────────────────────

vi.mock('../../../../src/orchestrate/provenance-chain.js', () => ({
  verifyProvenanceChain: vi.fn(),
}));

// ─── Mock event store and gate utils ────────────────────────────────────────

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: vi.fn(() => ({})),
}));

vi.mock('./gate-utils.js', () => ({
  emitGateEvent: vi.fn(async () => {}),
}));

import { verifyProvenanceChain } from '../../../../src/orchestrate/provenance-chain.js';
import { emitGateEvent } from './gate-utils.js';
import { handleProvenanceChain } from './provenance-chain.js';

const mockedVerify = vi.mocked(verifyProvenanceChain);
const mockedEmitGateEvent = vi.mocked(emitGateEvent);

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('handleProvenanceChain', () => {
  const stateDir = '/tmp/test-state';

  it('should reject missing featureId', async () => {
    const result = await handleProvenanceChain(
      { featureId: '', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });

  it('should reject missing designPath', async () => {
    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '', planPath: '/tmp/plan.md' },
      stateDir,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('designPath');
  });

  it('should reject missing planPath', async () => {
    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '' },
      stateDir,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('planPath');
  });

  it('should return passed:true when provenance chain passes', async () => {
    // Arrange
    mockedVerify.mockReturnValueOnce({
      status: 'pass',
      output: '## Provenance Chain Report\n### Summary\n- Requirements: 3\n- Covered: 3\n- Gaps: 0\n- Orphan refs: 0\n**Result: PASS**',
      requirements: 3,
      covered: 3,
      gaps: 0,
      orphanRefs: 0,
      gapDetails: [],
      orphanDetails: [],
    });

    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      passed: true,
      coverage: {
        requirements: 3,
        covered: 3,
        gaps: 0,
        orphanRefs: 0,
      },
    });
    expect(result.data?.report).toContain('PASS');
  });

  it('should return passed:false when gaps are found', async () => {
    // Arrange
    mockedVerify.mockReturnValueOnce({
      status: 'fail',
      output: '## Provenance Chain Report\n### Summary\n- Requirements: 3\n- Covered: 2\n- Gaps: 1\n- Orphan refs: 0\n**Result: FAIL**',
      requirements: 3,
      covered: 2,
      gaps: 1,
      orphanRefs: 0,
      gapDetails: ['DR-3'],
      orphanDetails: [],
    });

    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      passed: false,
      coverage: {
        requirements: 3,
        covered: 2,
        gaps: 1,
        orphanRefs: 0,
      },
    });
  });

  it('should return error when provenance check has error status', async () => {
    // Arrange — error status (e.g. missing file, no DR-N identifiers)
    mockedVerify.mockReturnValueOnce({
      status: 'error',
      output: '',
      error: 'No DR-N identifiers found in design document',
      requirements: 0,
      covered: 0,
      gaps: 0,
      orphanRefs: 0,
      gapDetails: [],
      orphanDetails: [],
    });

    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROVENANCE_ERROR');
    expect(result.error?.message).toContain('DR-N');
  });

  it('should emit gate.executed event with dimension D1', async () => {
    // Arrange
    mockedVerify.mockReturnValueOnce({
      status: 'pass',
      output: '## Provenance Chain Report\n### Summary\n- Requirements: 2\n- Covered: 2\n- Gaps: 0\n- Orphan refs: 0\n**Result: PASS**',
      requirements: 2,
      covered: 2,
      gaps: 0,
      orphanRefs: 0,
      gapDetails: [],
      orphanDetails: [],
    });

    await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    expect(mockedEmitGateEvent).toHaveBeenCalledWith(
      expect.anything(),
      'test-feat',
      'provenance-chain',
      'planning',
      true,
      expect.objectContaining({
        dimension: 'D1',
        requirements: 2,
        covered: 2,
        gaps: 0,
        orphanRefs: 0,
      }),
    );
  });

  it('handleProvenanceChain_EmitsGateEvent_IncludesPhasePlanInDetails', async () => {
    // Arrange
    mockedVerify.mockReturnValueOnce({
      status: 'pass',
      output: '## Provenance Chain Report\n### Summary\n- Requirements: 2\n- Covered: 2\n- Gaps: 0\n- Orphan refs: 0\n**Result: PASS**',
      requirements: 2,
      covered: 2,
      gaps: 0,
      orphanRefs: 0,
      gapDetails: [],
      orphanDetails: [],
    });

    // Act
    await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    // Assert
    expect(mockedEmitGateEvent).toHaveBeenCalledWith(
      expect.anything(),
      'test-feat',
      'provenance-chain',
      'planning',
      true,
      expect.objectContaining({
        phase: 'plan',
      }),
    );
  });

  it('should be resilient to gate emission failure', async () => {
    // Arrange
    mockedVerify.mockReturnValueOnce({
      status: 'pass',
      output: '## Provenance Chain Report\n### Summary\n- Requirements: 1\n- Covered: 1\n- Gaps: 0\n- Orphan refs: 0\n**Result: PASS**',
      requirements: 1,
      covered: 1,
      gaps: 0,
      orphanRefs: 0,
      gapDetails: [],
      orphanDetails: [],
    });
    mockedEmitGateEvent.mockRejectedValueOnce(new Error('Store failure'));

    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    expect(result.success).toBe(true);
    expect(result.data?.passed).toBe(true);
  });

  it('should report orphan refs from the TS result', async () => {
    // Arrange
    mockedVerify.mockReturnValueOnce({
      status: 'fail',
      output: '## Provenance Chain Report\n### Summary\n- Requirements: 2\n- Covered: 2\n- Gaps: 0\n- Orphan refs: 3\n**Result: FAIL**',
      requirements: 2,
      covered: 2,
      gaps: 0,
      orphanRefs: 3,
      gapDetails: [],
      orphanDetails: ['DR-99 (in Task 1)', 'DR-100 (in Task 2)', 'DR-101 (in Task 3)'],
    });

    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    expect(result.success).toBe(true);
    expect(result.data?.coverage.orphanRefs).toBe(3);
  });
});
