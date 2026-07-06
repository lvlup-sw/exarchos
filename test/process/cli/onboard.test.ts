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
//   2. A first run installs exactly ONE SubagentStop binding (the
//      token-attribution seam DR-7 retains) under
//      `<home>/.claude/settings.json` — the default-on hook step's one durable
//      side effect in a fresh environment. The same pass also installs the
//      #1485 SessionStart directive (DR-7: still written by
//      `installBindings`'s single idempotent pass), but that binding is
//      retired going forward — see (3).
//   3. Re-running is idempotent AND completes the DR-7 retirement: a second
//      invocation still exits 0, the SessionStart binding is gone (removed by
//      `retired-hooks-present`, the launcher is now the lifecycle authority),
//      and the SubagentStop binding still numbers exactly one (DR-8
//      acceptance: "exactly one hook registration", now scoped to the
//      binding DR-7 retains rather than the one it retires).
//
// Environment note: the exact set of *applied* reconcile steps varies with the
// host's doctor state (e.g. whether MCP is already registered), so this smoke
// deliberately asserts the STABLE guarantees (exit code + binding counts)
// rather than the volatile `applied` step list.
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
 * Count bindings for a given hook `event` in `<home>/.claude/settings.json`
 * whose command carries `marker`. Returns 0 when the file is absent or carries
 * no matching binding.
 */
async function bindingCount(homeDir: string, event: string, marker: string): Promise<number> {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch {
    return 0;
  }
  const parsed = JSON.parse(raw) as {
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

const sessionStartBindingCount = (homeDir: string): Promise<number> =>
  bindingCount(homeDir, 'SessionStart', 'exarchos session-start');
const subagentStopBindingCount = (homeDir: string): Promise<number> =>
  bindingCount(homeDir, 'SubagentStop', 'exarchos subagent-stop');

describe('exarchos onboard --runtime claude (process-fidelity smoke)', () => {
  it(
    'onboard_runtimeClaude_exitsZeroAndInstallsSubagentStopHook',
    async () => {
      await withHermeticEnv(async (env) => {
        const result = await runOnboard(env.homeDir, env.gitDir);

        expect(
          result.exitCode,
          `onboard should exit 0 (drive the repo green); stderr=${result.stderr.slice(0, 800)}`,
        ).toBe(0);

        const bindings = await subagentStopBindingCount(env.homeDir);
        expect(
          bindings,
          [
            'Expected exactly one SubagentStop binding under',
            `${path.join(env.homeDir, '.claude', 'settings.json')} after onboard (DR-7/DR-8).`,
            `onboard stdout (head):\n${result.stdout.slice(0, 600)}`,
          ].join('\n'),
        ).toBe(1);
      });
    },
    ONBOARD_TIMEOUT_MS + 10_000,
  );

  it(
    'onboard_idempotent_secondRunRetiresSessionStartAndKeepsSubagentStop',
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

        const sessionStart = await sessionStartBindingCount(env.homeDir);
        expect(
          sessionStart,
          'A second onboard must complete the DR-7 retirement — the SessionStart ' +
            'directive is removed by `retired-hooks-present` (the launcher is now ' +
            'the lifecycle authority), not re-added.',
        ).toBe(0);

        const subagentStop = await subagentStopBindingCount(env.homeDir);
        expect(
          subagentStop,
          'A second onboard must be idempotent — exactly one SubagentStop ' +
            'binding survives (DR-8), since DR-7 retains it for token attribution.',
        ).toBe(1);
      });
    },
    ONBOARD_TIMEOUT_MS * 2 + 10_000,
  );
});
