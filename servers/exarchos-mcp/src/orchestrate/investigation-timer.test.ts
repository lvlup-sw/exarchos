// ─── Investigation Timer Tests ──────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs');

import { handleInvestigationTimer } from './investigation-timer.js';

const STATE_DIR = '/tmp/test-investigation-timer';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleInvestigationTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Within Budget → Continue ──────────────────────────────────────────────

  it('handleInvestigationTimer_WithinBudget_ReturnsContinue', async () => {
    // Started 5 minutes ago, budget is 15 minutes
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

  // ─── Exceeded Budget → Escalate ───────────────────────────────────────────

  it('handleInvestigationTimer_ExceededBudget_ReturnsEscalate', async () => {
    // Started 20 minutes ago, budget is 15 minutes
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

  // ─── Reads From State File ────────────────────────────────────────────────

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

  // ─── Default Budget 15 Minutes ────────────────────────────────────────────

  it('handleInvestigationTimer_DefaultBudget15Minutes', async () => {
    // Exactly at 15 minutes → still within budget (<=)
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

    // 15 minutes + 1 second → escalate
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

  // ─── Missing StartedAt → Error ────────────────────────────────────────────

  it('handleInvestigationTimer_MissingStartedAt_ReturnsError', async () => {
    const result = await handleInvestigationTimer({}, STATE_DIR);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('startedAt');
  });

  // ─── Invalid Timestamp → Error ────────────────────────────────────────────

  it('handleInvestigationTimer_InvalidTimestamp_ReturnsError', async () => {
    const result = await handleInvestigationTimer(
      { startedAt: 'not-a-timestamp' },
      STATE_DIR,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('timestamp');
  });

  // ─── Report Contains Markdown ─────────────────────────────────────────────

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
