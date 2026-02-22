import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryBackend } from './memory-backend.js';
import {
  compactWorkflow,
  checkCompaction,
  rotateTelemetry,
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
} from './lifecycle.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Task 17: Workflow Compaction ──────────────────────────────────────────

describe('Workflow Compaction', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it('compactWorkflow_CompletedAndOlderThanRetention_ArchivesAndDeletes', async () => {
    // Arrange
    const featureId = 'old-feature';
    const updatedAt = daysAgo(60);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 5);

    const backend = new InMemoryBackend();
    // Seed backend with events
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

    // Act
    await compactWorkflow(backend, stateDir, featureId, policy);

    // Assert — archive exists
    const archivePath = path.join(stateDir, 'archives', `${featureId}.archive.json`);
    const archiveExists = await fs.access(archivePath).then(() => true).catch(() => false);
    expect(archiveExists).toBe(true);

    // Assert — JSONL file deleted
    const jsonlPath = path.join(stateDir, `${featureId}.events.jsonl`);
    const jsonlExists = await fs.access(jsonlPath).then(() => true).catch(() => false);
    expect(jsonlExists).toBe(false);

    // Assert — state file deleted
    const statePath = path.join(stateDir, `${featureId}.state.json`);
    const stateExists = await fs.access(statePath).then(() => true).catch(() => false);
    expect(stateExists).toBe(false);

    // Assert — backend rows cleaned
    expect(backend.queryEvents(featureId)).toHaveLength(0);
    expect(backend.getState(featureId)).toBeNull();
  });

  it('compactWorkflow_ActiveWorkflow_NoOps', async () => {
    // Arrange
    const featureId = 'active-feature';
    const updatedAt = daysAgo(60);
    await writeState(stateDir, featureId, 'delegate', updatedAt);
    await writeEvents(stateDir, featureId, 3);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    // Act
    await compactWorkflow(undefined, stateDir, featureId, policy);

    // Assert — nothing archived
    const archivePath = path.join(stateDir, 'archives', `${featureId}.archive.json`);
    const archiveExists = await fs.access(archivePath).then(() => true).catch(() => false);
    expect(archiveExists).toBe(false);

    // Assert — JSONL still exists
    const jsonlPath = path.join(stateDir, `${featureId}.events.jsonl`);
    const jsonlExists = await fs.access(jsonlPath).then(() => true).catch(() => false);
    expect(jsonlExists).toBe(true);

    // Assert — state file still exists
    const statePath = path.join(stateDir, `${featureId}.state.json`);
    const stateExists = await fs.access(statePath).then(() => true).catch(() => false);
    expect(stateExists).toBe(true);
  });

  it('compactWorkflow_CompletedButTooRecent_NoOps', async () => {
    // Arrange
    const featureId = 'recent-feature';
    const updatedAt = daysAgo(5);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 2);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    // Act
    await compactWorkflow(undefined, stateDir, featureId, policy);

    // Assert — nothing archived
    const archivePath = path.join(stateDir, 'archives', `${featureId}.archive.json`);
    const archiveExists = await fs.access(archivePath).then(() => true).catch(() => false);
    expect(archiveExists).toBe(false);

    // Assert — JSONL still exists
    const jsonlPath = path.join(stateDir, `${featureId}.events.jsonl`);
    const jsonlExists = await fs.access(jsonlPath).then(() => true).catch(() => false);
    expect(jsonlExists).toBe(true);
  });

  it('compactWorkflow_ArchiveContainsFinalStateAndEventCount', async () => {
    // Arrange
    const featureId = 'archive-check';
    const updatedAt = daysAgo(45);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 7);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    // Act
    await compactWorkflow(undefined, stateDir, featureId, policy);

    // Assert — archive has finalState + eventCount
    const archivePath = path.join(stateDir, 'archives', `${featureId}.archive.json`);
    const archiveRaw = await fs.readFile(archivePath, 'utf-8');
    const archive = JSON.parse(archiveRaw);

    expect(archive.finalState).toBeDefined();
    expect(archive.finalState.featureId).toBe(featureId);
    expect(archive.finalState.phase).toBe('completed');
    expect(archive.eventCount).toBe(7);
  });

  it('compactWorkflow_DeletesJSONLAndSQLiteRows', async () => {
    // Arrange
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

    // Act
    await compactWorkflow(backend, stateDir, featureId, policy);

    // Assert — JSONL deleted
    const jsonlExists = await fs.access(
      path.join(stateDir, `${featureId}.events.jsonl`),
    ).then(() => true).catch(() => false);
    expect(jsonlExists).toBe(false);

    // Assert — SQLite rows deleted
    expect(backend.queryEvents(featureId)).toHaveLength(0);
    expect(backend.getState(featureId)).toBeNull();
  });

  it('checkCompaction_OnStartup_CompactsEligibleWorkflows', async () => {
    // Arrange — two completed (old), one active
    await writeState(stateDir, 'old-a', 'completed', daysAgo(60));
    await writeEvents(stateDir, 'old-a', 3);

    await writeState(stateDir, 'old-b', 'completed', daysAgo(45));
    await writeEvents(stateDir, 'old-b', 2);

    await writeState(stateDir, 'active-c', 'delegate', daysAgo(60));
    await writeEvents(stateDir, 'active-c', 5);

    const policy: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    // Act
    await checkCompaction(undefined, stateDir, policy);

    // Assert — old-a and old-b archived
    const archiveA = await fs.access(
      path.join(stateDir, 'archives', 'old-a.archive.json'),
    ).then(() => true).catch(() => false);
    const archiveB = await fs.access(
      path.join(stateDir, 'archives', 'old-b.archive.json'),
    ).then(() => true).catch(() => false);
    expect(archiveA).toBe(true);
    expect(archiveB).toBe(true);

    // Assert — active-c untouched
    const activeState = await fs.access(
      path.join(stateDir, 'active-c.state.json'),
    ).then(() => true).catch(() => false);
    expect(activeState).toBe(true);
  });

  it('checkCompaction_TotalSizeExceedsLimit_EmitsWarning', async () => {
    // Arrange — create a large JSONL file to exceed size limit
    await writeState(stateDir, 'big-feature', 'delegate', daysAgo(1));

    // Write a big JSONL file (we'll use a tiny limit to trigger warning)
    const bigJsonlPath = path.join(stateDir, 'big-feature.events.jsonl');
    const bigLine = JSON.stringify({
      streamId: 'big-feature',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'workflow.started',
      schemaVersion: '1.0',
      data: { padding: 'x'.repeat(1024) },
    });
    await fs.writeFile(bigJsonlPath, bigLine + '\n', 'utf-8');

    // Use a very small maxTotalSizeMB to trigger warning
    const policy: LifecyclePolicy = {
      ...DEFAULT_LIFECYCLE_POLICY,
      maxTotalSizeMB: 0.0001, // ~100 bytes
    };

    // Spy on logger
    const { logger } = await import('../logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    // Act
    await checkCompaction(undefined, stateDir, policy);

    // Assert — warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ totalSizeMB: expect.any(Number) }),
      expect.stringContaining('exceeds'),
    );

    warnSpy.mockRestore();
  });
});

// ─── Task 18: Telemetry Rotation ──────────────────────────────────────────

describe('Telemetry Rotation', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  /** Write telemetry JSONL with N events. */
  async function writeTelemetryEvents(dir: string, count: number): Promise<void> {
    const filePath = path.join(dir, 'telemetry.events.jsonl');
    const lines: string[] = [];
    for (let i = 1; i <= count; i++) {
      lines.push(JSON.stringify({
        streamId: 'telemetry',
        sequence: i,
        timestamp: new Date().toISOString(),
        type: 'tool.invoked',
        schemaVersion: '1.0',
        data: { tool: 'test-tool' },
      }));
    }
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
  }

  it('rotateTelemetry_ExceedsMaxEvents_RotatesJSONL', async () => {
    // Arrange — write more events than max
    await writeTelemetryEvents(stateDir, 15);

    const policy: LifecyclePolicy = {
      ...DEFAULT_LIFECYCLE_POLICY,
      maxTelemetryEvents: 10,
    };

    // Act
    await rotateTelemetry(undefined, stateDir, policy);

    // Assert — original file is gone (renamed to .1)
    const originalPath = path.join(stateDir, 'telemetry.events.jsonl');
    const originalExists = await fs.access(originalPath).then(() => true).catch(() => false);
    expect(originalExists).toBe(false);

    // Assert — .1 file exists
    const rotated1Path = `${originalPath}.1`;
    const rotated1Exists = await fs.access(rotated1Path).then(() => true).catch(() => false);
    expect(rotated1Exists).toBe(true);
  });

  it('rotateTelemetry_BelowMaxEvents_NoOps', async () => {
    // Arrange — write fewer events than max
    await writeTelemetryEvents(stateDir, 5);

    const policy: LifecyclePolicy = {
      ...DEFAULT_LIFECYCLE_POLICY,
      maxTelemetryEvents: 10,
    };

    // Act
    await rotateTelemetry(undefined, stateDir, policy);

    // Assert — original file still exists (no rotation)
    const originalPath = path.join(stateDir, 'telemetry.events.jsonl');
    const originalExists = await fs.access(originalPath).then(() => true).catch(() => false);
    expect(originalExists).toBe(true);

    // Assert — no .1 file
    const rotated1Path = `${originalPath}.1`;
    const rotated1Exists = await fs.access(rotated1Path).then(() => true).catch(() => false);
    expect(rotated1Exists).toBe(false);
  });

  it('rotateTelemetry_KeepsAtMostTwoRotatedFiles', async () => {
    // Arrange — create pre-existing .1 and .2 files, then write exceeding events
    const telemetryPath = path.join(stateDir, 'telemetry.events.jsonl');
    const rotated1Path = `${telemetryPath}.1`;
    const rotated2Path = `${telemetryPath}.2`;

    // Pre-existing .2 (should be deleted)
    await fs.writeFile(rotated2Path, '{"old":"data2"}\n', 'utf-8');
    // Pre-existing .1 (should become .2)
    await fs.writeFile(rotated1Path, '{"old":"data1"}\n', 'utf-8');
    // Current telemetry (exceeds limit, should become .1)
    await writeTelemetryEvents(stateDir, 15);

    const policy: LifecyclePolicy = {
      ...DEFAULT_LIFECYCLE_POLICY,
      maxTelemetryEvents: 10,
    };

    // Act
    await rotateTelemetry(undefined, stateDir, policy);

    // Assert — .1 contains the old current data (15 events)
    const rotated1Content = await fs.readFile(rotated1Path, 'utf-8');
    const rotated1Lines = rotated1Content.trim().split('\n').filter(Boolean);
    expect(rotated1Lines.length).toBe(15);

    // Assert — .2 contains the old .1 data
    const rotated2Content = await fs.readFile(rotated2Path, 'utf-8');
    expect(rotated2Content.trim()).toBe('{"old":"data1"}');

    // Assert — original telemetry file is gone
    const originalExists = await fs.access(telemetryPath).then(() => true).catch(() => false);
    expect(originalExists).toBe(false);
  });

  it('rotateTelemetry_PrunesOldSQLiteRows', async () => {
    // Arrange — backend with old and new telemetry events
    await writeTelemetryEvents(stateDir, 15);

    const backend = new InMemoryBackend();
    const now = new Date();
    const oldTimestamp = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const newTimestamp = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

    // Add old events
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

    // Add new events
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

    // Act
    await rotateTelemetry(backend, stateDir, policy);

    // Assert — old events pruned, new events kept
    const remaining = backend.queryEvents('telemetry');
    expect(remaining.length).toBe(5); // Only the 5 recent events remain
    for (const event of remaining) {
      expect(event.timestamp).toBe(newTimestamp);
    }
  });

  it('rotateTelemetry_RotatedFileIsReadableJSONL', async () => {
    // Arrange
    await writeTelemetryEvents(stateDir, 20);

    const policy: LifecyclePolicy = {
      ...DEFAULT_LIFECYCLE_POLICY,
      maxTelemetryEvents: 10,
    };

    // Act
    await rotateTelemetry(undefined, stateDir, policy);

    // Assert — rotated .1 file is valid JSONL
    const rotated1Path = path.join(stateDir, 'telemetry.events.jsonl.1');
    const content = await fs.readFile(rotated1Path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    expect(lines.length).toBe(20);

    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.streamId).toBe('telemetry');
      expect(parsed.type).toBe('tool.invoked');
      expect(typeof parsed.sequence).toBe('number');
    }
  });
});
