import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { handleVerifyReviewTriage } from '../../../../src/verbs/review/verify-review-triage.js';
import { EventStore } from '../../../../src/events/store.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStateFile(prs: { number: number }[]): string {
  return JSON.stringify({ prs });
}

function makeEventStream(events: { type: string; data: Record<string, unknown> }[]): string {
  return events.map(e => JSON.stringify(e)).join('\n');
}

function setupFiles(stateContent: string, eventContent: string): void {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockImplementation((path: unknown) => {
    if (String(path) === '/state.json') return stateContent;
    if (String(path) === '/events.jsonl') return eventContent;
    throw new Error(`Unexpected file: ${String(path)}`);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleVerifyReviewTriage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when all PRs have review.routed events with self-hosted destination', async () => {
    setupFiles(
      makeStateFile([{ number: 101 }, { number: 102 }]),
      makeEventStream([
        { type: 'review.routed', data: { pr: 101, riskScore: 0.1, destination: 'self-hosted' } },
        { type: 'review.routed', data: { pr: 102, riskScore: 0.2, destination: 'self-hosted' } },
      ]),
    );

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checksPassed: number; checksFailed: number };
    expect(data.passed).toBe(true);
    expect(data.checksPassed).toBe(4); // 2 routed + 2 self-hosted
    expect(data.checksFailed).toBe(0);
  });

  it('fails when a PR is missing a review.routed event', async () => {
    setupFiles(
      makeStateFile([{ number: 101 }, { number: 102 }]),
      makeEventStream([
        { type: 'review.routed', data: { pr: 101, riskScore: 0.1, destination: 'self-hosted' } },
      ]),
    );

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checksFailed: number; checks: { status: string; message: string }[] };
    expect(data.passed).toBe(false);
    expect(data.checksFailed).toBeGreaterThanOrEqual(1);
    expect(data.checks).toContainEqual({
      status: 'fail',
      message: 'PR #102: missing review.routed event',
    });
  });

  it('passes when high-risk PR is sent to CodeRabbit', async () => {
    setupFiles(
      makeStateFile([{ number: 201 }]),
      makeEventStream([
        { type: 'review.routed', data: { pr: 201, riskScore: 0.8, destination: 'both' } },
      ]),
    );

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { status: string; message: string }[] };
    expect(data.passed).toBe(true);
    expect(data.checks).toContainEqual(
      expect.objectContaining({ status: 'pass', message: expect.stringContaining('sent to CodeRabbit') }),
    );
  });

  it('fails when high-risk PR is NOT sent to CodeRabbit', async () => {
    setupFiles(
      makeStateFile([{ number: 301 }]),
      makeEventStream([
        { type: 'review.routed', data: { pr: 301, riskScore: 0.5, destination: 'self-hosted' } },
      ]),
    );

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { status: string; message: string }[] };
    expect(data.passed).toBe(false);
    expect(data.checks).toContainEqual(
      expect.objectContaining({ status: 'fail', message: expect.stringContaining('NOT sent to CodeRabbit') }),
    );
  });

  it('passes when self-hosted review is enabled', async () => {
    setupFiles(
      makeStateFile([{ number: 401 }]),
      makeEventStream([
        { type: 'review.routed', data: { pr: 401, riskScore: 0.1, destination: 'self-hosted' } },
      ]),
    );

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { status: string; message: string }[] };
    expect(data.passed).toBe(true);
    expect(data.checks).toContainEqual(
      expect.objectContaining({ status: 'pass', message: expect.stringContaining('self-hosted review enabled') }),
    );
  });

  it('fails when self-hosted review is NOT enabled', async () => {
    setupFiles(
      makeStateFile([{ number: 501 }]),
      makeEventStream([
        { type: 'review.routed', data: { pr: 501, riskScore: 0.1, destination: 'coderabbit' } },
      ]),
    );

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { status: string; message: string }[] };
    expect(data.passed).toBe(false);
    expect(data.checks).toContainEqual(
      expect.objectContaining({ status: 'fail', message: expect.stringContaining('self-hosted review NOT enabled') }),
    );
  });

  it('returns error when state file is not found', async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (String(path) === '/state.json') return false;
      return true;
    });

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
    expect(result.error?.message).toContain('State file not found');
  });

  it('returns error when event stream is not found', async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (String(path) === '/events.jsonl') return false;
      return true;
    });

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
    expect(result.error?.message).toContain('Event stream not found');
  });

  it('returns error when no PRs found in state file', async () => {
    setupFiles(
      JSON.stringify({ prs: [] }),
      '',
    );

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_PRS');
  });

  it('uses the latest review.routed event for each PR', async () => {
    setupFiles(
      makeStateFile([{ number: 601 }]),
      makeEventStream([
        { type: 'review.routed', data: { pr: 601, riskScore: 0.1, destination: 'coderabbit' } },
        { type: 'review.routed', data: { pr: 601, riskScore: 0.1, destination: 'self-hosted' } },
      ]),
    );

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean };
    // The latest event has destination 'self-hosted', so it should pass
    expect(data.passed).toBe(true);
  });

  it('builds a markdown report with table format', async () => {
    setupFiles(
      makeStateFile([{ number: 701 }]),
      makeEventStream([
        { type: 'review.routed', data: { pr: 701, riskScore: 0.1, destination: 'self-hosted' } },
      ]),
    );

    const result = await handleVerifyReviewTriage({
      stateFile: '/state.json',
      eventStream: '/events.jsonl',
    });

    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('## Review Triage Verification');
    expect(data.report).toContain('| Status | Check |');
    expect(data.report).toContain('| PASS |');
    expect(data.report).toContain('**Passed:**');
  });

  // ─── Fileless resolution: MCP-only workflow ────────────────────────────
  //
  // INV-1: the event store is the sole source of truth. An MCP-only workflow
  // has no `.state.json` stamp and no `.events.jsonl` sidecar — the gate must
  // resolve `prs` from the projected state and the `review.routed` events
  // directly from the event store via featureId + eventStore.

  it('FilelessMcpOnly_ResolvesPrsAndRoutedEventsFromEventStore', async () => {
    // No state file or event stream on disk.
    mockExistsSync.mockReturnValue(false);

    const eventStoreDir = await fsPromises.mkdtemp(
      nodePath.join(tmpdir(), 'verify-triage-fileless-'),
    );
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();

    const featureId = 'fileless-triage';
    await eventStore.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    // PRs land on the projection via state.patched (same path as
    // `exarchos_workflow update`).
    await eventStore.append(featureId, {
      type: 'state.patched',
      data: { patch: { prs: [{ number: 101 }, { number: 102 }] } },
    });
    // review.routed events are queried directly from the store.
    await eventStore.append(featureId, {
      type: 'review.routed',
      data: { pr: 101, riskScore: 0.1, factors: [], destination: 'self-hosted', velocityTier: 'normal', semanticAugmented: false },
    });
    await eventStore.append(featureId, {
      type: 'review.routed',
      data: { pr: 102, riskScore: 0.2, factors: [], destination: 'self-hosted', velocityTier: 'normal', semanticAugmented: false },
    });

    const result = await handleVerifyReviewTriage({ featureId, eventStore });

    eventStore.close();
    await fsPromises.rm(eventStoreDir, { recursive: true, force: true });

    // Must NOT fail with INVALID_INPUT / FILE_NOT_FOUND.
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checksPassed: number; checksFailed: number };
    expect(data.passed).toBe(true);
    expect(data.checksPassed).toBe(4); // 2 routed + 2 self-hosted
    expect(data.checksFailed).toBe(0);
  });
});
