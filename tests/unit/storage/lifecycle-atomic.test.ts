import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** Records each call to the mocked `writeFile`. */
const writeFileCalls: { path: string; data: string }[] = [];
/** When true, the next call to the mocked `rename` throws, and the flag resets. */
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

/** A dynamic import, so the module loads after the `vi.mock` call above. */
const { compactWorkflow, DEFAULT_LIFECYCLE_POLICY } = await import('../../../src/storage/lifecycle.js');

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

describe('Atomic Archive Writes', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir();
    writeFileCalls.length = 0;
    renameFailOnce = false;
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * The archive write must go to a `.tmp` path, and a rename must then put it at
   * the final path. With no backend, `eventCount` is 0.
   */
  it('compactWorkflow_ArchiveWrite_IsAtomic', async () => {
    const featureId = 'atomic-archive';
    const updatedAt = daysAgo(60);
    await writeState(stateDir, featureId, 'completed', updatedAt);

    const archiveDir = path.join(stateDir, 'archives');
    const archivePath = path.join(archiveDir, `${featureId}.archive.json`);
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    writeFileCalls.length = 0;

    await compactWorkflow(undefined, stateDir, featureId, policy);

    const archiveWriteCall = writeFileCalls.find(
      (call) => call.path.includes('.archive.json'),
    );
    expect(archiveWriteCall).toBeDefined();
    expect(archiveWriteCall!.path).toContain('.tmp');
    expect(archiveWriteCall!.path).not.toBe(archivePath);

    const archiveRaw = await readFile(archivePath, 'utf-8');
    const archive = JSON.parse(archiveRaw);
    expect(archive.featureId).toBe(featureId);
    expect(archive.eventCount).toBe(0);
  });

  /** The mocked rename throws once. The archive that existed before must keep its content. */
  it('compactWorkflow_CrashDuringArchiveRename_PreservesExistingArchive', async () => {
    const featureId = 'crash-archive';
    const updatedAt = daysAgo(60);
    await writeState(stateDir, featureId, 'completed', updatedAt);
    await writeEvents(stateDir, featureId, 3);

    const archiveDir = path.join(stateDir, 'archives');
    await mkdir(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${featureId}.archive.json`);

    const existingArchive = { featureId, archivedAt: '2025-01-01T00:00:00Z', finalState: { phase: 'completed' }, eventCount: 99 };
    await writeFile(archivePath, JSON.stringify(existingArchive), 'utf-8');

    const policy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };

    renameFailOnce = true;
    writeFileCalls.length = 0;

    await expect(
      compactWorkflow(undefined, stateDir, featureId, policy),
    ).rejects.toThrow('Simulated crash during rename');

    const afterRaw = await readFile(archivePath, 'utf-8');
    const afterArchive = JSON.parse(afterRaw);
    expect(afterArchive.eventCount).toBe(99);
  });

  /** Two archive writes in one millisecond must not share a temp path, or one rename finds it gone. */
  it('compactWorkflow_TwoCompactionsInOneMillisecond_BothResolveAndTheArchiveIsWhole', async () => {
    const featureId = 'same-millisecond';
    await writeState(stateDir, featureId, 'completed', daysAgo(60));
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, retentionDays: 30 };
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const results = await Promise.allSettled([
        compactWorkflow(undefined, stateDir, featureId, policy),
        compactWorkflow(undefined, stateDir, featureId, policy),
      ]);

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const archive = JSON.parse(
        await readFile(path.join(stateDir, 'archives', `${featureId}.archive.json`), 'utf-8'),
      );
      expect(archive.featureId).toBe(featureId);
    } finally {
      now.mockRestore();
    }
  });
});
