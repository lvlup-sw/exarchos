/**
 * Tests for the CLI contract of the prefix-fingerprint gate.
 *
 * The gate hashes the stable-prefix inputs of the rehydration document: the JSON
 * schema shape and the MCP tool description bytes. It compares the hash with the
 * committed `PREFIX_FINGERPRINT` file. A change to those inputs invalidates
 * downstream prompt caches.
 * `tests/unit/projections/rehydration/fingerprint.test.ts` covers the hash computation.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'tools', 'audit', 'gates', 'check-prefix-fingerprint.mjs');
const COMMITTED_FINGERPRINT = path.join(
  REPO_ROOT,
  'src',
  'projections',
  'rehydration',
  'PREFIX_FINGERPRINT',
);

/**
 * Spawns the check script. `--fingerprint-file <path>` points the script at a
 * different hash file. With no arguments the script reads the committed file.
 * The script runs `tsx`, so the child inherits the full environment.
 */
async function runCheck(extraArgs: string[] = []): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const result = await spawnAsync('node', [SCRIPT, ...extraArgs], {
    cwd: REPO_ROOT,
    env: { ...process.env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('check-prefix-fingerprint CLI (T047, DR-12)', () => {
  it('Script_Exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  /** A non-zero exit means that the committed hash drifted, or that the wrapper is wired incorrectly. */
  it('Validate_MatchingFingerprint_ExitsZero', async () => {
    const { status, stdout, stderr } = await runCheck();
    expect(status, `stderr: ${stderr}\nstdout: ${stdout}`).toBe(0);
  });

  /**
   * The diagnostic must name the expected value from the file and the computed
   * value. A reviewer then knows whether to regenerate the file or to revert the edit.
   */
  it('Validate_DivergentFingerprint_ExitsNonZero', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prefix-fingerprint-'));
    try {
      const wrongFile = path.join(dir, 'PREFIX_FINGERPRINT');
      writeFileSync(
        wrongFile,
        '0000000000000000000000000000000000000000000000000000000000000000\n',
        'utf8',
      );

      const { status, stderr } = await runCheck(['--fingerprint-file', wrongFile]);

      expect(status).not.toBe(0);
      expect(stderr).toMatch(/expected/i);
      expect(stderr).toMatch(/actual/i);
      expect(stderr).toMatch(/0{64}/u);
    } finally {
      rmrf(dir);
    }
  });

  /**
   * With no arguments the script must read the committed file and exit 0. An
   * explicit override can hide a broken default path.
   */
  it('Validate_DefaultFingerprintFile_ReadsCommittedPath', async () => {
    const committed = readFileSync(COMMITTED_FINGERPRINT, 'utf8').trim();
    expect(committed).toMatch(/^[0-9a-f]{64}$/u);

    const { status } = await runCheck();
    expect(status).toBe(0);
  });
});
