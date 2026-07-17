import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prettyPrint, printError, toCliResult } from './cli-format.js';
import { toEnvelope } from '../format.js';
import type { Envelope, ToolResult } from '../format.js';
import type { NextAction } from '../next-action.js';

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

  it('PrettyPrint_DeeplyNestedTree_TruncatesAtMaxDepth', () => {
    const result = {
      success: true,
      data: { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } },
    };

    prettyPrint(result, 'tree');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).toContain('[...]');
    expect(stdoutOutput).not.toContain('deep');
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

// ─── toCliResult (Wave 0 D.2/D.3) ───────────────────────────────────────────

describe('toCliResult', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalOptOut: string | undefined;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Snapshot env var so each test starts clean and we restore in afterEach.
    originalOptOut = process.env.EXARCHOS_CLI_ENVELOPE;
    delete process.env.EXARCHOS_CLI_ENVELOPE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalOptOut === undefined) {
      delete process.env.EXARCHOS_CLI_ENVELOPE;
    } else {
      process.env.EXARCHOS_CLI_ENVELOPE = originalOptOut;
    }
  });

  it('toCliResult_JsonFormat_WritesEnvelopeOnStdout', () => {
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      _meta: {},
      _perf: { ms: 5, bytes: 100, tokens: 25 },
    };
    const env = toEnvelope(source);

    toCliResult(env, 'json');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).toBe(JSON.stringify(env, null, 2) + '\n');
    // Sidebars roll into the envelope under json — no stderr writes.
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('toCliResult_JsonFormat_ErrorEnvelopeOnStdout', () => {
    const source: ToolResult = {
      success: false,
      error: { code: 'INVALID_PHASE', message: 'Phase not found' },
      _meta: {},
      _perf: { ms: 2, bytes: 80, tokens: 20 },
    };
    const env = toEnvelope(source);

    toCliResult(env, 'json');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).toBe(JSON.stringify(env, null, 2) + '\n');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  // ─── #1448 item 3 — next_actions field integrity through one-shot dispatch ─
  //
  // Regression guard pinning that `next_actions` survives the one-shot
  // dispatch pipeline (`toEnvelope` → `toCliResult` → JSON on stdout). The
  // T3 investigation (Branch B, see
  // `docs/plans/archive/2026-05-16-correlation-consumer-wiring.md` Wave 1 Task 3)
  // established that NO production auto-dispatch handler exists; the
  // CLI / MCP adapter is the one-shot exit point and the caller
  // (orchestrator / agent harness) is the next_actions consumer. This
  // test pins the field-integrity contract at the caller boundary so
  // future refactors of `emitResult` / `toCliResult` / `toEnvelope`
  // cannot silently drop the hints. It is NOT an integration test of
  // auto-dispatch (which doesn't exist) — assertions are limited to
  // field presence and shape, not behavior.
  it('Cli_OneShotDispatch_PreservesNextActionsField', () => {
    const actions: NextAction[] = [
      {
        verb: 'merge_orchestrate',
        reason: 'worktree-bearing task.completed auto-detour',
        idempotencyKey: 'p2-detour:merge_orchestrate:001',
      },
      {
        verb: 'advance_phase',
        reason: 'gate passed',
        validTargets: ['delegate'],
        hint: 'orchestrator may auto-advance',
      },
    ];
    const source = {
      success: true,
      data: { phase: 'plan' },
      next_actions: actions,
      _meta: { featureId: 'feat-1' },
      _perf: { ms: 7, bytes: 32, tokens: 8 },
    } as unknown as ToolResult;

    const env = toEnvelope(source);
    // Stage 1 — envelope boundary preserves the hints intact (the same
    // contract `toEnvelope_SuccessWithNextActions_PreservesAffordances`
    // pins, repeated here so a failure isolates which seam regressed).
    expect(env.success).toBe(true);
    if (env.success) {
      expect((env as Envelope<unknown>).next_actions).toEqual(actions);
    }

    toCliResult(env, 'json');

    // Stage 2 — the one-shot CLI emit path writes the JSON envelope to
    // stdout with `next_actions` carried verbatim. Parse the actual
    // byte-output rather than re-inspecting `env` so the assertion pins
    // the on-the-wire contract a caller sees.
    const stdoutOutput = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(stdoutOutput).toBe(JSON.stringify(env, null, 2) + '\n');
    const parsed = JSON.parse(stdoutOutput.trim()) as {
      success: boolean;
      next_actions: NextAction[];
    };
    expect(parsed.success).toBe(true);
    expect(parsed.next_actions).toEqual(actions);
    // No stderr writes on the one-shot success path — diagnostics roll
    // into the envelope under json mode.
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('toCliResult_TableFormat_FailureWithWarnings_PreservesWarningsSidebar', () => {
    // INV-2 facade equivalence: when a handler fails, any `warnings` /
    // `_corrections` it attached must survive the round-trip through the
    // envelope wire shape so prettyPrint's stderr sidebar still renders.
    // The pre-#1369 envelopeToToolResult dropped them on the failure path,
    // so table/tree consumers silently lost diagnostics on errors
    // (CodeRabbit minor on PR #1369).
    const source: ToolResult = {
      success: false,
      error: { code: 'CONSTRAINT_VIOLATION', message: 'invariant tripped' },
      warnings: ['table-mode-warning-token'],
      _meta: {},
      _perf: { ms: 1, bytes: 10, tokens: 3 },
    };
    const env = toEnvelope(source);

    toCliResult(env, 'table');

    const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderrOutput).toContain('table-mode-warning-token');
  });

  it('toCliResult_TableFormat_DelegatesToPrettyPrint', () => {
    const source: ToolResult = {
      success: true,
      data: [
        { name: 'Alice', role: 'dev' },
        { name: 'Bob', role: 'designer' },
      ],
      _meta: {},
      _perf: { ms: 1, bytes: 10, tokens: 3 },
    };
    const env = toEnvelope(source);

    toCliResult(env, 'table');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    // Matches prettyPrint table rendering (header + rows, aligned)
    expect(stdoutOutput).toContain('name');
    expect(stdoutOutput).toContain('role');
    expect(stdoutOutput).toContain('Alice');
    expect(stdoutOutput).toContain('Bob');
    expect(stdoutOutput).toContain('designer');
    // Should NOT have emitted the full JSON envelope on stdout
    expect(stdoutOutput).not.toContain('"next_actions"');
  });

  it('toCliResult_TreeFormat_DelegatesToPrettyPrint', () => {
    const source: ToolResult = {
      success: true,
      data: { workflow: { phase: 'plan', tasks: { count: 3 } } },
      _meta: {},
      _perf: { ms: 1, bytes: 10, tokens: 3 },
    };
    const env = toEnvelope(source);

    toCliResult(env, 'tree');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(stdoutOutput).toContain('workflow');
    expect(stdoutOutput).toContain('phase');
    expect(stdoutOutput).toContain('plan');
    expect(stdoutOutput).not.toContain('"next_actions"');
  });

  it('toCliResult_EnvelopeOptOut_PreservesLegacyShape', () => {
    process.env.EXARCHOS_CLI_ENVELOPE = '0';
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      _meta: {},
      _perf: { ms: 5, bytes: 100, tokens: 25 },
    };
    const env = toEnvelope(source);

    toCliResult(env, 'json');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    // Legacy shape: data-only on stdout (no envelope wrapping)
    expect(stdoutOutput).toBe(JSON.stringify(source.data, null, 2) + '\n');
    // Sidebar _perf footer goes to stderr in legacy mode
    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrOutput).toContain('5ms | 100B | ~25 tokens');
  });

  it('toCliResult_EnvelopeOptOutOtherValue_EmitsEnvelope', () => {
    process.env.EXARCHOS_CLI_ENVELOPE = '1';
    const source: ToolResult = {
      success: true,
      data: { phase: 'ideate' },
      _meta: {},
      _perf: { ms: 5, bytes: 100, tokens: 25 },
    };
    const env = toEnvelope(source);

    toCliResult(env, 'json');

    const stdoutOutput = stdoutSpy.mock.calls.map(c => c[0]).join('');
    // Anything but exactly '0' means envelope behaviour preserved.
    expect(stdoutOutput).toBe(JSON.stringify(env, null, 2) + '\n');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
