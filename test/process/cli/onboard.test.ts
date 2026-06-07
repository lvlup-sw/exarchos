// Source: docs/designs/2026-06-06-onboard-doctor-consolidation.md (DR-2/DR-5)
//
// Process-fidelity smoke tests for `exarchos onboard --runtime claude` — the
// consolidated first-run verb that superseded the v2.9 `install-skills` /
// `init` commands (DR-5). This file replaces the retired
// `install-skills.test.ts`: `install-skills` is now a one-release rename stub
// (it exits non-zero and prints `renamed → use 'exarchos onboard'`), so its old
// "writes skills + registers MCP" contract no longer exists as a standalone
// command. The behaviour moved INTO the onboard reconciler, whose unit/contract
// coverage lives in `servers/exarchos-mcp/src/orchestrate/onboard/*.test.ts`
// (including the #1355 per-runtime manifest-parity guard in `install.test.ts`).
//
// What this tier asserts is the *operator-visible* end-to-end contract of the
// new verb — the part the unit suite cannot exercise because it needs the real
// compiled CLI spawned as a child process:
//
//   1. `onboard` exits 0 — it drives the repo to a green doctor and converges
//      (DR-2: a residual *blocking* check is the only non-zero path).
//   2. It installs exactly ONE #1485 SessionStart binding under
//      `<home>/.claude/settings.json` (DR-8 — the default-on hook step, the one
//      side effect onboard reliably performs in a fresh environment).
//   3. Re-running is idempotent — a second invocation still exits 0 and leaves
//      exactly one binding (DR-8 acceptance: "exactly one hook registration").
//
// Environment note: the exact set of *applied* reconcile steps varies with the
// host's doctor state (e.g. whether MCP is already registered), so this smoke
// deliberately asserts the STABLE guarantees (exit code + the SessionStart
// binding count) rather than the volatile `applied` step list.
//
// Hermeticity: every test wraps its work in `withHermeticEnv`, which sets `HOME`
// to a per-test tmp dir and provides an isolated, git-init'd `gitDir` we run
// onboard against — so onboard never reads or writes the real repo or `$HOME`.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withHermeticEnv } from '../../fixtures/hermetic.js';
import { runCli } from '../../fixtures/cli-runner.js';

// Onboard runs detect → config → generate → install → verify. With no network
// install step firing in the hermetic env it completes in well under a second,
// but 60s gives ample headroom for a cold binary + slow CI runner.
const ONBOARD_TIMEOUT_MS = 60_000;

interface OnboardProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Drive `exarchos onboard --runtime claude` against an isolated git repo with a
 * hermetic `HOME`. `--runtime claude` short-circuits agent-host detection so the
 * run is deterministic regardless of what the runner happens to have configured.
 */
async function runOnboard(homeDir: string, cwd: string): Promise<OnboardProbeResult> {
  const result = await runCli({
    args: ['onboard', '--runtime', 'claude'],
    env: { HOME: homeDir, NON_INTERACTIVE: '1', CI: 'true' },
    cwd,
    timeout: ONBOARD_TIMEOUT_MS,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Count the #1485 SessionStart bindings in `<home>/.claude/settings.json`. The
 * binding is identified by the stable `exarchos session-start` command marker
 * (the same marker the installer keys idempotence on). Returns 0 when the file
 * is absent or carries no binding.
 */
async function sessionStartBindingCount(homeDir: string): Promise<number> {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch {
    return 0;
  }
  const parsed = JSON.parse(raw) as {
    hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] };
  };
  const groups = parsed.hooks?.SessionStart ?? [];
  let count = 0;
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (typeof hook.command === 'string' && hook.command.includes('exarchos session-start')) {
        count += 1;
      }
    }
  }
  return count;
}

describe('exarchos onboard --runtime claude (process-fidelity smoke)', () => {
  it(
    'onboard_runtimeClaude_exitsZeroAndInstallsSessionStartHook',
    async () => {
      await withHermeticEnv(async (env) => {
        const result = await runOnboard(env.homeDir, env.gitDir);

        expect(
          result.exitCode,
          `onboard should exit 0 (drive the repo green); stderr=${result.stderr.slice(0, 800)}`,
        ).toBe(0);

        const bindings = await sessionStartBindingCount(env.homeDir);
        expect(
          bindings,
          [
            'Expected exactly one #1485 SessionStart binding under',
            `${path.join(env.homeDir, '.claude', 'settings.json')} after onboard (DR-8).`,
            `onboard stdout (head):\n${result.stdout.slice(0, 600)}`,
          ].join('\n'),
        ).toBe(1);
      });
    },
    ONBOARD_TIMEOUT_MS + 10_000,
  );

  it(
    'onboard_idempotent_secondRunLeavesExactlyOneBinding',
    async () => {
      await withHermeticEnv(async (env) => {
        const first = await runOnboard(env.homeDir, env.gitDir);
        expect(
          first.exitCode,
          `first onboard should exit 0; stderr=${first.stderr.slice(0, 800)}`,
        ).toBe(0);

        const second = await runOnboard(env.homeDir, env.gitDir);
        expect(
          second.exitCode,
          `second onboard should exit 0; stderr=${second.stderr.slice(0, 800)}`,
        ).toBe(0);

        const bindings = await sessionStartBindingCount(env.homeDir);
        expect(
          bindings,
          'A second onboard must be idempotent — exactly one SessionStart binding survives (DR-8).',
        ).toBe(1);
      });
    },
    ONBOARD_TIMEOUT_MS * 2 + 10_000,
  );
});
