import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleSessionStart } from '../../../src/lifecycle/session-start.js';
import { readManifestEntries } from '../../../src/projections/session/manifest.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * `session-start` is an observe-only hook. It writes a start entry to the session manifest and
 * returns the orientation directive as `additionalContext`.
 * It must not write `sessions/<id>.events.jsonl`, because `session-end` uses that file as its
 * idempotency sentinel.
 */
describe('session-start command', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-start-test-'));
    stateDir = path.join(tmpDir, 'state');
    await fs.mkdir(path.join(stateDir, 'sessions'), { recursive: true });
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /** The hook adapter turns a handler error into exit code 1, which can block the session. */
  it('handleSessionStart_MissingSessionId_FailOpenNoError', async () => {
    const result = await handleSessionStart({}, stateDir);
    expect(result.error).toBeUndefined();
    expect(result.continue).toBe(true);
    expect(await readManifestEntries(stateDir)).toHaveLength(0);
  });

  it('handleSessionStart_MissingSessionIdWithDirective_StillOrients', async () => {
    const result = await handleSessionStart({}, stateDir, { directive: 'Use Exarchos.' });
    expect(result.error).toBeUndefined();
    expect(result.additionalContext).toContain('Exarchos');
  });

  it('handleSessionStart_ValidInput_WritesManifestEntry', async () => {
    const result = await handleSessionStart(
      { session_id: 'sess-1', cwd: '/repo', transcript_path: '/t.jsonl' },
      stateDir,
    );
    expect(result.continue).toBe(true);
    const entries = await readManifestEntries(stateDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionId).toBe('sess-1');
    expect(entries[0]?.cwd).toBe('/repo');
    expect(typeof entries[0]?.startedAt).toBe('string');
  });

  it('handleSessionStart_NeverWritesEventsFile', async () => {
    await handleSessionStart({ session_id: 'sess-2' }, stateDir);
    const eventsPath = path.join(stateDir, 'sessions', 'sess-2.events.jsonl');
    await expect(fs.access(eventsPath)).rejects.toThrow();
  });

  it('handleSessionStart_WithDirective_ReturnsAdditionalContext', async () => {
    const result = await handleSessionStart(
      { session_id: 'sess-3' },
      stateDir,
      { directive: 'This project uses Exarchos. Route SDLC through exarchos_* tools.' },
    );
    expect(result.additionalContext).toContain('Exarchos');
    expect(result.continue).toBe(true);
  });

  it('handleSessionStart_DuplicateSession_Idempotent', async () => {
    await handleSessionStart({ session_id: 'dup' }, stateDir);
    await handleSessionStart({ session_id: 'dup' }, stateDir);
    const entries = await readManifestEntries(stateDir);
    expect(entries.filter((e) => e.sessionId === 'dup')).toHaveLength(1);
  });

  it('handleSessionStart_Observer_NeverReturnsPolicyError', async () => {
    const result = await handleSessionStart({ session_id: 'ok' }, stateDir);
    expect(result.error).toBeUndefined();
  });
});
