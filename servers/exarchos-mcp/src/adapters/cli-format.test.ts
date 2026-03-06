import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prettyPrint, printError } from './cli-format.js';

describe('prettyPrint', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PrettyPrint_SuccessResult_PrintsDataToStdout', () => {
    const result = { success: true, data: { phase: 'plan', status: 'active' } };

    prettyPrint(result);

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).toContain(JSON.stringify(result.data, null, 2));
  });

  it('PrettyPrint_ErrorResult_PrintsErrorToStderr', () => {
    const result = {
      success: false,
      error: { code: 'INVALID_PHASE', message: 'Phase not found' },
    };

    prettyPrint(result);

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).toContain('Error [INVALID_PHASE]: Phase not found');
    // stdout should NOT have data output
    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).not.toContain('Phase not found');
  });

  it('PrettyPrint_ErrorWithPerf_StillPrintsMetadata', () => {
    const result = Object.assign(
      { success: false, error: { code: 'FAIL', message: 'Oops' } },
      { _perf: { ms: 5, bytes: 50, tokens: 12 } },
    );

    prettyPrint(result);

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).toContain('Error [FAIL]: Oops');
    expect(stderrOutput).toContain('5ms | 50B | ~12 tokens');
  });

  it('PrettyPrint_WithWarnings_PrintsWarningsToStderr', () => {
    const result = {
      success: true,
      data: { ok: true },
      warnings: ['Something is deprecated', 'Use new API'],
    };

    prettyPrint(result);

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).toContain('! Something is deprecated');
    expect(stderrOutput).toContain('! Use new API');
  });

  it('PrettyPrint_WithPerf_PrintsFooterToStderr', () => {
    const result = Object.assign(
      { success: true, data: { ok: true } },
      { _perf: { ms: 11, bytes: 134, tokens: 34 } },
    );

    prettyPrint(result);

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).toContain('11ms | 134B | ~34 tokens');
  });

  it('PrettyPrint_WithEventHints_PrintsAdvisoryToStderr', () => {
    const result = Object.assign(
      { success: true, data: { ok: true } },
      {
        _eventHints: {
          missing: [{ eventType: 'review.started', description: 'Start review' }],
          phase: 'review',
          checked: 5,
        },
      },
    );

    prettyPrint(result);

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).toContain('Missing events for phase "review"');
    expect(stderrOutput).toContain('- review.started: Start review');
  });

  it('PrettyPrint_WithCheckpointAdvised_PrintsWarningToStderr', () => {
    const result = {
      success: true,
      data: { ok: true },
      _meta: { checkpointAdvised: true },
    };

    prettyPrint(result);

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).toContain('Checkpoint advised');
    expect(stderrOutput).toContain('exarchos wf checkpoint');
  });

  it('PrettyPrint_WithCorrections_PrintsNoticeToStderr', () => {
    const result = Object.assign(
      { success: true, data: { ok: true } },
      {
        _corrections: {
          applied: [
            { param: 'limit', value: 50, rule: 'exarchos_event:query:limit' },
          ],
        },
      },
    );

    prettyPrint(result);

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).toContain('Auto-corrections applied');
    expect(stderrOutput).toContain('limit: exarchos_event:query:limit');
  });

  it('PrettyPrint_TableFormat_PrintsAlignedColumns', () => {
    const result = {
      success: true,
      data: [
        { name: 'Alice', role: 'dev' },
        { name: 'Bob', role: 'designer' },
      ],
    };

    prettyPrint(result, 'table');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    // Should have header and rows with aligned columns
    expect(stdoutOutput).toContain('name');
    expect(stdoutOutput).toContain('role');
    expect(stdoutOutput).toContain('Alice');
    expect(stdoutOutput).toContain('Bob');
    expect(stdoutOutput).toContain('designer');
  });

  it('PrettyPrint_TreeFormat_PrintsNestedIndentation', () => {
    const result = {
      success: true,
      data: { workflow: { phase: 'plan', tasks: { count: 3 } } },
    };

    prettyPrint(result, 'tree');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).toContain('workflow');
    expect(stdoutOutput).toContain('phase');
    expect(stdoutOutput).toContain('plan');
  });

  it('PrettyPrint_TableFormatNonTabular_FallsBackToJson', () => {
    const result = { success: true, data: 'just a string' };

    prettyPrint(result, 'table');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).toContain('"just a string"');
  });

  it('PrettyPrint_InferredFormat_ArrayBecomesTable', () => {
    const result = {
      success: true,
      data: [
        { id: 1, name: 'task1' },
        { id: 2, name: 'task2' },
      ],
    };

    prettyPrint(result);

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    // Should infer table format for arrays of objects
    expect(stdoutOutput).toContain('id');
    expect(stdoutOutput).toContain('name');
    expect(stdoutOutput).toContain('task1');
  });

  it('PrettyPrint_InferredFormat_NestedObjectBecomesTree', () => {
    const result = {
      success: true,
      data: { level1: { level2: { value: 42 } } },
    };

    prettyPrint(result);

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).toContain('level1');
    expect(stdoutOutput).toContain('level2');
    expect(stdoutOutput).toContain('42');
  });
});

describe('printError', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PrintError_BasicError_PrintsCodeAndMessage', () => {
    printError({ code: 'NOT_FOUND', message: 'Workflow not found' });

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Error [NOT_FOUND]: Workflow not found');
  });

  it('PrintError_WithValidTargets_ShowsTargets', () => {
    printError({
      code: 'INVALID_TRANSITION',
      message: 'Cannot transition',
      validTargets: ['plan', 'review'],
    });

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Valid targets: plan, review');
  });

  it('PrintError_WithSuggestedFix_ShowsFixWithFlags', () => {
    printError({
      code: 'MISSING_FIELD',
      message: 'Field required',
      suggestedFix: { tool: 'workflow', params: { action: 'set', field: 'phase' } },
    });

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Suggested fix: exarchos workflow');
    expect(output).toContain('--action set');
    expect(output).toContain('--field phase');
  });
});
