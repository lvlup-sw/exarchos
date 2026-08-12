import { describe, it, expect } from 'vitest';
import { parseTaskStamps, stampForTask } from './parse-task-stamps.js';

describe('parseTaskStamps', () => {
  it('ParseTaskStamps_HighBoundarySingleLine_LiftsBothStamps', () => {
    const md = [
      '## Decomposition',
      '### Tasks',
      '#### Task 001: Wrap the prune-executor remove path',
      '**Risk Tier:** high · **Boundary Touching:** true',
      '**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/manager.ts`',
      '**Dependencies:** None · **Parallelizable:** Yes',
    ].join('\n');
    const [task] = parseTaskStamps(md);
    expect(task.id).toBe('001');
    expect(task.riskTier).toBe('high');
    expect(task.boundaryTouching).toBe(true);
    expect(task.files).toContain('servers/exarchos-mcp/src/orchestrate/worktree/manager.ts');
    expect(task.blockedBy).toEqual([]);
  });

  it('ParseTaskStamps_RiskTierOnly_LeavesBoundaryUndefined', () => {
    const md = ['#### Task 003: Burst stagger', '**Risk Tier:** medium'].join('\n');
    const [task] = parseTaskStamps(md);
    expect(task.riskTier).toBe('medium');
    expect(task.boundaryTouching).toBeUndefined();
  });

  it('ParseTaskStamps_CamelCaseSpelling_Parsed', () => {
    const md = ['#### Task 5: Something', '**riskTier:** low'].join('\n');
    expect(parseTaskStamps(md)[0].riskTier).toBe('low');
  });

  it('ParseTaskStamps_ThreeHashHeader_AlsoParsed', () => {
    const md = ['### Task 1: Legacy header', '**Risk Tier:** high'].join('\n');
    const tasks = parseTaskStamps(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].riskTier).toBe('high');
  });

  it('ParseTaskStamps_ExplicitBoundaryFalse_CapturedAsFalse', () => {
    const md = ['#### Task 2: x', '**Risk Tier:** medium', '**Boundary Touching:** false'].join('\n');
    expect(parseTaskStamps(md)[0].boundaryTouching).toBe(false);
  });

  it('ParseTaskStamps_TestLayerStamp_Parsed', () => {
    const md = ['#### Task 2: x', '**Risk Tier:** high', '**Test Layer:** integration'].join('\n');
    expect(parseTaskStamps(md)[0].testLayer).toBe('integration');
  });

  it('ParseTaskStamps_BulletFileList_ExtractedViaProductionExtractor', () => {
    const md = [
      '#### Task 001: x',
      '**Risk Tier:** medium',
      '**Files:**',
      '- `servers/exarchos-mcp/src/events/schemas.ts`',
      '- `servers/exarchos-mcp/src/events/schemas.test.ts`',
      '**Dependencies:** None',
    ].join('\n');
    const [task] = parseTaskStamps(md);
    expect(task.files).toEqual([
      'servers/exarchos-mcp/src/events/schemas.ts',
      'servers/exarchos-mcp/src/events/schemas.test.ts',
    ]);
  });

  it('ParseTaskStamps_MalformedTierValue_FallsThroughToUndefined', () => {
    // `low-priority` must NOT read as `low` — a malformed stamp should fall
    // through to heuristic derivation, not silently misclassify.
    const md = ['#### Task 9: x', '**Risk Tier:** low-priority'].join('\n');
    expect(parseTaskStamps(md)[0].riskTier).toBeUndefined();
  });

  it('ParseTaskStamps_SectionHeaderEndsBlock_StampsDoNotBleed', () => {
    const md = [
      '#### Task 001: first',
      '**Risk Tier:** low',
      '## Appendix',
      '**Risk Tier:** high — narrative mention, not a task stamp',
    ].join('\n');
    const tasks = parseTaskStamps(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].riskTier).toBe('low');
  });

  it('ParseTaskStamps_TasksSectionHeader_NotParsedAsTask', () => {
    // `### Tasks` (plural, no id) is a section header, not a task.
    const md = ['### Tasks', '#### Task 001: real', '**Risk Tier:** medium'].join('\n');
    const tasks = parseTaskStamps(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('001');
  });

  it('ParseTaskStamps_MultipleTasks_EachBlockScopedIndependently', () => {
    const md = [
      '#### Task 001: a',
      '**Risk Tier:** high · **Boundary Touching:** true',
      '#### Task 002: b',
      '**Risk Tier:** low',
    ].join('\n');
    const tasks = parseTaskStamps(md);
    expect(tasks.map((t) => t.riskTier)).toEqual(['high', 'low']);
    expect(tasks.map((t) => t.boundaryTouching)).toEqual([true, undefined]);
  });
});

describe('stampForTask', () => {
  const stamps = parseTaskStamps(
    ['#### Task 001: a', '**Risk Tier:** high', '#### Task 012: b', '**Risk Tier:** medium'].join('\n'),
  );

  it('StampForTask_CanonicalIdMatch_MatchesAcrossSpellings', () => {
    expect(stampForTask(stamps, 'task-001')?.riskTier).toBe('high');
    expect(stampForTask(stamps, 'T001')?.riskTier).toBe('high');
    expect(stampForTask(stamps, '001')?.riskTier).toBe('high');
    expect(stampForTask(stamps, 'Task 012')?.riskTier).toBe('medium');
  });

  it('StampForTask_UnknownId_ReturnsUndefined', () => {
    expect(stampForTask(stamps, '999')).toBeUndefined();
  });
});
