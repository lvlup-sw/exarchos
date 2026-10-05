/**
 * Process tests for `exarchos onboard --runtime claude`, run as the installed binary.
 * They assert only the stable results: the exit code and the hook binding counts in `<home>/.claude/settings.json`.
 * The list of applied steps changes with the doctor state of the host, so the tests do not read it.
 * `withHermeticEnv` gives each test a temporary `HOME` and a new git repository.
 * Thus `onboard` does not read or write the real home directory or the real repository.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withHermeticEnv } from '../../helpers/hermetic.js';
import { runCli } from '../../helpers/cli-runner.js';

/** The time limit of one `onboard` run. It leaves room for a cold binary on a slow CI runner. */
const ONBOARD_TIMEOUT_MS = 60_000;

interface OnboardProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `exarchos onboard --runtime claude` in `cwd` with `HOME` set to `homeDir`.
 * `--runtime claude` bypasses the agent-host probe, so the result does not depend on the runner configuration.
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
 * Counts the `event` hooks in `<home>/.claude/settings.json` whose command contains `marker`.
 * An absent file gives 0.
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
  /** A first run must exit 0 and leave exactly one SubagentStop binding, which feeds token attribution. */
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

  /**
   * The first run writes the SessionStart directive in the same pass as the SubagentStop binding.
   * The second run removes that directive in its `retired-hooks-present` step, because the launcher owns the session lifecycle.
   * Thus after two runs, no SessionStart binding and exactly one SubagentStop binding must stay.
   */
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
