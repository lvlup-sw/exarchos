/**
 * Outcome test for `exarchos onboard`, run as the compiled platform binary with an isolated HOME
 * and a new git repo.
 *
 * The first run must exit 0 and write one SubagentStop binding to `<home>/.claude/settings.json`.
 * The second run must also exit 0, leave no SessionStart binding (that hook is retired), and keep
 * one SubagentStop binding.
 *
 * The steps that `onboard` applies depend on the doctor state of the host. The test asserts only
 * the exit code and the binding counts.
 */

import { describe, it, expect } from 'vitest';
import { withTmpHome } from './_helpers/tmp-home.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileAsync, SpawnFailure } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The file name of the platform binary, in the `exarchos-<os>-<arch>` form that
 * `tools/release/build-binary.ts` writes. Windows adds `.exe`.
 */
function platformBinaryName(): string {
  const platform = os.platform();
  const arch = os.arch();
  const ext = platform === 'win32' ? '.exe' : '';
  const osPart =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'win32'
        ? 'windows'
        : 'linux';
  const archPart = arch === 'arm64' ? 'arm64' : 'x64';
  return `exarchos-${osPart}-${archPart}${ext}`;
}

const CLI_BINARY = path.join(REPO_ROOT, 'dist', 'bin', platformBinaryName());

interface OnboardRun {
  status: number;
  stderr: string;
}

/**
 * Runs `exarchos onboard --runtime claude` with an isolated repo and HOME. `--runtime claude` skips
 * runtime detection, so the run is deterministic. `execFileAsync` rejects on a non-zero exit. This
 * function returns the status instead, so the test can assert on it with a clear message.
 */
async function runOnboard(home: string, cwd: string): Promise<OnboardRun> {
  try {
    await execFileAsync(CLI_BINARY, ['onboard', '--runtime', 'claude'], {
      env: {
        ...process.env,
        HOME: home,
        NON_INTERACTIVE: '1',
        CI: 'true',
        FORCE_COLOR: '0',
      },
      cwd,
      timeout: 60_000,
    });
    return { status: 0, stderr: '' };
  } catch (err) {
    if (err instanceof SpawnFailure) {
      return { status: err.status ?? 1, stderr: err.stderr };
    }
    return { status: 1, stderr: '' };
  }
}

/** Counts the hooks of `event` in `<home>/.claude/settings.json` whose command holds `marker`. */
function bindingCount(home: string, event: string, marker: string): number {
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return 0;
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
    hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
  };
  const groups = parsed.hooks?.[event] ?? [];
  let count = 0;
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (typeof hook.command === 'string' && hook.command.includes(marker)) {
        count += 1;
      }
    }
  }
  return count;
}

const sessionStartBindingCount = (home: string): number =>
  bindingCount(home, 'SessionStart', 'exarchos session-start');
const subagentStopBindingCount = (home: string): number =>
  bindingCount(home, 'SubagentStop', 'exarchos subagent-stop');

describe('onboard outcome', () => {
  /**
   * The install step writes the SessionStart, SessionEnd and SubagentStop bindings in one pass, so
   * the first run also writes the retired SessionStart binding. The `retired-hooks-present` check
   * removes that binding on the second run, so the test asserts its absence only then. The second
   * run must not add a second SubagentStop binding.
   */
  it('Onboard_claude_DrivesRepoGreenAndInstallsSubagentStopHook', async () => {
    await withTmpHome(async (home) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-onboard-repo-'));
      try {
        await execFileAsync('git', ['init', '-q', repo]);

        const first = await runOnboard(home, repo);
        expect(
          first.status,
          `onboard should exit 0 (drive the repo green); stderr=${first.stderr.slice(0, 800)}`,
        ).toBe(0);
        expect(
          subagentStopBindingCount(home),
          'onboard should install exactly one SubagentStop binding (DR-7/DR-8).',
        ).toBe(1);

        const second = await runOnboard(home, repo);
        expect(
          second.status,
          `second onboard should exit 0; stderr=${second.stderr.slice(0, 800)}`,
        ).toBe(0);
        expect(
          sessionStartBindingCount(home),
          'a second onboard must complete the DR-7 retirement — SessionStart is removed, not re-added.',
        ).toBe(0);
        expect(
          subagentStopBindingCount(home),
          'idempotent re-run must leave exactly one SubagentStop binding (DR-8).',
        ).toBe(1);
      } finally {
        rmrf(repo);
      }
    });
  });
});
