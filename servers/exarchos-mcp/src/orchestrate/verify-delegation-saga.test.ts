// ─── Verify Delegation Saga Tests ────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mock node:fs ────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { handleVerifyDelegationSaga } from './verify-delegation-saga.js';

const STATE_DIR = '/tmp/test-verify-delegation-saga';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(type: string, sequence: number, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, sequence, data });
}

function makeJsonl(...lines: string[]): string {
  return lines.join('\n');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleVerifyDelegationSaga', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Test 1: Valid saga ordering ─────────────────────────────────────────

  it('ValidSagaOrdering_ReturnsPassed', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('team.spawned', 1),
      makeEvent('team.task.planned', 2, { taskId: 't1' }),
      makeEvent('team.task.planned', 3, { taskId: 't2' }),
      makeEvent('team.teammate.dispatched', 4, { assignedTaskIds: ['t1'] }),
      makeEvent('team.teammate.dispatched', 5, { assignedTaskIds: ['t2'] }),
      makeEvent('team.disbanded', 6),
    ));

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-123',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; violations: string[] };
    expect(data.passed).toBe(true);
    expect(data.violations).toHaveLength(0);
  });

  // ─── Test 2: No team events → passed (skip) ─────────────────────────────

  it('NoTeamEvents_ReturnsPassed', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('workflow.started', 1),
      makeEvent('task.completed', 2),
    ));

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-123',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; violations: string[] };
    expect(data.passed).toBe(true);
    expect(data.violations).toHaveLength(0);
  });

  // ─── Test 3: team.task.planned before team.spawned → violation ──────────

  it('PlannedBeforeSpawned_ReturnsViolation', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('team.task.planned', 1, { taskId: 't1' }),
      makeEvent('team.spawned', 2),
    ));

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-123',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; violations: string[] };
    expect(data.passed).toBe(false);
    expect(data.violations).toHaveLength(1);
    expect(data.violations[0]).toContain('team.task.planned');
    expect(data.violations[0]).toContain('team.spawned');
  });

  // ─── Test 4: team.teammate.dispatched before team.task.planned ──────────

  it('DispatchedBeforePlanned_ReturnsViolation', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('team.spawned', 1),
      makeEvent('team.teammate.dispatched', 2, { assignedTaskIds: ['t1'] }),
      makeEvent('team.task.planned', 3, { taskId: 't1' }),
    ));

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-123',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; violations: string[] };
    expect(data.passed).toBe(false);
    expect(data.violations.some((v: string) =>
      v.includes('team.teammate.dispatched') && v.includes('team.task.planned'),
    )).toBe(true);
  });

  // ─── Test 5: Events after team.disbanded → violation ────────────────────

  it('EventsAfterDisbanded_ReturnsViolation', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('team.spawned', 1),
      makeEvent('team.task.planned', 2, { taskId: 't1' }),
      makeEvent('team.teammate.dispatched', 3, { assignedTaskIds: ['t1'] }),
      makeEvent('team.disbanded', 4),
      makeEvent('team.task.planned', 5, { taskId: 't2' }),
    ));

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-123',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; violations: string[] };
    expect(data.passed).toBe(false);
    expect(data.violations.some((v: string) =>
      v.includes('team.disbanded'),
    )).toBe(true);
  });

  // ─── Test 6: Dispatched task not planned → violation ────────────────────

  it('DispatchedTaskNotPlanned_ReturnsViolation', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('team.spawned', 1),
      makeEvent('team.task.planned', 2, { taskId: 't1' }),
      makeEvent('team.teammate.dispatched', 3, { assignedTaskIds: ['t1', 't2'] }),
    ));

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-123',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; violations: string[] };
    expect(data.passed).toBe(false);
    expect(data.violations.some((v: string) => v.includes('t2'))).toBe(true);
  });

  // ─── Test 7: Event file not found → error ──────────────────────────────

  it('EventFileNotFound_ReturnsError', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-missing',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
  });

  // ─── Test 8: Empty event file → error ──────────────────────────────────

  it('EmptyEventFile_ReturnsError', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('');

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-empty',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EMPTY_FILE');
  });

  // ─── Test 9: Uses default stateDir when not provided ───────────────────

  it('DefaultStateDir_UsesHomePath', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('workflow.started', 1),
    ));

    handleVerifyDelegationSaga({ featureId: 'feat-default' });

    // Should read from default stateDir (home-based)
    expect(readFileSync).toHaveBeenCalledWith(
      expect.stringContaining('feat-default.events.jsonl'),
      'utf-8',
    );
  });

  // ─── Test 10: Batched taskIds in team.task.planned ─────────────────────

  it('BatchedTaskIds_AllTrackedAsPlanned', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('team.spawned', 1),
      makeEvent('team.task.planned', 2, { taskIds: ['t1', 't2', 't3'] }),
      makeEvent('team.teammate.dispatched', 3, { assignedTaskIds: ['t1', 't2', 't3'] }),
    ));

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-batch',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; violations: string[] };
    expect(data.passed).toBe(true);
    expect(data.violations).toHaveLength(0);
  });

  // ─── Test 11: Other team.* events after disbanded ──────────────────────

  it('OtherTeamEventAfterDisbanded_ReturnsViolation', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('team.spawned', 1),
      makeEvent('team.disbanded', 2),
      makeEvent('team.status.updated', 3),
    ));

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-post-disband',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; violations: string[] };
    expect(data.passed).toBe(false);
    expect(data.violations.some((v: string) =>
      v.includes('team.status.updated') && v.includes('team.disbanded'),
    )).toBe(true);
  });

  // ─── Test 12: team.teammate.dispatched before team.spawned ─────────────

  it('DispatchedBeforeSpawned_ReturnsViolation', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(makeJsonl(
      makeEvent('team.teammate.dispatched', 1, { assignedTaskIds: ['t1'] }),
      makeEvent('team.spawned', 2),
      makeEvent('team.task.planned', 3, { taskId: 't1' }),
    ));

    const result: ToolResult = handleVerifyDelegationSaga({
      featureId: 'feat-no-spawn',
      stateDir: STATE_DIR,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; violations: string[] };
    expect(data.passed).toBe(false);
    expect(data.violations.some((v: string) =>
      v.includes('team.teammate.dispatched') && v.includes('team.spawned'),
    )).toBe(true);
  });
});
