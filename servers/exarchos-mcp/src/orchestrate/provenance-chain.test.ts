import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleProvenanceChain } from './provenance-chain.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: vi.fn(() => ({})),
}));

vi.mock('./gate-utils.js', () => ({
  emitGateEvent: vi.fn(async () => {}),
}));

import { execSync } from 'node:child_process';
import { emitGateEvent } from './gate-utils.js';

const mockedExecSync = vi.mocked(execSync);
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

  it('should return passed:true when script exits 0', async () => {
    const report = [
      '## Provenance Chain Report',
      '### Summary',
      '- Requirements: 3',
      '- Covered: 3',
      '- Gaps: 0',
      '- Orphan refs: 0',
      '**Result: PASS**',
    ].join('\n');

    mockedExecSync.mockReturnValueOnce(Buffer.from(report));

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

  it('should return passed:false when script exits 1 (gaps found)', async () => {
    const report = [
      '## Provenance Chain Report',
      '### Summary',
      '- Requirements: 3',
      '- Covered: 2',
      '- Gaps: 1',
      '- Orphan refs: 0',
      '**Result: FAIL**',
    ].join('\n');

    const execError = new Error('Script exited with 1') as Error & {
      status: number;
      stdout: Buffer;
      stderr: Buffer;
    };
    execError.status = 1;
    execError.stdout = Buffer.from(report);
    execError.stderr = Buffer.from('');
    mockedExecSync.mockImplementationOnce(() => {
      throw execError;
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

  it('should return SCRIPT_ERROR on exit code 2 (usage error)', async () => {
    const execError = new Error('Script exited with 2') as Error & {
      status: number;
      stdout: Buffer;
      stderr: Buffer;
    };
    execError.status = 2;
    execError.stdout = Buffer.from('');
    execError.stderr = Buffer.from('Error: No DR-N identifiers found');
    mockedExecSync.mockImplementationOnce(() => {
      throw execError;
    });

    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SCRIPT_ERROR');
    expect(result.error?.message).toContain('DR-N');
  });

  it('should emit gate.executed event with dimension D1', async () => {
    const report = [
      '## Provenance Chain Report',
      '### Summary',
      '- Requirements: 2',
      '- Covered: 2',
      '- Gaps: 0',
      '- Orphan refs: 0',
      '**Result: PASS**',
    ].join('\n');

    mockedExecSync.mockReturnValueOnce(Buffer.from(report));

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
    const report = [
      '## Provenance Chain Report',
      '### Summary',
      '- Requirements: 2',
      '- Covered: 2',
      '- Gaps: 0',
      '- Orphan refs: 0',
      '**Result: PASS**',
    ].join('\n');

    mockedExecSync.mockReturnValueOnce(Buffer.from(report));

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
    const report = [
      '## Provenance Chain Report',
      '### Summary',
      '- Requirements: 1',
      '- Covered: 1',
      '- Gaps: 0',
      '- Orphan refs: 0',
      '**Result: PASS**',
    ].join('\n');

    mockedExecSync.mockReturnValueOnce(Buffer.from(report));
    mockedEmitGateEvent.mockRejectedValueOnce(new Error('Store failure'));

    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    expect(result.success).toBe(true);
    expect(result.data?.passed).toBe(true);
  });

  it('should parse orphan refs from report', async () => {
    const report = [
      '## Provenance Chain Report',
      '### Summary',
      '- Requirements: 2',
      '- Covered: 2',
      '- Gaps: 0',
      '- Orphan refs: 3',
      '**Result: FAIL**',
    ].join('\n');

    const execError = new Error('Script exited with 1') as Error & {
      status: number;
      stdout: Buffer;
      stderr: Buffer;
    };
    execError.status = 1;
    execError.stdout = Buffer.from(report);
    execError.stderr = Buffer.from('');
    mockedExecSync.mockImplementationOnce(() => {
      throw execError;
    });

    const result = await handleProvenanceChain(
      { featureId: 'test-feat', designPath: '/tmp/design.md', planPath: '/tmp/plan.md' },
      stateDir,
    );

    expect(result.success).toBe(true);
    expect(result.data?.coverage.orphanRefs).toBe(3);
  });
});
