// Vitest wrapper for `tests/scripts/get-exarchos.test.sh`, the primary test
// harness of `tools/release/get-exarchos.sh`. The wrapper puts the shell test
// in `npm run test:run`. On failure it prints the full output of the shell
// test, so the CI log shows the scenario that failed.
//
// The suite skips on win32. `get-exarchos.sh` targets Linux, macOS and WSL,
// and not native git-bash. `get-exarchos.ps1.test.ts` covers the Windows
// installer, `get-exarchos.ps1`.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const SHELL_TEST = join(REPO_ROOT, 'tests/scripts/get-exarchos.test.sh');

describe.skipIf(process.platform === 'win32')('tools/release/get-exarchos.sh (shell harness)', () => {
  it('passes the full tests/scripts/get-exarchos.test.sh suite', async () => {
    expect(existsSync(SHELL_TEST)).toBe(true);

    const result = await spawnAsync('bash', [SHELL_TEST], {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: 60_000,
    });

    if (result.status !== 0) {
      // eslint-disable-next-line no-console
      console.error('=== get-exarchos.test.sh STDOUT ===\n' + (result.stdout ?? ''));
      // eslint-disable-next-line no-console
      console.error('=== get-exarchos.test.sh STDERR ===\n' + (result.stderr ?? ''));
    }

    expect(result.status).toBe(0);
  }, 90_000);
});
