/**
 * Tests for the prefix-fingerprint CI gate (task T047, DR-12).
 *
 * Phase progression:
 *   - RED: `tools/audit/gates/check-prefix-fingerprint.mjs` does not yet exist; these
 *     tests fail because spawning the script yields ENOENT.
 *   - GREEN: the `.mjs` wrapper shells out to `tsx` against the canonical TS
 *     fingerprint module, reads the committed `PREFIX_FINGERPRINT` file, and
 *     exits 0 on match / 1 on mismatch. The `validate` chain in the root
 *     `package.json` is extended to invoke it.
 *
 * Rationale: DR-12 requires that any edit to the rehydration document's
 * stable-prefix inputs (JSON schema shape, MCP tool description bytes) be
 * caught before it silently invalidates prompt caches downstream. The hash
 * computation lives in `src/projections/rehydration/
 * fingerprint.ts`; this gate reruns it and compares against the committed
 * value. The tests below exercise the CLI contract only — the computation
 * itself is covered by `fingerprint.test.ts`.
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
 * Spawn the check script and capture status / stdout / stderr. The script
 * receives an optional `--fingerprint-file <path>` override so tests can
 * point at a temp file with a wrong hash; production callers (the validate
 * chain) invoke it with no arguments and default to the committed file.
 */
async function runCheck(extraArgs: string[] = []): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const result = await spawnAsync('node', [SCRIPT, ...extraArgs], {
    cwd: REPO_ROOT,
    // The script shells out to `tsx`; inherit PATH + node-path env.
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
    // The GREEN step creates this file. In RED it must not exist, so this
    // assertion fails in RED and passes in GREEN.
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('Validate_MatchingFingerprint_ExitsZero', async () => {
    // Real committed value — should match the live computation and exit 0.
    // A non-zero exit here means either the committed hash has drifted or
    // the wrapper is wired incorrectly.
    const { status, stdout, stderr } = await runCheck();
    expect(status, `stderr: ${stderr}\nstdout: ${stdout}`).toBe(0);
  });

  it('Validate_DivergentFingerprint_ExitsNonZero', async () => {
    // Create a temp copy of the committed file with a deliberately-wrong
    // hash; the script must exit non-zero and print both expected + actual
    // hashes to stderr so CI diagnostics are actionable.
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
      // The diagnostic surface must name both the expected (committed/wrong)
      // value and the actual (computed) value so reviewers can tell whether
      // to regenerate the file or roll back the template edit.
      expect(stderr).toMatch(/expected/i);
      expect(stderr).toMatch(/actual/i);
      expect(stderr).toMatch(/0{64}/u);
    } finally {
      rmrf(dir);
    }
  });

  it('Validate_DefaultFingerprintFile_ReadsCommittedPath', async () => {
    // Sanity: with no args the script reads the real committed file and
    // succeeds. This protects against regressions where the default path is
    // silently broken (e.g. a relative-cwd bug) while an explicit override
    // still works.
    const committed = readFileSync(COMMITTED_FINGERPRINT, 'utf8').trim();
    expect(committed).toMatch(/^[0-9a-f]{64}$/u);

    const { status } = await runCheck();
    expect(status).toBe(0);
  });
});
