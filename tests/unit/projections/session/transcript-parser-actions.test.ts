/**
 * The four fields that the session event of an Exarchos call records: its action, its workflow, its failure and its `tool_use` id.
 *
 * Each case writes its transcript lines by hand, in the form that Claude Code records them.
 * A recorded Exarchos result has a string content, and a client refusal has `is_error: true`.
 * A native call and a call to another MCP server carry none of the four fields, and the summary line keeps its shape.
 *
 * @oracle-sources: ../../../../src/projections/session/transcript-parser.ts, the transcript lines and the expected fields that the test writes by hand
 */
import { describe, expect, it } from 'vitest';

import {
  buildSessionSummary,
  extractToolCalls,
} from '../../../../src/projections/session/transcript-parser.js';
import type { SessionMetadata, SessionToolEvent } from '../../../../src/projections/session/types.js';

/** The metadata of each parse. It names no workflow, so no event gets a `wid`. */
const SESSION: SessionMetadata = { sessionId: 'sess-actions' };

/** The workflow tool of the Exarchos plugin, as a transcript names it. */
const WORKFLOW_TOOL = 'mcp__plugin_exarchos_exarchos__exarchos_workflow';

/** The orchestrate tool of the standalone Exarchos server, as a transcript names it. */
const ORCHESTRATE_TOOL = 'mcp__exarchos__exarchos_orchestrate';

/** The event tool of the Exarchos plugin, as a transcript names it. */
const EVENT_TOOL = 'mcp__plugin_exarchos_exarchos__exarchos_event';

/** The four fields that only the event of an Exarchos call carries. */
const EXARCHOS_CALL_FIELDS: readonly string[] = ['action', 'featureId', 'failed', 'toolUseId'];

/** One assistant line that holds one `tool_use` block. */
function toolUseLine(id: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `a-${id}`,
    timestamp: '2026-11-06T10:00:00.000Z',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  };
}

/** One user line that holds the `tool_result` block of one call, with the result fields that the case gives. */
function toolResultLine(toolUseId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'user',
    uuid: `u-${toolUseId}`,
    timestamp: '2026-11-06T10:00:01.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, ...fields }] },
  };
}

/** Parses the lines and returns their one tool event. It fails the case when the lines give another count. */
function onlyEvent(lines: readonly unknown[]): SessionToolEvent {
  const events = extractToolCalls([...lines], SESSION);
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error('the lines give no tool event');
  return event;
}

describe('TranscriptParserActions', () => {
  it('ExtractToolCalls_AnExarchosCall_RecordsItsActionAndFeatureId', () => {
    const event = onlyEvent([
      toolUseLine('toolu_get01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a', query: 'phase' }),
      toolResultLine('toolu_get01', { content: '{"success":true,"data":{"phase":"plan"}}' }),
    ]);

    expect(event.cat).toBe('mcp_exarchos');
    expect(event.action).toBe('get');
    expect(event.featureId).toBe('feat-a');
    expect(event).not.toHaveProperty('failed');
  });

  it('ExtractToolCalls_AnExarchosCall_RecordsItsToolUseId', () => {
    const events = extractToolCalls(
      [
        toolUseLine('toolu_01AaaFirst', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }),
        toolResultLine('toolu_01AaaFirst', { content: '{"success":true}' }),
        toolUseLine('toolu_01BbbSecond', ORCHESTRATE_TOOL, { action: 'settle', streamId: 'feat-a' }),
        toolResultLine('toolu_01BbbSecond', { content: '{"success":true}' }),
      ],
      SESSION,
    );

    expect(events.map((event) => event.toolUseId)).toEqual(['toolu_01AaaFirst', 'toolu_01BbbSecond']);
  });

  /** A twin of the case of an error result. A call with no `tool_result` has no outcome, so it is not failed. */
  it('ExtractToolCalls_ACallWithNoResult_IsNotMarkedFailed', () => {
    const event = onlyEvent([toolUseLine('toolu_open01', ORCHESTRATE_TOOL, { action: 'settle', streamId: 'feat-a' })]);

    expect(event.cat).toBe('mcp_exarchos');
    expect(event.outB).toBe(0);
    expect(event).not.toHaveProperty('failed');
  });

  it('ExtractToolCalls_AnEventAppend_TakesTheWorkflowFromItsStream', () => {
    const event = onlyEvent([
      toolUseLine('toolu_append01', EVENT_TOOL, {
        action: 'append',
        stream: 'feat-b',
        event: { type: 'task.progressed', data: { taskId: 't1' } },
      }),
      toolResultLine('toolu_append01', { content: '{"success":true}' }),
    ]);

    expect(event.action).toBe('append');
    expect(event.featureId).toBe('feat-b');
  });

  it('ExtractToolCalls_APrepareCall_TakesTheWorkflowFromItsStreamId', () => {
    const event = onlyEvent([
      toolUseLine('toolu_prepare01', ORCHESTRATE_TOOL, { action: 'prepare', streamId: 'feat-c', repoRoot: '/repo' }),
      toolResultLine('toolu_prepare01', { content: '{"success":true}' }),
    ]);

    expect(event.action).toBe('prepare');
    expect(event.featureId).toBe('feat-c');
  });

  /** The content of a client refusal is not an envelope. The `is_error` flag alone marks the call failed. */
  it('ExtractToolCalls_AnErrorResult_MarksTheCallFailed', () => {
    const event = onlyEvent([
      toolUseLine('toolu_refused01', WORKFLOW_TOOL, { action: 'get' }),
      toolResultLine('toolu_refused01', {
        content: '<tool_use_error>InputValidationError: featureId is required</tool_use_error>',
        is_error: true,
      }),
    ]);

    expect(event.failed).toBe(true);
  });

  /** The result has a string content and no `is_error`, the form of a recorded result. */
  it('ExtractToolCalls_AStringEnvelopeWithSuccessFalse_MarksTheCallFailed', () => {
    const event = onlyEvent([
      toolUseLine('toolu_missing01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-gone' }),
      toolResultLine('toolu_missing01', {
        content: '{"success":false,"error":{"code":"STATE_NOT_FOUND","message":"No workflow feat-gone"}}',
      }),
    ]);

    expect(event.failed).toBe(true);
  });

  /** The envelope is the text of the first text block of the list. A block of another type before it does not count. */
  it('ExtractToolCalls_AListEnvelopeWithSuccessFalse_MarksTheCallFailed', () => {
    const event = onlyEvent([
      toolUseLine('toolu_list01', WORKFLOW_TOOL, { action: 'nope', featureId: 'feat-a' }),
      toolResultLine('toolu_list01', {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
          { type: 'text', text: '{"success":false,"error":{"code":"UNKNOWN_ACTION"}}' },
          { type: 'text', text: '{"success":true}' },
        ],
      }),
    ]);

    expect(event.failed).toBe(true);
  });

  /** A twin of the case that records the action and the workflow. The inputs hold workflow fields, and the results fail. */
  it('ExtractToolCalls_ANativeCall_CarriesNoneOfTheFourFields', () => {
    const events = extractToolCalls(
      [
        toolUseLine('toolu_read01', 'Read', { file_path: '/tmp/a.ts', action: 'get', featureId: 'feat-a' }),
        toolResultLine('toolu_read01', { content: '{"success":false}', is_error: true }),
        toolUseLine('toolu_github01', 'mcp__plugin_github_github__get_me', { action: 'get', streamId: 'feat-a' }),
        toolResultLine('toolu_github01', { content: '{"success":false}', is_error: true }),
      ],
      SESSION,
    );

    expect(events.map((event) => event.cat)).toEqual(['native', 'mcp_other']);
    expect(events.flatMap((event) => Object.keys(event).filter((key) => EXARCHOS_CALL_FIELDS.includes(key)))).toEqual([]);
  });

  /** A twin of the case that records the action and the workflow. The summary counts each tool by name, as before. */
  it('BuildSessionSummary_TheToolCounts_KeepTheirShape', () => {
    const toolEvents = extractToolCalls(
      [
        toolUseLine('toolu_sum01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }),
        toolResultLine('toolu_sum01', { content: '{"success":false}', is_error: true }),
        toolUseLine('toolu_sum02', WORKFLOW_TOOL, { action: 'set', featureId: 'feat-a' }),
        toolResultLine('toolu_sum02', { content: '{"success":true}' }),
        toolUseLine('toolu_sum03', 'Read', { file_path: '/tmp/a.ts' }),
        toolResultLine('toolu_sum03', { content: 'export {};' }),
      ],
      SESSION,
    );

    const summary = buildSessionSummary(toolEvents, [], SESSION);

    expect(summary.tools).toEqual({ [WORKFLOW_TOOL]: 2, Read: 1 });
    expect(summary.files).toEqual(['/tmp/a.ts']);
    expect(Object.keys(summary)).toEqual(['t', 'ts', 'sid', 'tools', 'tokTotal', 'files', 'dur', 'turns']);
  });
});
