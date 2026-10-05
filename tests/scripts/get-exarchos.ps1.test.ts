/**
 * Cross-platform smoke tests for `tools/release/get-exarchos.ps1`.
 *
 * The authoritative tests are the Pester suite in `tools/release/get-exarchos.ps1.test.ps1`.
 * These tests spawn `pwsh` and check three things:
 *   1. The script loads without a parse error (`-LoadOnly`).
 *   2. `-DryRun` exits 0 and prints a plan.
 *   3. `Invoke-Pester` passes, when Pester is installed.
 *
 * Without `pwsh` on PATH, each of these tests logs a skip message and returns early.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT_PATH = join(REPO_ROOT, 'tools', 'release', 'get-exarchos.ps1');
const PESTER_PATH = join(REPO_ROOT, 'tools', 'release', 'get-exarchos.ps1.test.ps1');

async function hasPwsh(): Promise<boolean> {
  const probe = await spawnAsync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    timeout: 10_000,
  });
  return probe.status === 0;
}

describe('tools/release/get-exarchos.ps1', () => {
  it('GetExarchos_PS1_FileExists', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('GetExarchos_PesterSuite_FileExists', () => {
    expect(existsSync(PESTER_PATH)).toBe(true);
  });

  /**
   * The test budgets a 10-second `hasPwsh()` probe and a 30-second spawn, so its
   * timeout must exceed 40 seconds. The 5-second default stops the test during
   * the spawn under CI load.
   * `-LoadOnly` makes the script load its functions and skip the main entry point.
   */
  it('GetExarchos_PS1_ParsesWithoutErrors_WhenPwshAvailable', async () => {
    if (!(await hasPwsh())) {
      console.log('[skip] pwsh not on PATH — PowerShell parser check deferred to CI runners that have it.');
      return;
    }

    const result = await spawnAsync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH, '-LoadOnly'],
      {
        timeout: 30_000,
        cwd: REPO_ROOT,
      },
    );

    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
  }, 60_000);

  /**
   * `Get-PlatformTarget` rejects Windows ARM64, because Bun has no
   * `bun-windows-arm64` target. On that platform the dry run must exit non-zero
   * with the "not yet supported" guidance. The timeout covers the probe and the spawn.
   */
  it('GetExarchos_DryRun_PrintsPlan_WhenPwshAvailable', async () => {
    if (!(await hasPwsh())) {
      console.log('[skip] pwsh not on PATH — dry-run smoke deferred to CI runners that have it.');
      return;
    }

    const result = await spawnAsync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH, '-DryRun'],
      {
        timeout: 30_000,
        cwd: REPO_ROOT,
      },
    );

    const combined = `${result.stdout}\n${result.stderr}`;
    if (process.arch === 'arm64' && process.platform === 'win32') {
      expect(result.status).not.toBe(0);
      expect(combined).toMatch(/Windows ARM64 is not yet supported/);
      return;
    }

    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
    expect(combined).toMatch(/exarchos-windows-x64/);
    expect(combined).toMatch(/\.sha512/);
  }, 60_000);

  /**
   * The vitest timeout must exceed the 120-second spawn timeout. The spawn then
   * returns its own result before vitest stops the test.
   */
  it(
    'GetExarchos_PesterSuite_Passes_WhenPesterAvailable',
    async () => {
      if (!(await hasPwsh())) {
        console.log('[skip] pwsh not on PATH — Pester suite deferred.');
        return;
      }

      const pesterProbe = await spawnAsync(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-Command', 'if (Get-Module -ListAvailable -Name Pester) { exit 0 } else { exit 1 }'],
        { timeout: 15_000 },
      );
      if (pesterProbe.status !== 0) {
        console.log('[skip] Pester module not installed — skipping shell-native assertions.');
        return;
      }

      const result = await spawnAsync(
        'pwsh',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$r = Invoke-Pester -Path '${PESTER_PATH}' -PassThru -Output Detailed; if ($r.FailedCount -gt 0) { exit 1 } else { exit 0 }`,
        ],
        {
          timeout: 120_000,
          cwd: REPO_ROOT,
        },
      );

      expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
    },
    150_000,
  );
});
