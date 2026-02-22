import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Track writeFile calls and allow simulating rename failures
const writeFileCalls: { path: string; data: string }[] = [];
let renameFailOnce = false;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    writeFile: vi.fn(async (filePath: string, data: string, encoding?: string) => {
      writeFileCalls.push({ path: filePath, data: typeof data === 'string' ? data : '' });
      return actual.writeFile(filePath, data, encoding as BufferEncoding);
    }),
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      if (renameFailOnce) {
        renameFailOnce = false;
        throw new Error('Simulated crash during rename');
      }
      return actual.rename(oldPath, newPath);
    }),
  };
});

// Import AFTER mock setup
const { compactWorkflow, DEFAULT_LIFECYCLE_POLICY } = await import('./lifecycle.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a temporary directory for each test. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'lifecycle-atomic-test-'));
}

/** Write a minimal state JSON file. */
async function writeState(
  stateDir: string,
  featureId: string,
  phase: string,
  updatedAt: string,
): Promise<void> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const state = {
    version: '4.0',
    featureId,
    workflowType: 'feature',
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
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
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
  await writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
}

/** Get a date string N days in the past. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ─── Atomic Archive Write Tests ─────────────────────────────────────────────

describe('Atomic Archive Writes', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir();
    writeFileCalls.length = 0;
    renameFailOnce = false;
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('compactWorkflow_ArchiveWrite_IsAtomic', async () => {
    // Arrange
    const featureId = 'atomic-archive';
    const updatedAt = daysAgo(60);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 3);

    const archiveDir = path.join(stateDir, 'archives');
    const archivePath = path.join(archiveDir, `${featureId}.archive.json`);
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    // Clear tracked calls to focus on compactWorkflow
    writeFileCalls.length = 0;

    // Act
    await compactWorkflow(undefined, stateDir, featureId, policy);

    // Assert — writeFile was called to a .tmp file for the archive (not the final path)
    const archiveWriteCall = writeFileCalls.find(
      (call) => call.path.includes('.archive.json'),
    );
    expect(archiveWriteCall).toBeDefined();
    expect(archiveWriteCall!.path).toContain('.tmp');
    expect(archiveWriteCall!.path).not.toBe(archivePath);

    // Assert — final archive exists and is valid
    const archiveRaw = await readFile(archivePath, 'utf-8');
    const archive = JSON.parse(archiveRaw);
    expect(archive.featureId).toBe(featureId);
    expect(archive.eventCount).toBe(3);
  });

  it('compactWorkflow_CrashDuringArchiveRename_PreservesExistingArchive', async () => {
    // Arrange — write a pre-existing archive
    const featureId = 'crash-archive';
    const updatedAt = daysAgo(60);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 3);

    const archiveDir = path.join(stateDir, 'archives');
    await mkdir(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${featureId}.archive.json`);

    // Write a pre-existing archive that should survive a crash
    const existingArchive = { featureId, archivedAt: '2025-01-01T00:00:00Z', finalState: { phase: 'completed' }, eventCount: 99 };
    await writeFile(archivePath, JSON.stringify(existingArchive), 'utf-8');

    const policy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    // Act — simulate crash during rename
    renameFailOnce = true;
    writeFileCalls.length = 0;

    try {
      await compactWorkflow(undefined, stateDir, featureId, policy);
    } catch {
      // Expected: rename fails
    }

    // Assert — pre-existing archive should NOT be corrupted
    const afterRaw = await readFile(archivePath, 'utf-8');
    const afterArchive = JSON.parse(afterRaw);
    expect(afterArchive.eventCount).toBe(99); // Original value preserved
  });
});
