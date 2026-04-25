/**
 * Cross-platform wrapper for scripts/get-exarchos.ps1 tests.
 *
 * The authoritative, shell-native tests live in scripts/get-exarchos.ps1.test.ps1
 * (Pester). This wrapper gives us a cross-platform smoke signal by spawning
 * `pwsh` — when available — and asserting that:
 *
 *   1. The script loads without parse errors (-LoadOnly).
 *   2. `-DryRun` exits 0 and prints a plan.
 *   3. `Invoke-Pester` passes (if Pester is installed).
 *
 * On CI runners without `pwsh` (e.g. the default Linux agent image), each
 * test early-returns with a clear skip message and records the environment
 * limitation rather than silently passing.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'get-exarchos.ps1');
const PESTER_PATH = join(REPO_ROOT, 'scripts', 'get-exarchos.ps1.test.ps1');

function hasPwsh(): boolean {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return probe.status === 0;
}

describe('scripts/get-exarchos.ps1', () => {
  it('GetExarchos_PS1_FileExists', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('GetExarchos_PesterSuite_FileExists', () => {
    expect(existsSync(PESTER_PATH)).toBe(true);
  });

  it('GetExarchos_PS1_ParsesWithoutErrors_WhenPwshAvailable', () => {
    if (!hasPwsh()) {
      console.log('[skip] pwsh not on PATH — PowerShell parser check deferred to CI runners that have it.');
      return;
    }

    // -LoadOnly is a sentinel understood by the script itself (see RED test),
    // making the file source cleanly without triggering the main entry point.
    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH, '-LoadOnly'],
      {
        encoding: 'utf-8',
        timeout: 30_000,
        cwd: REPO_ROOT,
      },
    );

    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
  });

  it('GetExarchos_DryRun_PrintsPlan_WhenPwshAvailable', () => {
    if (!hasPwsh()) {
      console.log('[skip] pwsh not on PATH — dry-run smoke deferred to CI runners that have it.');
      return;
    }

    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH, '-DryRun'],
      {
        encoding: 'utf-8',
        timeout: 30_000,
        cwd: REPO_ROOT,
      },
    );

    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toMatch(/exarchos-windows-(x64|arm64)/);
    expect(combined).toMatch(/\.sha512/);
  });

  it('GetExarchos_PesterSuite_Passes_WhenPesterAvailable', () => {
    if (!hasPwsh()) {
      console.log('[skip] pwsh not on PATH — Pester suite deferred.');
      return;
    }

    const pesterProbe = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', 'if (Get-Module -ListAvailable -Name Pester) { exit 0 } else { exit 1 }'],
      { encoding: 'utf-8', timeout: 15_000 },
    );
    if (pesterProbe.status !== 0) {
      console.log('[skip] Pester module not installed — skipping shell-native assertions.');
      return;
    }

    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$r = Invoke-Pester -Path '${PESTER_PATH}' -PassThru -Output Detailed; if ($r.FailedCount -gt 0) { exit 1 } else { exit 0 }`,
      ],
      {
        encoding: 'utf-8',
        timeout: 120_000,
        cwd: REPO_ROOT,
      },
    );

    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
  });
});
