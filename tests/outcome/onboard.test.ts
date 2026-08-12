// ─── onboard outcome ─────────────────────────────────────────────────────────
//
// Replaces the retired `install-skills.test.ts` outcome tier. `install-skills`
// was consolidated into the `onboard` verb (DR-5) and is now a one-release
// rename stub, so its old per-runtime "full manifest installed" assertion no
// longer maps to a standalone command. The #1355 per-runtime manifest-parity
// regression it guarded is now covered at the unit tier against the REAL
// `installSkills` seam in
// `servers/exarchos-mcp/src/verbs/onboard/install.test.ts`.
//
// This outcome test instead pins the operator-visible end-to-end contract of
// the consolidated verb, run against the real bun-compiled platform binary
// under an isolated HOME + repo (no mocks at the test boundary):
//
//   - `onboard` drives a fresh repo to a green doctor and EXITS 0 (DR-2).
//   - A first run installs exactly one SubagentStop binding (DR-7's retained
//     token-attribution seam) under `<home>/.claude/settings.json`; the same
//     pass also writes the #1485 SessionStart directive (installBindings'
//     single idempotent pass writes all three bindings together), but that
//     binding is retired going forward.
//   - Re-running is idempotent AND completes the DR-7 retirement: a second
//     invocation still exits 0, the SessionStart binding is gone (removed by
//     `retired-hooks-present` — the launcher is now the lifecycle authority),
//     and the SubagentStop binding still numbers exactly one (DR-8
//     acceptance, now scoped to the binding DR-7 retains).
//
// The precise set of reconcile steps onboard *applies* depends on the host's
// doctor state, so the assertions intentionally pin the STABLE guarantees
// (exit code + binding counts), not the volatile applied-step list.

import { describe, it, expect } from 'vitest';
import { withTmpHome } from './_helpers/tmp-home.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Locate the platform binary produced by `npm run build` — the same
// `exarchos-<os>-<arch>[.exe]` convention `scripts/build-binary.ts` emits.
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
 * Run `exarchos onboard --runtime claude` against an isolated repo + HOME.
 * `--runtime claude` short-circuits agent-host detection so the run is
 * deterministic. execFileSync throws on a non-zero exit; we capture the status
 * so the test can assert on it with a clear message instead of an opaque throw.
 */
function runOnboard(home: string, cwd: string): OnboardRun {
  try {
    execFileSync(CLI_BINARY, ['onboard', '--runtime', 'claude'], {
      env: {
        ...process.env,
        HOME: home,
        NON_INTERACTIVE: '1',
        CI: 'true',
        FORCE_COLOR: '0',
      },
      cwd,
      stdio: 'pipe',
      timeout: 60_000,
    });
    return { status: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    return {
      status: e.status ?? 1,
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? ''),
    };
  }
}

/** Count bindings for a given hook `event` in `<home>/.claude/settings.json`. */
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
  it('Onboard_claude_DrivesRepoGreenAndInstallsSubagentStopHook', async () => {
    await withTmpHome(async (home) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-onboard-repo-'));
      try {
        execFileSync('git', ['init', '-q', repo]);

        const first = runOnboard(home, repo);
        expect(
          first.status,
          `onboard should exit 0 (drive the repo green); stderr=${first.stderr.slice(0, 800)}`,
        ).toBe(0);
        expect(
          subagentStopBindingCount(home),
          'onboard should install exactly one SubagentStop binding (DR-7/DR-8).',
        ).toBe(1);

        // Idempotence: a second run converges — SessionStart is retired (removed)
        // and SubagentStop still numbers exactly one.
        const second = runOnboard(home, repo);
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
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
