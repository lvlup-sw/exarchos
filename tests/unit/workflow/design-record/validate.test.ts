/**
 * Whole-plan witnesses use authored records and generated graphs as independent oracles.
 * @oracle-sources: ../../../../src/workflow/design-record/validate.ts, authored graphs and literal expected findings in this file
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readDesignRecord } from '../../../../src/workflow/design-record/read.js';
import type { DesignRecordSnapshot, DesignTask } from '../../../../src/workflow/design-record/schema.js';
import { validateDesignRecord } from '../../../../src/workflow/design-record/validate.js';
import { evaluatePlanCoverage } from '../../../../src/workflow/design-record/plan-checks.js';

function task(id: string, patch: Partial<DesignTask> = {}): DesignTask {
  return { id, title: 'Build the change', implements: ['DR-1'], blockedBy: [], files: [id + '.custom'],
    testFiles: [], riskTier: 'low', boundaryTouching: false, testLayer: 'unit', acceptance: ['Works.'],
    instructions: 'Build the change.', parallelizable: false, ...patch };
}
function snapshot(tasks: DesignTask[], requirements = ['DR-1'], headings = '### DR-1: Required'): DesignRecordSnapshot {
  const raw = `## Design & Rationale\n${headings}\n## Tasks\n\`\`\`exarchos-plan-v1\n${JSON.stringify({ version: 1, requirements, tasks })}\n\`\`\`\n`;
  const result = readDesignRecord(Buffer.from(raw), 'plan.md');
  if (result.kind !== 'typed') throw new Error(JSON.stringify(result));
  return result.snapshot;
}
function codes(record: DesignRecordSnapshot): string[] {
  return validateDesignRecord(record).findings.map(({ code }) => code);
}

describe('typed plan soundness', () => {
  it('Plan_CompletedDisconnectedCycle_Refuses', () => {
    const record = snapshot([task('ready'), task('completed-a', { blockedBy: ['completed-b'] }), task('completed-b', { blockedBy: ['completed-a'] })]);
    expect(validateDesignRecord(record)).toMatchObject({ passed: false, findings: [
      { code: 'DEPENDENCY_CYCLE', taskIds: ['completed-a', 'completed-b'] },
    ] });
  });
  it('Coverage_TitleMentionsDr_DoesNotCover', () => {
    const record = snapshot([task('T-01', { title: 'DR-1', implements: [], instructions: 'Implement DR-1.', acceptance: ['DR-1 works.'] })]);
    expect(codes(record)).toEqual(['UNIMPLEMENTED_REQUIREMENT']);
    expect(evaluatePlanCoverage(record).edges).toEqual([]);
  });
  it('keeps exact task identity and refuses unknown aliases', () => {
    expect(validateDesignRecord(snapshot([task('T-01'), task('T-1', { blockedBy: ['T-01'] })])).passed).toBe(true);
    expect(codes(snapshot([task('T-01', { blockedBy: ['t-01', 'T-1'] })]))).toEqual(['UNKNOWN_DEPENDENCY', 'UNKNOWN_DEPENDENCY']);
  });
  it('refuses self dependencies and disconnected cycles', () => {
    expect(codes(snapshot([task('T-01', { blockedBy: ['T-01'] })]))).toContain('SELF_DEPENDENCY');
    expect(codes(snapshot([task('a'), task('b', { blockedBy: ['c'] }), task('c', { blockedBy: ['b'] })]))).toContain('DEPENDENCY_CYCLE');
  });
  it('refuses missing, duplicate and unlisted definitions', () => {
    expect(codes(snapshot([task('a')], ['DR-1'], '### Other'))).toContain('MISSING_REQUIREMENT_DEFINITION');
    expect(codes(snapshot([task('a')], ['DR-1'], '### DR-1: One\n### DR-1: Two'))).toContain('DUPLICATE_REQUIREMENT');
    expect(codes(snapshot([task('a')], ['DR-1'], '### DR-1: One\n### DR-2: Two'))).toContain('UNLISTED_REQUIREMENT');
  });
  it('refuses unknown implements and prose deferral', () => {
    const record = snapshot([task('a', { implements: ['DR-2'], title: 'DR-1 Deferred' })]);
    expect(codes(record)).toEqual(['UNIMPLEMENTED_REQUIREMENT', 'UNKNOWN_IMPLEMENTS']);
  });
  it('Structure_HighRiskWithoutTests_Refuses', () => {
    const record = snapshot([task('a')]);
    expect(codes({ ...record, tasks: [{ ...record.tasks[0]!, riskTier: 'high' }] })).toContain('INVALID_TASK_STRUCTURE');
    expect(validateDesignRecord(snapshot([task('a', { riskTier: 'high', testFiles: ['tests/case.unusual'] })])).passed).toBe(true);
  });
  it('reuses the strict schema for empty files, instructions and acceptance', () => {
    const record = snapshot([task('a')]);
    for (const patch of [{ files: [] }, { instructions: ' ' }, { acceptance: [] }]) {
      expect(codes({ ...record, tasks: [{ ...record.tasks[0]!, ...patch }] })).toContain('INVALID_TASK_STRUCTURE');
    }
  });
  it('refuses duplicate task identities even for a constructed snapshot', () => {
    const record = snapshot([task('a')]);
    expect(codes({ ...record, tasks: [...record.tasks, ...record.tasks] })).toContain('DUPLICATE_TASK');
  });
  it('Parallel_SharedFile_Refuses', () => {
    const record = snapshot([task('a', { files: ['shared.unknown'], parallelizable: true }),
      task('b', { files: ['shared.unknown'], parallelizable: true, blockedBy: ['a'] })]);
    expect(validateDesignRecord(record)).toMatchObject({ passed: false, findings: [
      { code: 'PARALLEL_FILE_CONFLICT', taskIds: ['a', 'b'] },
    ] });
    expect(validateDesignRecord(snapshot([task('a', { parallelizable: true }), task('b', { parallelizable: true })])).passed).toBe(true);
  });
  it('sorts findings by code, source position and exact identity', () => {
    const record = snapshot([task('z', { blockedBy: ['missing-z'] }), task('a', { blockedBy: ['missing-a'], implements: [] })]);
    const result = validateDesignRecord(record);
    expect(result.findings.map(({ taskIds }) => taskIds)).toEqual([['z', 'missing-z'], ['a', 'missing-a']]);
    expect(validateDesignRecord({ ...record, tasks: [...record.tasks].reverse() })).toEqual(result);
    expect(result.findings[0]!.span).toEqual(record.tasks[0]!.span);
  });
  it('permuting generated DAGs preserves soundness and exact edges', () => {
    fc.assert(fc.property(fc.array(fc.nat({ max: 1000 }), { minLength: 2, maxLength: 25 }), (seeds) => {
      const tasks = seeds.map((seed, index) => task(`T-${index}`, { blockedBy: index ? [`T-${seed % index}`] : [] }));
      const record = snapshot(tasks);
      const reversed = { ...record, tasks: [...record.tasks].reverse() };
      expect(validateDesignRecord(record).passed).toBe(true);
      expect(validateDesignRecord(reversed)).toEqual(validateDesignRecord(record));
      expect(evaluatePlanCoverage(reversed).edges).toEqual(evaluatePlanCoverage(record).edges);
      expect(evaluatePlanCoverage(record).edges).toHaveLength(tasks.length);
    }), { seed: 1927, numRuns: 100 });
  });
  it('generated backedges outside the ready component always fail', () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 30 }), (count) => {
      const tasks = [task('ready'), ...Array.from({ length: count }, (_, i) => task(`done-${i}`, {
        blockedBy: [i === 0 ? `done-${count - 1}` : `done-${i - 1}`],
      }))];
      expect(codes(snapshot(tasks))).toContain('DEPENDENCY_CYCLE');
    }), { seed: 1928, numRuns: 100 });
  });
});
