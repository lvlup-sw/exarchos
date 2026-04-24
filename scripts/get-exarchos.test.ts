// Vitest wrapper for `scripts/get-exarchos.test.sh`.
//
// The primary test harness is the shell-native `get-exarchos.test.sh`
// (mirrors the pattern used by `validate-rm.test.sh` etc.). This TS
// wrapper exists so the shell test participates in `npm run test:run`
// (vitest's `include` globs pick up scripts test.ts files).
//
// The wrapper streams the full shell test output on failure so CI
// logs tell you exactly which scenario failed without re-running the
// shell harness by hand.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const SHELL_TEST = join(REPO_ROOT, 'scripts', 'get-exarchos.test.sh');

describe('scripts/get-exarchos.sh (shell harness)', () => {
  it('passes the full scripts/get-exarchos.test.sh suite', () => {
    expect(existsSync(SHELL_TEST)).toBe(true);

    const result = spawnSync('bash', [SHELL_TEST], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: process.env,
      timeout: 60_000,
    });

    if (result.status !== 0) {
      // Surface full harness output so CI logs pinpoint the failure.
      // eslint-disable-next-line no-console
      console.error('=== get-exarchos.test.sh STDOUT ===\n' + (result.stdout ?? ''));
      // eslint-disable-next-line no-console
      console.error('=== get-exarchos.test.sh STDERR ===\n' + (result.stderr ?? ''));
    }

    expect(result.status).toBe(0);
  }, 90_000);
});
