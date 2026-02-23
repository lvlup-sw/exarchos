import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { WorkflowState } from '../../workflow/types.js';
import { SqliteBackend } from '../sqlite-backend.js';
import { compactWorkflow, rotateTelemetry } from '../lifecycle.js';
import type { LifecyclePolicy } from '../lifecycle.js';
import { TELEMETRY_STREAM } from '../../telemetry/constants.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'workflow.started',
    schemaVersion: '1.0',
    ...overrides,
  } as WorkflowEvent;
}

function makeCompletedState(featureId: string, daysAgo: number): WorkflowState {
  const updatedAt = new Date();
  updatedAt.setDate(updatedAt.getDate() - daysAgo);
  return {
    version: '1.1',
    featureId,
    workflowType: 'feature',
    phase: 'completed',
    createdAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    updatedAt: updatedAt.toISOString(),
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _version: 1,
    _history: {},
    _checkpoint: {
      timestamp: '1970-01-01T00:00:00Z',
      phase: 'init',
      summary: 'Initial state',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '1970-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    },
  } as WorkflowState;
}

function shortRetentionPolicy(): LifecyclePolicy {
  return {
    retentionDays: 0, // compact immediately (anything in the past qualifies)
    maxTotalSizeMB: 500,
    maxTelemetryEvents: 5, // low threshold for rotation
    telemetryRetentionDays: 0, // prune immediately
  };
}

// ─── Lifecycle Tests with SqliteBackend ─────────────────────────────────────

describe('Lifecycle with SqliteBackend', () => {
  let tempDir: string;
  let backend: SqliteBackend;

  function setup(): { stateDir: string; dbPath: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'exarchos-lifecycle-'));
    const dbPath = join(tempDir, 'test.db');
    backend = new SqliteBackend(dbPath);
    backend.initialize();
    return { stateDir: tempDir, dbPath };
  }

  afterEach(() => {
    try {
      backend?.close();
    } catch {
      // already closed
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it('compactWorkflow_SqliteBackend_DeletesEventsStateOutboxRows', async () => {
    const { stateDir } = setup();
    const featureId = 'compact-test';

    // Populate SQLite with events for this stream
    for (let i = 1; i <= 5; i++) {
      backend.appendEvent(featureId, makeEvent({
        streamId: featureId,
        sequence: i,
        timestamp: new Date().toISOString(),
      }));
    }

    // Populate state in SQLite
    const completedState = makeCompletedState(featureId, 60); // 60 days old
    backend.setState(featureId, completedState);

    // Write the state file on disk (compactWorkflow reads from disk)
    const stateFile = join(stateDir, `${featureId}.state.json`);
    writeFileSync(stateFile, JSON.stringify(completedState), 'utf-8');

    // Write a JSONL file for event count
    const jsonlPath = join(stateDir, `${featureId}.events.jsonl`);
    const jsonlLines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify(makeEvent({ streamId: featureId, sequence: i + 1 })),
    ).join('\n');
    writeFileSync(jsonlPath, jsonlLines, 'utf-8');

    // Add outbox entries
    backend.addOutboxEntry(featureId, makeEvent({ streamId: featureId, sequence: 1 }));
    backend.addOutboxEntry(featureId, makeEvent({ streamId: featureId, sequence: 2 }));

    // Verify pre-conditions: events and state exist
    const eventsBefore = backend.queryEvents(featureId);
    expect(eventsBefore.length).toBe(5);
    const stateBefore = backend.getState(featureId);
    expect(stateBefore).not.toBeNull();

    // Act
    await compactWorkflow(backend, stateDir, featureId, shortRetentionPolicy());

    // Assert: events deleted from SQLite
    const eventsAfter = backend.queryEvents(featureId);
    expect(eventsAfter).toHaveLength(0);

    // Assert: state deleted from SQLite
    const stateAfter = backend.getState(featureId);
    expect(stateAfter).toBeNull();

    // Assert: JSONL file deleted from disk
    expect(existsSync(jsonlPath)).toBe(false);

    // Assert: state file deleted from disk
    expect(existsSync(stateFile)).toBe(false);

    // Assert: archive file created
    const archivePath = join(stateDir, 'archives', `${featureId}.archive.json`);
    expect(existsSync(archivePath)).toBe(true);

    // Verify archive content
    const archiveContent = JSON.parse(readFileSync(archivePath, 'utf-8'));
    expect(archiveContent.featureId).toBe(featureId);
    expect(archiveContent.eventCount).toBe(5);
    expect(archiveContent.finalState.phase).toBe('completed');
  });

  it('rotateTelemetry_SqliteBackend_PrunesEventsByTimestamp', async () => {
    const { stateDir } = setup();

    // Add telemetry events with old timestamps to SQLite
    const oldTimestamp = new Date();
    oldTimestamp.setDate(oldTimestamp.getDate() - 14); // 14 days ago

    for (let i = 1; i <= 10; i++) {
      backend.appendEvent(TELEMETRY_STREAM, makeEvent({
        streamId: TELEMETRY_STREAM,
        sequence: i,
        type: 'tool.invoked',
        timestamp: oldTimestamp.toISOString(),
        data: { tool: `tool-${i}` },
      }));
    }

    // Write a JSONL file exceeding the threshold
    const telemetryJsonl = join(stateDir, `${TELEMETRY_STREAM}.events.jsonl`);
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify(makeEvent({
        streamId: TELEMETRY_STREAM,
        sequence: i + 1,
        type: 'tool.invoked',
        timestamp: oldTimestamp.toISOString(),
      })),
    ).join('\n');
    writeFileSync(telemetryJsonl, lines, 'utf-8');

    // Verify pre-conditions
    const eventsBefore = backend.queryEvents(TELEMETRY_STREAM);
    expect(eventsBefore.length).toBe(10);

    // Act: rotate with policy that prunes everything
    const policy = shortRetentionPolicy();
    await rotateTelemetry(backend, stateDir, policy);

    // Assert: old events pruned from SQLite
    const eventsAfter = backend.queryEvents(TELEMETRY_STREAM);
    expect(eventsAfter).toHaveLength(0);

    // Assert: JSONL file rotated (original removed, .1 created)
    expect(existsSync(telemetryJsonl)).toBe(false);
    expect(existsSync(`${telemetryJsonl}.1`)).toBe(true);
  });

  it('compactWorkflow_SqliteBackend_ArchiveCreatedAtomically', async () => {
    const { stateDir } = setup();
    const featureId = 'atomic-archive';

    // Set up a completed workflow
    const completedState = makeCompletedState(featureId, 60);
    backend.setState(featureId, completedState);

    const stateFile = join(stateDir, `${featureId}.state.json`);
    writeFileSync(stateFile, JSON.stringify(completedState), 'utf-8');

    // Write JSONL
    const jsonlPath = join(stateDir, `${featureId}.events.jsonl`);
    writeFileSync(jsonlPath, JSON.stringify(makeEvent({ streamId: featureId })), 'utf-8');

    // Act
    await compactWorkflow(backend, stateDir, featureId, shortRetentionPolicy());

    // Assert: archive exists (write via tmp+rename pattern)
    const archivePath = join(stateDir, 'archives', `${featureId}.archive.json`);
    expect(existsSync(archivePath)).toBe(true);

    // Verify archive is valid JSON (atomic write succeeded — not partial/corrupt)
    const archiveContent = JSON.parse(readFileSync(archivePath, 'utf-8'));
    expect(archiveContent.featureId).toBe(featureId);
    expect(archiveContent.archivedAt).toBeDefined();
    expect(typeof archiveContent.archivedAt).toBe('string');
    expect(archiveContent.finalState).toBeDefined();
    expect(archiveContent.finalState.featureId).toBe(featureId);

    // Assert: no .tmp files left behind (atomic rename completed)
    const archiveDir = join(stateDir, 'archives');
    const archiveFiles = readdirSync(archiveDir) as string[];
    const tmpFiles = archiveFiles.filter((f: string) => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });
});
