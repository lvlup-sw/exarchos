/**
 * The atomic archive write tests are in `lifecycle-atomic.test.ts`, because they
 * mock `node:fs/promises` for the whole module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryBackend } from '../../../src/storage/memory-backend.js';
import {
  compactWorkflow,
  checkCompaction,
  rotateTelemetry,
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
} from '../../../src/storage/lifecycle.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** Create a temporary directory for each test. */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'lifecycle-test-'));
}

/** Write a minimal state JSON file. */
async function writeState(
  stateDir: string,
  featureId: string,
  phase: string,
  updatedAt: string,
  workflowType: string = 'feature',
): Promise<void> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const state = {
    version: '4.0',
    featureId,
    workflowType,
    createdAt: updatedAt,
    updatedAt,
    phase,
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
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
      timestamp: updatedAt,
      phase,
      summary: 'test',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: updatedAt,
      staleAfterMinutes: 120,
    },
  };
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

/** Write a minimal JSONL events file. */
async function writeEvents(
  stateDir: string,
  streamId: string,
  count: number,
): Promise<void> {
  const filePath = path.join(stateDir, `${streamId}.events.jsonl`);
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(JSON.stringify({
      streamId,
      sequence: i,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      schemaVersion: '1.0',
    }));
  }
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
}

/** Get a date string N days in the past. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe('Workflow Compaction', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('compactWorkflow_CompletedAndOlderThanRetention_ArchivesAndDeletes', async () => {
    const featureId = 'old-feature';
    const updatedAt = daysAgo(60);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 5);

    const backend = new InMemoryBackend();
    for (let i = 1; i <= 5; i++) {
      backend.appendEvent(featureId, {
        streamId: featureId,
        sequence: i,
        timestamp: new Date().toISOString(),
        type: 'workflow.started',
        schemaVersion: '1.0',
      });
    }
    backend.setState(featureId, {
      version: '4.0',
      featureId,
      workflowType: 'feature',
      createdAt: updatedAt,
      updatedAt,
      phase: 'completed',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      _version: 1,
      _history: {},
      _checkpoint: { timestamp: updatedAt, phase: 'completed', summary: 'test', operationsSince: 0, fixCycleCount: 0, lastActivityTimestamp: updatedAt, staleAfterMinutes: 120 },
    } as never);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    await compactWorkflow(backend, stateDir, featureId, policy);

    const archivePath = path.join(stateDir, 'archives', `${featureId}.archive.json`);
    const archiveExists = await fs.access(archivePath).then(() => true).catch(() => false);
    expect(archiveExists).toBe(true);

    const statePath = path.join(stateDir, `${featureId}.state.json`);
    const stateExists = await fs.access(statePath).then(() => true).catch(() => false);
    expect(stateExists).toBe(false);

    expect(backend.queryEvents(featureId)).toHaveLength(0);
    expect(backend.getState(featureId)).toBeNull();
  });

  /**
   * The backend row has a completed phase and an old `updatedAt`, but it fails
   * the schema. `compactWorkflow` must not archive or delete it, so the corrupt
   * row stays visible.
   */
  it('compactWorkflow_MalformedBackendState_SkipsCompaction', async () => {
    const featureId = 'malformed-feature';
    const updatedAt = daysAgo(60);

    const backend = new InMemoryBackend();
    backend.appendEvent(featureId, {
      streamId: featureId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      schemaVersion: '1.0',
    });
    backend.setState(featureId, {
      featureId,
      phase: 'completed',
      updatedAt,
    } as never);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    await compactWorkflow(backend, stateDir, featureId, policy);

    const archivePath = path.join(stateDir, 'archives', `${featureId}.archive.json`);
    const archiveExists = await fs.access(archivePath).then(() => true).catch(() => false);
    expect(archiveExists).toBe(false);
    expect(backend.queryEvents(featureId)).toHaveLength(1);
    expect(backend.getState(featureId)).not.toBeNull();
  });

  it('compactWorkflow_ActiveWorkflow_NoOps', async () => {
    const featureId = 'active-feature';
    const updatedAt = daysAgo(60);
    await writeState(stateDir, featureId, 'delegate', updatedAt);
    await writeEvents(stateDir, featureId, 3);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    await compactWorkflow(undefined, stateDir, featureId, policy);

    const archivePath = path.join(stateDir, 'archives', `${featureId}.archive.json`);
    const archiveExists = await fs.access(archivePath).then(() => true).catch(() => false);
    expect(archiveExists).toBe(false);

    const jsonlPath = path.join(stateDir, `${featureId}.events.jsonl`);
    const jsonlExists = await fs.access(jsonlPath).then(() => true).catch(() => false);
    expect(jsonlExists).toBe(true);

    const statePath = path.join(stateDir, `${featureId}.state.json`);
    const stateExists = await fs.access(statePath).then(() => true).catch(() => false);
    expect(stateExists).toBe(true);
  });

  it('compactWorkflow_CompletedButTooRecent_NoOps', async () => {
    const featureId = 'recent-feature';
    const updatedAt = daysAgo(5);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 2);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    await compactWorkflow(undefined, stateDir, featureId, policy);

    const archivePath = path.join(stateDir, 'archives', `${featureId}.archive.json`);
    const archiveExists = await fs.access(archivePath).then(() => true).catch(() => false);
    expect(archiveExists).toBe(false);

    const jsonlPath = path.join(stateDir, `${featureId}.events.jsonl`);
    const jsonlExists = await fs.access(jsonlPath).then(() => true).catch(() => false);
    expect(jsonlExists).toBe(true);
  });

  /** With a backend, the state and the event count both come from the backend. */
  it('compactWorkflow_ArchiveContainsFinalStateAndEventCount', async () => {
    const featureId = 'archive-check';
    const updatedAt = daysAgo(45);
    await writeState(stateDir, featureId, 'completed', updatedAt);

    const backend = new InMemoryBackend();
    for (let i = 1; i <= 7; i++) {
      backend.appendEvent(featureId, {
        streamId: featureId,
        sequence: i,
        timestamp: new Date().toISOString(),
        type: 'workflow.started',
        schemaVersion: '1.0',
      });
    }
    backend.setState(featureId, {
      version: '4.0',
      featureId,
      workflowType: 'feature',
      createdAt: updatedAt,
      updatedAt,
      phase: 'completed',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      _version: 1,
      _history: {},
      _checkpoint: { timestamp: updatedAt, phase: 'completed', summary: 'test', operationsSince: 0, fixCycleCount: 0, lastActivityTimestamp: updatedAt, staleAfterMinutes: 120 },
    } as never);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    await compactWorkflow(backend, stateDir, featureId, policy);

    const archivePath = path.join(stateDir, 'archives', `${featureId}.archive.json`);
    const archiveRaw = await fs.readFile(archivePath, 'utf-8');
    const archive = JSON.parse(archiveRaw);

    expect(archive.finalState).toBeDefined();
    expect(archive.finalState.featureId).toBe(featureId);
    expect(archive.finalState.phase).toBe('completed');
    expect(archive.eventCount).toBe(7);
  });

  it('compactWorkflow_DeletesJSONLAndSQLiteRows', async () => {
    const featureId = 'cleanup-check';
    const updatedAt = daysAgo(40);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 4);

    const backend = new InMemoryBackend();
    for (let i = 1; i <= 4; i++) {
      backend.appendEvent(featureId, {
        streamId: featureId,
        sequence: i,
        timestamp: new Date().toISOString(),
        type: 'workflow.started',
        schemaVersion: '1.0',
      });
    }
    backend.setState(featureId, {
      version: '4.0',
      featureId,
      workflowType: 'feature',
      createdAt: updatedAt,
      updatedAt,
      phase: 'completed',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      _version: 1,
      _history: {},
      _checkpoint: { timestamp: updatedAt, phase: 'completed', summary: 'test', operationsSince: 0, fixCycleCount: 0, lastActivityTimestamp: updatedAt, staleAfterMinutes: 120 },
    } as never);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    await compactWorkflow(backend, stateDir, featureId, policy);

    expect(backend.queryEvents(featureId)).toHaveLength(0);
    expect(backend.getState(featureId)).toBeNull();
  });

  /**
   * Two old completed workflows and one active workflow. With no backend,
   * `checkCompaction` finds them from the `.state.json` files.
   */
  it('checkCompaction_OnStartup_CompactsEligibleWorkflows', async () => {
    await writeState(stateDir, 'old-a', 'completed', daysAgo(60));
    await writeEvents(stateDir, 'old-a', 3);

    await writeState(stateDir, 'old-b', 'completed', daysAgo(45));
    await writeEvents(stateDir, 'old-b', 2);

    await writeState(stateDir, 'active-c', 'delegate', daysAgo(60));
    await writeEvents(stateDir, 'active-c', 5);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    await checkCompaction(undefined, stateDir, policy);

    const archiveA = await fs.access(
      path.join(stateDir, 'archives', 'old-a.archive.json'),
    ).then(() => true).catch(() => false);
    const archiveB = await fs.access(
      path.join(stateDir, 'archives', 'old-b.archive.json'),
    ).then(() => true).catch(() => false);
    expect(archiveA).toBe(true);
    expect(archiveB).toBe(true);

    const activeState = await fs.access(
      path.join(stateDir, 'active-c.state.json'),
    ).then(() => true).catch(() => false);
    expect(activeState).toBe(true);
  });
});

describe('Telemetry Rotation', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * Five events are 10 days old and five are 1 day old. The retention is 7 days,
   * so only the five recent events stay.
   */
  it('rotateTelemetry_PrunesOldSQLiteRows', async () => {
    const backend = new InMemoryBackend();
    const now = new Date();
    const oldTimestamp = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const newTimestamp = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

    for (let i = 1; i <= 5; i++) {
      backend.appendEvent('telemetry', {
        streamId: 'telemetry',
        sequence: i,
        timestamp: oldTimestamp,
        type: 'tool.invoked',
        schemaVersion: '1.0',
        data: { tool: 'old-tool' },
      });
    }

    for (let i = 6; i <= 10; i++) {
      backend.appendEvent('telemetry', {
        streamId: 'telemetry',
        sequence: i,
        timestamp: newTimestamp,
        type: 'tool.invoked',
        schemaVersion: '1.0',
        data: { tool: 'new-tool' },
      });
    }

    const policy: LifecyclePolicy = {
      ...DEFAULT_LIFECYCLE_POLICY,
      maxTelemetryEvents: 10,
      telemetryRetentionDays: 7,
    };

    await rotateTelemetry(backend, stateDir, policy);

    const remaining = backend.queryEvents('telemetry');
    expect(remaining.length).toBe(5);
    for (const event of remaining) {
      expect(event.timestamp).toBe(newTimestamp);
    }
  });

});

describe('StorageBackend Lifecycle Methods', () => {
  /** `other-stream` must keep its event. */
  it('deleteStream_RemovesAllEventsForStream', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    for (let i = 1; i <= 5; i++) {
      backend.appendEvent('stream-to-delete', {
        streamId: 'stream-to-delete',
        sequence: i,
        timestamp: new Date().toISOString(),
        type: 'workflow.started',
        schemaVersion: '1.0',
      } as never);
    }
    backend.appendEvent('other-stream', {
      streamId: 'other-stream',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      schemaVersion: '1.0',
    } as never);

    expect(backend.queryEvents('stream-to-delete')).toHaveLength(5);

    backend.deleteStream('stream-to-delete');

    expect(backend.queryEvents('stream-to-delete')).toHaveLength(0);
    expect(backend.getSequence('stream-to-delete')).toBe(0);
    expect(backend.listStreams()).not.toContain('stream-to-delete');
    expect(backend.queryEvents('other-stream')).toHaveLength(1);
  });

  /** `other-feature` must keep its state. */
  it('deleteState_RemovesStateForFeature', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    backend.setState('feature-to-delete', {
      version: '4.0',
      featureId: 'feature-to-delete',
      workflowType: 'feature',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: 'completed',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      _version: 1,
      _history: {},
      _checkpoint: { timestamp: '2025-01-01T00:00:00Z', phase: 'completed', summary: 'test', operationsSince: 0, fixCycleCount: 0, lastActivityTimestamp: '2025-01-01T00:00:00Z', staleAfterMinutes: 120 },
    } as never);
    backend.setState('other-feature', {
      version: '4.0',
      featureId: 'other-feature',
      workflowType: 'feature',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: 'ideate',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      _version: 1,
      _history: {},
      _checkpoint: { timestamp: '2025-01-01T00:00:00Z', phase: 'ideate', summary: 'test', operationsSince: 0, fixCycleCount: 0, lastActivityTimestamp: '2025-01-01T00:00:00Z', staleAfterMinutes: 120 },
    } as never);

    expect(backend.getState('feature-to-delete')).not.toBeNull();

    backend.deleteState('feature-to-delete');

    expect(backend.getState('feature-to-delete')).toBeNull();
    expect(backend.getState('other-feature')).not.toBeNull();
  });

  it('pruneEvents_RemovesEventsBeforeTimestamp', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    const oldTimestamp = '2024-01-01T00:00:00.000Z';
    const newTimestamp = '2025-06-15T00:00:00.000Z';

    for (let i = 1; i <= 3; i++) {
      backend.appendEvent('telemetry', {
        streamId: 'telemetry',
        sequence: i,
        timestamp: oldTimestamp,
        type: 'tool.invoked',
        schemaVersion: '1.0',
      } as never);
    }
    for (let i = 4; i <= 6; i++) {
      backend.appendEvent('telemetry', {
        streamId: 'telemetry',
        sequence: i,
        timestamp: newTimestamp,
        type: 'tool.invoked',
        schemaVersion: '1.0',
      } as never);
    }

    expect(backend.queryEvents('telemetry')).toHaveLength(6);

    const pruned = backend.pruneEvents('telemetry', '2025-01-01T00:00:00.000Z');

    expect(pruned).toBe(3);
    const remaining = backend.queryEvents('telemetry');
    expect(remaining).toHaveLength(3);
    for (const event of remaining) {
      expect(event.timestamp).toBe(newTimestamp);
    }
  });

  it('pruneEvents_AllEventsOlderThanCutoff_DeletesStream', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    for (let i = 1; i <= 3; i++) {
      backend.appendEvent('telemetry', {
        streamId: 'telemetry',
        sequence: i,
        timestamp: '2024-01-01T00:00:00.000Z',
        type: 'tool.invoked',
        schemaVersion: '1.0',
      } as never);
    }

    const pruned = backend.pruneEvents('telemetry', '2026-01-01T00:00:00.000Z');

    expect(pruned).toBe(3);
    expect(backend.queryEvents('telemetry')).toHaveLength(0);
  });

  it('pruneEvents_NoEventsForStream_ReturnsZero', () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const pruned = backend.pruneEvents('nonexistent', '2025-01-01T00:00:00.000Z');

    expect(pruned).toBe(0);
  });
});

describe('compactWorkflow Backend Interface', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('compactWorkflow_WithBackend_CallsDeleteStreamAndDeleteState', async () => {
    const featureId = 'interface-check';
    const updatedAt = daysAgo(60);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 3);

    const backend = new InMemoryBackend();
    backend.initialize();
    for (let i = 1; i <= 3; i++) {
      backend.appendEvent(featureId, {
        streamId: featureId,
        sequence: i,
        timestamp: new Date().toISOString(),
        type: 'workflow.started',
        schemaVersion: '1.0',
      } as never);
    }
    backend.setState(featureId, {
      version: '4.0',
      featureId,
      workflowType: 'feature',
      createdAt: updatedAt,
      updatedAt,
      phase: 'completed',
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      synthesis: { integrationBranch: null, mergeOrder: [], mergedBranches: [], prUrl: null, prFeedback: [] },
      _version: 1,
      _history: {},
      _checkpoint: { timestamp: updatedAt, phase: 'completed', summary: 'test', operationsSince: 0, fixCycleCount: 0, lastActivityTimestamp: updatedAt, staleAfterMinutes: 120 },
    } as never);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    await compactWorkflow(backend, stateDir, featureId, policy);

    expect(backend.queryEvents(featureId)).toHaveLength(0);
    expect(backend.getState(featureId)).toBeNull();
    expect(backend.listStreams()).not.toContain(featureId);
  });
});
