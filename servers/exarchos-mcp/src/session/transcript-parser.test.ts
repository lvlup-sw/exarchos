import { describe, it, expect } from 'vitest';
import { test as fcTest } from '@fast-check/vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionToolEvent, SessionTurnEvent, SessionMetadata } from './types.js';

const FIXTURE_PATH = path.resolve(import.meta.dirname, '__fixtures__', 'sample-transcript.jsonl');

async function loadFixtureLines(): Promise<unknown[]> {
  const content = await fs.readFile(FIXTURE_PATH, 'utf-8');
  return content
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('Transcript Parser — Tool Call Extraction', () => {
  it('extractToolCalls_SingleToolUse_ReturnsOneToolEvent', async () => {
    const { extractToolCalls } = await import('./transcript-parser.js');
    const lines: unknown[] = [
      {
        sessionId: 'sess-1',
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-02-24T10:00:01.000Z',
        message: {
          model: 'claude-opus-4-6',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_001',
              name: 'Write',
              input: { file_path: '/tmp/hello.ts', content: 'hello' },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
      {
        sessionId: 'sess-1',
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-02-24T10:00:02.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_001', content: 'File written successfully' },
          ],
        },
      },
    ];

    const metadata: SessionMetadata = { sessionId: 'sess-1' };
    const events = extractToolCalls(lines, metadata);

    expect(events).toHaveLength(1);
    expect(events[0].t).toBe('tool');
    expect(events[0].tool).toBe('Write');
    expect(events[0].sid).toBe('sess-1');
  });

  it('extractToolCalls_MultipleToolUses_ReturnsAllToolEvents', async () => {
    const { extractToolCalls } = await import('./transcript-parser.js');
    const lines = await loadFixtureLines();
    const metadata: SessionMetadata = { sessionId: 'test-session' };
    const events = extractToolCalls(lines, metadata);

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.tool)).toEqual([
      'Write',
      'Read',
      'mcp__plugin_exarchos_exarchos__exarchos_workflow',
    ]);
  });

  it('extractToolCalls_ToolUseWithFileInput_ExtractsFilePaths', async () => {
    const { extractToolCalls } = await import('./transcript-parser.js');
    const lines = await loadFixtureLines();
    const metadata: SessionMetadata = { sessionId: 'test-session' };
    const events = extractToolCalls(lines, metadata);

    // Write tool has file_path in input
    const writeEvent = events.find((e) => e.tool === 'Write');
    expect(writeEvent).toBeDefined();
    expect(writeEvent!.files).toContain('/tmp/hello.ts');

    // Read tool also has file_path
    const readEvent = events.find((e) => e.tool === 'Read');
    expect(readEvent).toBeDefined();
    expect(readEvent!.files).toContain('/tmp/hello.ts');
  });

  it('extractToolCalls_MissingToolResult_SkipsGracefully', async () => {
    const { extractToolCalls } = await import('./transcript-parser.js');
    const lines: unknown[] = [
      {
        sessionId: 'sess-1',
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-02-24T10:00:01.000Z',
        message: {
          model: 'claude-opus-4-6',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_orphan',
              name: 'Bash',
              input: { command: 'echo hello' },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
      // No user entry with tool_result for toolu_orphan
    ];

    const metadata: SessionMetadata = { sessionId: 'sess-1' };
    const events = extractToolCalls(lines, metadata);

    // Should still produce a tool event even without a matching result
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('Bash');
    expect(events[0].outB).toBe(0);
  });

  it('extractToolCalls_CategorizesMcpVsNativeTools', async () => {
    const { extractToolCalls } = await import('./transcript-parser.js');
    const lines = await loadFixtureLines();
    const metadata: SessionMetadata = { sessionId: 'test-session' };
    const events = extractToolCalls(lines, metadata);

    const writeEvent = events.find((e) => e.tool === 'Write');
    expect(writeEvent!.cat).toBe('native');

    const readEvent = events.find((e) => e.tool === 'Read');
    expect(readEvent!.cat).toBe('native');

    const exarchosEvent = events.find((e) =>
      e.tool === 'mcp__plugin_exarchos_exarchos__exarchos_workflow',
    );
    expect(exarchosEvent!.cat).toBe('mcp_exarchos');
  });

  fcTest.prop([
    fc.array(
      fc.record({
        id: fc.uuid(),
        name: fc.oneof(
          fc.constant('Write'),
          fc.constant('Read'),
          fc.constant('Bash'),
          fc.constant('mcp__plugin_exarchos_exarchos__exarchos_workflow'),
          fc.constant('mcp__plugin_github_github__get_me'),
        ),
      }),
      { minLength: 1, maxLength: 20 },
    ),
  ])('extractToolCalls_AllToolUseBlocksProduceEvents', async (toolUses) => {
    const { extractToolCalls } = await import('./transcript-parser.js');
    const lines: unknown[] = [];

    for (let i = 0; i < toolUses.length; i++) {
      const tu = toolUses[i];
      lines.push({
        sessionId: 'prop-session',
        type: 'assistant',
        uuid: `a${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        message: {
          model: 'claude-opus-4-6',
          content: [
            {
              type: 'tool_use',
              id: `toolu_${i}`,
              name: tu.name,
              input: {},
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
      lines.push({
        sessionId: 'prop-session',
        type: 'user',
        uuid: `u${i}`,
        timestamp: new Date(Date.now() + i * 1000 + 500).toISOString(),
        message: {
          content: [
            { type: 'tool_result', tool_use_id: `toolu_${i}`, content: 'ok' },
          ],
        },
      });
    }

    const metadata: SessionMetadata = { sessionId: 'prop-session' };
    const events = extractToolCalls(lines, metadata);
    expect(events).toHaveLength(toolUses.length);
  });
});

describe('Transcript Parser — Turn Extraction', () => {
  it('extractTurns_AssistantEntry_ReturnsTokenBreakdown', async () => {
    const { extractTurns } = await import('./transcript-parser.js');
    const lines: unknown[] = [
      {
        sessionId: 'sess-1',
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-02-24T10:00:01.000Z',
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000 },
        },
      },
    ];

    const metadata: SessionMetadata = { sessionId: 'sess-1' };
    const turns = extractTurns(lines, metadata);

    expect(turns).toHaveLength(1);
    expect(turns[0].t).toBe('turn');
    expect(turns[0].tokIn).toBe(100);
    expect(turns[0].tokOut).toBe(50);
    expect(turns[0].model).toBe('claude-opus-4-6');
    expect(turns[0].sid).toBe('sess-1');
  });

  it('extractTurns_WithCacheTokens_IncludesCacheReadAndWrite', async () => {
    const { extractTurns } = await import('./transcript-parser.js');
    const lines: unknown[] = [
      {
        sessionId: 'sess-1',
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-02-24T10:00:01.000Z',
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000 },
        },
      },
    ];

    const metadata: SessionMetadata = { sessionId: 'sess-1' };
    const turns = extractTurns(lines, metadata);

    expect(turns[0].tokCacheR).toBe(5000);
    expect(turns[0].tokCacheW).toBe(2000);
  });
});

describe('Transcript Parser — Session Summary', () => {
  it('buildSessionSummary_AggregatesToolCallsTokensFiles', async () => {
    const { buildSessionSummary } = await import('./transcript-parser.js');
    const metadata: SessionMetadata = { sessionId: 'sess-1', workflowId: 'wf-1' };

    const toolEvents: SessionToolEvent[] = [
      { t: 'tool', ts: '2026-02-24T10:00:01.000Z', tool: 'Write', cat: 'native', inB: 100, outB: 50, files: ['/tmp/a.ts'], sid: 'sess-1', wid: 'wf-1' },
      { t: 'tool', ts: '2026-02-24T10:00:02.000Z', tool: 'Write', cat: 'native', inB: 200, outB: 60, files: ['/tmp/b.ts'], sid: 'sess-1', wid: 'wf-1' },
      { t: 'tool', ts: '2026-02-24T10:00:03.000Z', tool: 'Read', cat: 'native', inB: 50, outB: 300, files: ['/tmp/a.ts'], sid: 'sess-1', wid: 'wf-1' },
    ];

    const turnEvents: SessionTurnEvent[] = [
      { t: 'turn', ts: '2026-02-24T10:00:01.000Z', model: 'claude-opus-4-6', tokIn: 100, tokOut: 50, tokCacheR: 5000, tokCacheW: 2000, sid: 'sess-1', wid: 'wf-1' },
      { t: 'turn', ts: '2026-02-24T10:00:03.000Z', model: 'claude-opus-4-6', tokIn: 80, tokOut: 30, tokCacheR: 6000, tokCacheW: 0, sid: 'sess-1', wid: 'wf-1' },
    ];

    const summary = buildSessionSummary(toolEvents, turnEvents, metadata);

    expect(summary.t).toBe('summary');
    expect(summary.sid).toBe('sess-1');
    expect(summary.wid).toBe('wf-1');
    expect(summary.tools).toEqual({ Write: 2, Read: 1 });
    expect(summary.tokTotal.in).toBe(180);
    expect(summary.tokTotal.out).toBe(80);
    expect(summary.tokTotal.cacheR).toBe(11000);
    expect(summary.tokTotal.cacheW).toBe(2000);
    expect(summary.files).toEqual(expect.arrayContaining(['/tmp/a.ts', '/tmp/b.ts']));
    expect(summary.files).toHaveLength(2);
    expect(summary.turns).toBe(2);
  });

  it('buildSessionSummary_CalculatesTotalDuration', async () => {
    const { buildSessionSummary } = await import('./transcript-parser.js');
    const metadata: SessionMetadata = { sessionId: 'sess-1' };

    const toolEvents: SessionToolEvent[] = [
      { t: 'tool', ts: '2026-02-24T10:00:00.000Z', tool: 'Write', cat: 'native', inB: 100, outB: 50, sid: 'sess-1' },
    ];

    const turnEvents: SessionTurnEvent[] = [
      { t: 'turn', ts: '2026-02-24T10:00:00.000Z', model: 'claude-opus-4-6', tokIn: 100, tokOut: 50, tokCacheR: 0, tokCacheW: 0, sid: 'sess-1' },
      { t: 'turn', ts: '2026-02-24T10:00:08.000Z', model: 'claude-opus-4-6', tokIn: 70, tokOut: 10, tokCacheR: 0, tokCacheW: 0, sid: 'sess-1' },
    ];

    const summary = buildSessionSummary(toolEvents, turnEvents, metadata);

    // Duration should be 8000ms (from 10:00:00 to 10:00:08)
    expect(summary.dur).toBe(8000);
  });

  it('parseTranscript_FullFixture_ReturnsAllEventTypes', async () => {
    const { parseTranscript } = await import('./transcript-parser.js');
    const fixturePath = path.resolve(import.meta.dirname, '__fixtures__', 'sample-transcript.jsonl');
    const metadata: SessionMetadata = { sessionId: 'test-session' };

    const events = await parseTranscript(fixturePath, metadata);

    const toolEvents = events.filter((e) => e.t === 'tool');
    const turnEvents = events.filter((e) => e.t === 'turn');
    const summaryEvents = events.filter((e) => e.t === 'summary');

    expect(toolEvents.length).toBe(3);
    expect(turnEvents.length).toBe(4); // 4 assistant entries in fixture
    expect(summaryEvents.length).toBe(1);

    // Verify summary aggregates correctly
    const summary = summaryEvents[0] as import('./types.js').SessionSummaryEvent;
    expect(summary.turns).toBe(4);
    expect(summary.tools).toEqual({
      Write: 1,
      Read: 1,
      mcp__plugin_exarchos_exarchos__exarchos_workflow: 1,
    });
    // Total tokens: 100+80+90+70 = 340 in, 50+30+20+10 = 110 out
    expect(summary.tokTotal.in).toBe(340);
    expect(summary.tokTotal.out).toBe(110);
  });

  fcTest.prop([
    fc.array(
      fc.record({
        tokIn: fc.nat({ max: 100000 }),
        tokOut: fc.nat({ max: 100000 }),
        tokCacheR: fc.nat({ max: 100000 }),
        tokCacheW: fc.nat({ max: 100000 }),
      }),
      { minLength: 1, maxLength: 50 },
    ),
  ])('buildSessionSummary_TokenTotalsEqualSumOfTurns', async (turns) => {
    const { buildSessionSummary } = await import('./transcript-parser.js');
    const metadata: SessionMetadata = { sessionId: 'prop-session' };

    const turnEvents: SessionTurnEvent[] = turns.map((t, i) => ({
      t: 'turn' as const,
      ts: new Date(Date.now() + i * 1000).toISOString(),
      model: 'claude-opus-4-6',
      tokIn: t.tokIn,
      tokOut: t.tokOut,
      tokCacheR: t.tokCacheR,
      tokCacheW: t.tokCacheW,
      sid: 'prop-session',
    }));

    const summary = buildSessionSummary([], turnEvents, metadata);

    const expectedIn = turns.reduce((sum, t) => sum + t.tokIn, 0);
    const expectedOut = turns.reduce((sum, t) => sum + t.tokOut, 0);
    const expectedCacheR = turns.reduce((sum, t) => sum + t.tokCacheR, 0);
    const expectedCacheW = turns.reduce((sum, t) => sum + t.tokCacheW, 0);

    expect(summary.tokTotal.in).toBe(expectedIn);
    expect(summary.tokTotal.out).toBe(expectedOut);
    expect(summary.tokTotal.cacheR).toBe(expectedCacheR);
    expect(summary.tokTotal.cacheW).toBe(expectedCacheW);
    expect(summary.turns).toBe(turns.length);
  });
});
