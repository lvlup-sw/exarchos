import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { WorkflowState } from '../../../src/workflow/types.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { compactWorkflow, rotateTelemetry } from '../../../src/storage/lifecycle.js';
import type { LifecyclePolicy } from '../../../src/storage/lifecycle.js';
import { TELEMETRY_STREAM } from '../../../src/projections/telemetry/constants.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

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

/** Zero retention: each completed workflow compacts, and each telemetry event is pruned. */
function shortRetentionPolicy(): LifecyclePolicy {
  return {
    retentionDays: 0,
    maxTotalSizeMB: 500,
    maxTelemetryEvents: 5,
    telemetryRetentionDays: 0,
  };
}

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
    }
    if (tempDir) {
      rmrf(tempDir);
    }
  });

  /**
   * With a backend, `compactWorkflow` reads the state from SQLite. The state file
   * on disk exists so that the test can check its removal.
   */
  it('compactWorkflow_SqliteBackend_DeletesEventsStateOutboxRows', async () => {
    const { stateDir } = setup();
    const featureId = 'compact-test';

    for (let i = 1; i <= 5; i++) {
      backend.appendEvent(featureId, makeEvent({
        streamId: featureId,
        sequence: i,
        timestamp: new Date().toISOString(),
      }));
    }

    const completedState = makeCompletedState(featureId, 60);
    backend.setState(featureId, completedState);

    const stateFile = join(stateDir, `${featureId}.state.json`);
    writeFileSync(stateFile, JSON.stringify(completedState), 'utf-8');

    backend.addOutboxEntry(featureId, makeEvent({ streamId: featureId, sequence: 1 }));
    backend.addOutboxEntry(featureId, makeEvent({ streamId: featureId, sequence: 2 }));

    const eventsBefore = backend.queryEvents(featureId);
    expect(eventsBefore.length).toBe(5);
    const stateBefore = backend.getState(featureId);
    expect(stateBefore).not.toBeNull();

    await compactWorkflow(backend, stateDir, featureId, shortRetentionPolicy());

    const eventsAfter = backend.queryEvents(featureId);
    expect(eventsAfter).toHaveLength(0);

    const stateAfter = backend.getState(featureId);
    expect(stateAfter).toBeNull();

    expect(existsSync(stateFile)).toBe(false);

    const archivePath = join(stateDir, 'archives', `${featureId}.archive.json`);
    expect(existsSync(archivePath)).toBe(true);

    const archiveContent = JSON.parse(readFileSync(archivePath, 'utf-8'));
    expect(archiveContent.featureId).toBe(featureId);
    expect(archiveContent.eventCount).toBe(5);
    expect(archiveContent.finalState.phase).toBe('completed');
  });

  /**
   * `rotateTelemetry` prunes by timestamp through `backend.pruneEvents`. The
   * events are 14 days old, and the retention is 0 days.
   */
  it('rotateTelemetry_SqliteBackend_PrunesEventsByTimestamp', async () => {
    const { stateDir } = setup();

    const oldTimestamp = new Date();
    oldTimestamp.setDate(oldTimestamp.getDate() - 14);

    for (let i = 1; i <= 10; i++) {
      backend.appendEvent(TELEMETRY_STREAM, makeEvent({
        streamId: TELEMETRY_STREAM,
        sequence: i,
        type: 'tool.invoked',
        timestamp: oldTimestamp.toISOString(),
        data: { tool: `tool-${i}` },
      }));
    }

    const eventsBefore = backend.queryEvents(TELEMETRY_STREAM);
    expect(eventsBefore.length).toBe(10);

    const policy = shortRetentionPolicy();
    await rotateTelemetry(backend, stateDir, policy);

    const eventsAfter = backend.queryEvents(TELEMETRY_STREAM);
    expect(eventsAfter).toHaveLength(0);
  });

  /** The archive must be whole JSON, and no `.tmp` file must stay in the archive directory. */
  it('compactWorkflow_SqliteBackend_ArchiveCreatedAtomically', async () => {
    const { stateDir } = setup();
    const featureId = 'atomic-archive';

    const completedState = makeCompletedState(featureId, 60);
    backend.setState(featureId, completedState);

    const stateFile = join(stateDir, `${featureId}.state.json`);
    writeFileSync(stateFile, JSON.stringify(completedState), 'utf-8');

    const jsonlPath = join(stateDir, `${featureId}.events.jsonl`);
    writeFileSync(jsonlPath, JSON.stringify(makeEvent({ streamId: featureId })), 'utf-8');

    await compactWorkflow(backend, stateDir, featureId, shortRetentionPolicy());

    const archivePath = join(stateDir, 'archives', `${featureId}.archive.json`);
    expect(existsSync(archivePath)).toBe(true);

    const archiveContent = JSON.parse(readFileSync(archivePath, 'utf-8'));
    expect(archiveContent.featureId).toBe(featureId);
    expect(archiveContent.archivedAt).toBeDefined();
    expect(typeof archiveContent.archivedAt).toBe('string');
    expect(archiveContent.finalState).toBeDefined();
    expect(archiveContent.finalState.featureId).toBe(featureId);

    const archiveDir = join(stateDir, 'archives');
    const archiveFiles = readdirSync(archiveDir) as string[];
    const tmpFiles = archiveFiles.filter((f: string) => f.includes('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});
