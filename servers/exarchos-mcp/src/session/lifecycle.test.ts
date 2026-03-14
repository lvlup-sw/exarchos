import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Session Lifecycle', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  /**
   * Helper: create a session events file with controlled mtime and size.
   */
  async function createSessionFile(
    sessionsDir: string,
    filename: string,
    options: { ageInDays: number; sizeBytes?: number },
  ): Promise<void> {
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, filename);
    const content = options.sizeBytes
      ? 'x'.repeat(options.sizeBytes)
      : '{"t":"tool","ts":"2026-01-01T00:00:00Z"}\n';
    await fs.writeFile(filePath, content, 'utf-8');

    const now = Date.now();
    const mtime = new Date(now - options.ageInDays * 24 * 60 * 60 * 1000);
    await fs.utimes(filePath, mtime, mtime);
  }

  it('pruneSessionFiles_OlderThanRetention_Deletes', async () => {
    const { pruneSessionFiles } = await import('./lifecycle.js');
    const sessionsDir = path.join(tmpDir, 'sessions');

    // Create files: one 10 days old (should be deleted), one 3 days old (should be kept)
    await createSessionFile(sessionsDir, 'old-session.events.jsonl', { ageInDays: 10, sizeBytes: 100 });
    await createSessionFile(sessionsDir, 'recent-session.events.jsonl', { ageInDays: 3, sizeBytes: 100 });

    const result = await pruneSessionFiles(tmpDir, { retentionDays: 7 });

    expect(result.deleted).toBe(1);
    expect(result.freedBytes).toBe(100);

    // Old file should be gone
    await expect(fs.access(path.join(sessionsDir, 'old-session.events.jsonl'))).rejects.toThrow();
    // Recent file should still exist
    const stat = await fs.stat(path.join(sessionsDir, 'recent-session.events.jsonl'));
    expect(stat.isFile()).toBe(true);
  });

  it('pruneSessionFiles_WithinRetention_Keeps', async () => {
    const { pruneSessionFiles } = await import('./lifecycle.js');
    const sessionsDir = path.join(tmpDir, 'sessions');

    await createSessionFile(sessionsDir, 'session-1.events.jsonl', { ageInDays: 1, sizeBytes: 200 });
    await createSessionFile(sessionsDir, 'session-2.events.jsonl', { ageInDays: 5, sizeBytes: 300 });

    const result = await pruneSessionFiles(tmpDir, { retentionDays: 7 });

    expect(result.deleted).toBe(0);
    expect(result.freedBytes).toBe(0);

    // Both files should still exist
    const stat1 = await fs.stat(path.join(sessionsDir, 'session-1.events.jsonl'));
    expect(stat1.isFile()).toBe(true);
    const stat2 = await fs.stat(path.join(sessionsDir, 'session-2.events.jsonl'));
    expect(stat2.isFile()).toBe(true);
  });

  it('pruneSessionFiles_ExceedsSizeCap_DeletesOldestFirst', async () => {
    const { pruneSessionFiles } = await import('./lifecycle.js');
    const sessionsDir = path.join(tmpDir, 'sessions');

    // Create three files within retention but exceeding 1MB total cap
    // Using a tiny cap (1MB) for testing. Files: 500KB each = 1.5MB total
    const halfMB = 500 * 1024;
    await createSessionFile(sessionsDir, 'oldest.events.jsonl', { ageInDays: 5, sizeBytes: halfMB });
    await createSessionFile(sessionsDir, 'middle.events.jsonl', { ageInDays: 3, sizeBytes: halfMB });
    await createSessionFile(sessionsDir, 'newest.events.jsonl', { ageInDays: 1, sizeBytes: halfMB });

    // Cap at 1MB -- oldest should be deleted to bring total under cap
    const result = await pruneSessionFiles(tmpDir, { retentionDays: 7, maxSizeMB: 1 });

    expect(result.deleted).toBe(1);
    expect(result.freedBytes).toBe(halfMB);

    // Oldest should be gone
    await expect(fs.access(path.join(sessionsDir, 'oldest.events.jsonl'))).rejects.toThrow();
    // Middle and newest should remain
    const stat1 = await fs.stat(path.join(sessionsDir, 'middle.events.jsonl'));
    expect(stat1.isFile()).toBe(true);
    const stat2 = await fs.stat(path.join(sessionsDir, 'newest.events.jsonl'));
    expect(stat2.isFile()).toBe(true);
  });

  it('pruneSessionFiles_EmptyDir_Noop', async () => {
    const { pruneSessionFiles } = await import('./lifecycle.js');

    // sessions dir does not exist at all
    const result = await pruneSessionFiles(tmpDir);

    expect(result.deleted).toBe(0);
    expect(result.freedBytes).toBe(0);
  });

  it('pruneSessionFiles_ManifestFile_NeverDeleted', async () => {
    const { pruneSessionFiles } = await import('./lifecycle.js');
    const sessionsDir = path.join(tmpDir, 'sessions');

    // Create a .manifest.jsonl that is very old -- should never be deleted
    await createSessionFile(sessionsDir, '.manifest.jsonl', { ageInDays: 30, sizeBytes: 1000 });
    // Create an old events file that should be deleted
    await createSessionFile(sessionsDir, 'old-session.events.jsonl', { ageInDays: 10, sizeBytes: 200 });

    const result = await pruneSessionFiles(tmpDir, { retentionDays: 7 });

    expect(result.deleted).toBe(1);
    expect(result.freedBytes).toBe(200);

    // .manifest.jsonl must still exist
    const stat = await fs.stat(path.join(sessionsDir, '.manifest.jsonl'));
    expect(stat.isFile()).toBe(true);
  });
});
