// Tests for `handleInvestigationTimer`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs');

import { handleInvestigationTimer } from '../../../../src/verbs/review/investigation-timer.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

const STATE_DIR = '/tmp/test-investigation-timer';

/**
 * An `EventStore` stub that returns seeded events from `query`. The `node:fs`
 * mock breaks the real SQLite store, and `resolveWorkflowState` calls `query`.
 */
function makeStubEventStore(events: WorkflowEvent[]): EventStore {
  return {
    query: vi.fn(async () => events),
  } as unknown as EventStore;
}

function evt(type: string, data: unknown): WorkflowEvent {
  return { type, data, timestamp: '2026-05-30T00:00:00.000Z' } as unknown as WorkflowEvent;
}

describe('handleInvestigationTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handleInvestigationTimer_WithinBudget_ReturnsContinue', async () => {
    const now = new Date('2026-03-11T10:05:00Z');
    vi.setSystemTime(now);

    const result = await handleInvestigationTimer(
      { startedAt: '2026-03-11T10:00:00Z' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      action: string;
      elapsedMinutes: number;
      remainingMinutes: number;
      report: string;
    };
    expect(data.action).toBe('continue');
    expect(data.elapsedMinutes).toBe(5);
    expect(data.remainingMinutes).toBe(10);
  });

  it('handleInvestigationTimer_ExceededBudget_ReturnsEscalate', async () => {
    const now = new Date('2026-03-11T10:20:00Z');
    vi.setSystemTime(now);

    const result = await handleInvestigationTimer(
      { startedAt: '2026-03-11T10:00:00Z' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      action: string;
      elapsedMinutes: number;
      remainingMinutes: number;
      report: string;
    };
    expect(data.action).toBe('escalate');
    expect(data.elapsedMinutes).toBe(20);
    expect(data.remainingMinutes).toBe(0);
  });

  it('handleInvestigationTimer_ReadsFromStateFile', async () => {
    const now = new Date('2026-03-11T10:10:00Z');
    vi.setSystemTime(now);

    const stateContent = JSON.stringify({
      investigation: { startedAt: '2026-03-11T10:00:00Z' },
    });

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(stateContent);

    const result = await handleInvestigationTimer(
      { stateFile: '/tmp/test.state.json' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync).toHaveBeenCalledWith('/tmp/test.state.json', 'utf-8');
    const data = result.data as { action: string; elapsedMinutes: number };
    expect(data.action).toBe('continue');
    expect(data.elapsedMinutes).toBe(10);
  });

  /**
   * An MCP-only debug workflow has no `.state.json` file. Thus
   * `investigation.startedAt` must resolve from the event-store projection
   * through `featureId` and `eventStore`.
   */
  it('FilelessMcpOnly_ResolvesStartedAtFromEventStore', async () => {
    const now = new Date('2026-03-11T10:10:00Z');
    vi.setSystemTime(now);

    const featureId = 'fileless-timer';
    const eventStore = makeStubEventStore([
      evt('workflow.started', { featureId, workflowType: 'debug' }),
      evt('state.patched', { patch: { investigation: { startedAt: '2026-03-11T10:00:00Z' } } }),
    ]);

    const result = await handleInvestigationTimer({ featureId }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as { action: string; elapsedMinutes: number };
    expect(data.action).toBe('continue');
    expect(data.elapsedMinutes).toBe(10);
  });

  /** At exactly 15 minutes the timer is within budget. One second later it escalates. */
  it('handleInvestigationTimer_DefaultBudget15Minutes', async () => {
    const now = new Date('2026-03-11T10:15:00Z');
    vi.setSystemTime(now);

    const result = await handleInvestigationTimer(
      { startedAt: '2026-03-11T10:00:00Z' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    const data = result.data as { action: string; remainingMinutes: number };
    expect(data.action).toBe('continue');
    expect(data.remainingMinutes).toBe(0);

    const overBudget = new Date('2026-03-11T10:15:01Z');
    vi.setSystemTime(overBudget);

    const result2 = await handleInvestigationTimer(
      { startedAt: '2026-03-11T10:00:00Z' },
      STATE_DIR,
    );

    expect(result2.success).toBe(true);
    const data2 = result2.data as { action: string };
    expect(data2.action).toBe('escalate');
  });

  it('handleInvestigationTimer_MissingStartedAt_ReturnsError', async () => {
    const result = await handleInvestigationTimer({}, STATE_DIR);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('startedAt');
  });

  /**
   * A missing explicit `stateFile` gives `FILE_NOT_FOUND`, not the generic
   * message that `startedAt` or `stateFile` is required.
   */
  it('MissingStateFile_NoFallback_ReturnsFileNotFound', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await handleInvestigationTimer(
      { stateFile: '/tmp/missing.state.json' },
      STATE_DIR,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
    expect(result.error?.message).toContain('missing.state.json');
  });

  /** A corrupt explicit `stateFile` gives `PARSE_ERROR`, not the generic message. */
  it('MalformedStateFile_ReturnsParseError', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ corrupt json');

    const result = await handleInvestigationTimer(
      { stateFile: '/tmp/bad.state.json' },
      STATE_DIR,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PARSE_ERROR');
    expect(result.error?.message).toContain('bad.state.json');
  });

  it('handleInvestigationTimer_InvalidTimestamp_ReturnsError', async () => {
    const result = await handleInvestigationTimer(
      { startedAt: 'not-a-timestamp' },
      STATE_DIR,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('timestamp');
  });

  it('handleInvestigationTimer_ReportContainsMarkdown', async () => {
    const now = new Date('2026-03-11T10:05:00Z');
    vi.setSystemTime(now);

    const result = await handleInvestigationTimer(
      { startedAt: '2026-03-11T10:00:00Z' },
      STATE_DIR,
    );

    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('## Investigation Timer');
    expect(data.report).toContain('**Started:**');
    expect(data.report).toContain('**Elapsed:**');
    expect(data.report).toContain('**Budget:**');
    expect(data.report).toContain('**Status:**');
  });
});
