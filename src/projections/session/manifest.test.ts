import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionManifestEntry } from './types.js';

describe('Manifest Writer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  function makeEntry(overrides: Partial<SessionManifestEntry> = {}): SessionManifestEntry {
    return {
      sessionId: 'test-session-001',
      transcriptPath: '/home/user/.claude/projects/abc/session.jsonl',
      startedAt: '2026-02-24T10:00:00.000Z',
      cwd: '/home/user/project',
      ...overrides,
    };
  }

  it('writeManifestEntry_ValidEntry_AppendsToManifestFile', async () => {
    const { writeManifestEntry } = await import('./manifest.js');
    const entry = makeEntry();

    await writeManifestEntry(tmpDir, entry);

    const manifestPath = path.join(tmpDir, 'sessions', '.manifest.jsonl');
    const content = await fs.readFile(manifestPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.sessionId).toBe('test-session-001');
    expect(parsed.transcriptPath).toBe('/home/user/.claude/projects/abc/session.jsonl');
    expect(parsed.startedAt).toBe('2026-02-24T10:00:00.000Z');
    expect(parsed.cwd).toBe('/home/user/project');
  });

  it('writeManifestEntry_CreatesSessionsDir_IfNotExists', async () => {
    const { writeManifestEntry } = await import('./manifest.js');
    const entry = makeEntry();
    const sessionsDir = path.join(tmpDir, 'sessions');

    // Verify sessions dir does not exist yet
    await expect(fs.access(sessionsDir)).rejects.toThrow();

    await writeManifestEntry(tmpDir, entry);

    // Now sessions dir should exist
    const stat = await fs.stat(sessionsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('readManifestEntries_ReturnsAllEntries', async () => {
    const { writeManifestEntry, readManifestEntries } = await import('./manifest.js');
    const entries = [
      makeEntry({ sessionId: 'session-1' }),
      makeEntry({ sessionId: 'session-2' }),
      makeEntry({ sessionId: 'session-3' }),
    ];

    for (const entry of entries) {
      await writeManifestEntry(tmpDir, entry);
    }

    const result = await readManifestEntries(tmpDir);
    expect(result).toHaveLength(3);
    expect(result[0].sessionId).toBe('session-1');
    expect(result[1].sessionId).toBe('session-2');
    expect(result[2].sessionId).toBe('session-3');
  });

  it('readManifestEntries_EmptyFile_ReturnsEmptyArray', async () => {
    const { readManifestEntries } = await import('./manifest.js');

    // No manifest file exists
    const result = await readManifestEntries(tmpDir);
    expect(result).toEqual([]);
  });

  it('findUnextractedSessions_ReturnsSessionsWithoutEventsFile', async () => {
    const { writeManifestEntry, findUnextractedSessions } = await import('./manifest.js');

    const entry1 = makeEntry({ sessionId: 'extracted-session' });
    const entry2 = makeEntry({ sessionId: 'unextracted-session' });

    await writeManifestEntry(tmpDir, entry1);
    await writeManifestEntry(tmpDir, entry2);

    // Create events file for only the first session
    const eventsPath = path.join(tmpDir, 'sessions', 'extracted-session.events.jsonl');
    await fs.writeFile(eventsPath, '{"t":"summary"}\n', 'utf-8');

    const result = await findUnextractedSessions(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('unextracted-session');
  });
});
