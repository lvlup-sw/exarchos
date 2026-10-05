/**
 * Acceptance test for `exarchos doctor`. It calls `handleDoctor` in-process against a temp project directory.
 * `initializeContext` builds a real `DispatchContext`, and `handleDoctor` runs its checks on the production probes.
 * The test does not cover Commander routing, `--json` formatting or the exit-code mapping of the CLI.
 * A `tsx` spawn of the CLI is not possible: `tsx` runs under Node, which rejects the `bun:` URL scheme of the SQLite backend.
 *
 * Isolation:
 * - `HOME` and `USERPROFILE` point at a temp directory, so the claude-code detector reads `.claude.json` from there.
 * - `process.cwd` returns the temp project directory, so the detector and `vcsGitAvailable` see only fixture state.
 * - The state directory is inside the project tree, so the test never writes to `~/.exarchos/`.
 * - Each test gets fresh temp directories and removes them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { DoctorOutputSchema, type DoctorOutput } from '../../src/verbs/doctor/schema.js';
import { handleDoctor } from '../../src/verbs/doctor/index.js';
import { initializeContext } from '../../src/dispatch/core/context.js';
import type { ToolResult } from '../../src/format.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

interface DoctorRunResult {
  readonly result: ToolResult;
}

/**
 * Runs `handleDoctor` in-process against the fixture, with `HOME`, `USERPROFILE` and `process.cwd` pinned for the call.
 * The detector and `vcsGitAvailable` read `process.cwd` directly. The `afterEach` hook removes the environment stubs.
 * The state directory is inside the project tree, so the call never writes to `~/.exarchos/`.
 */
async function runDoctor(projectDir: string, homeDir: string): Promise<DoctorRunResult> {
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);

  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

  try {
    const ctx = await initializeContext(path.join(projectDir, '.exarchos'));
    const result = await handleDoctor({}, ctx);
    return { result };
  } finally {
    cwdSpy.mockRestore();
  }
}

let projectDir: string;
let homeDir: string;

/** The project root and `HOME` are separate temp directories, so the test controls the `$HOME/.claude.json` that the detector reads. */
beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-e2e-project-'));
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-e2e-home-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all([
    rmrf(projectDir),
    rmrf(homeDir),
  ]);
});

describe('doctor end-to-end acceptance (task 022)', () => {
  /**
   * The project directory and `HOME` are empty: no `.claude/`, no `.claude.json` and no git repo.
   * - The handler output must parse with the Zod schema that the MCP adapter uses, or the wire contract breaks.
   * - The run-bundle custody check passes on a fresh state directory and says that it had nothing to check.
   * - The schema refinement already enforces the tally. The test asserts it again so that a failure names the field.
   * - At least one check with the status `Warning` or `Fail` must offer an init-style fix (`exarchos init`, `git init` or `mkdir -p .exarchos`).
   *   The host decides which check shows the gap, so the pattern accepts all three.
   * - No `fix` string is only whitespace or ends in whitespace. The schema rejects only the empty string.
   */
  it('Doctor_FreshProjectWithNoClaudeConfig_ReturnsExpectedShape', async () => {
    const { result } = await runDoctor(projectDir, homeDir);

    expect(result.success).toBe(true);

    const parsed = DoctorOutputSchema.safeParse(result.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const output: DoctorOutput = parsed.data;
    expect(output.checks.length).toBeGreaterThan(0);

    const custody = output.checks.find((check) => check.name === 'run-bundle-integrity');
    expect(custody?.category).toBe('storage');
    expect(custody?.status).toBe('Pass');
    expect(custody?.message).toContain('nothing to check');
    const tally =
      output.summary.passed +
      output.summary.warnings +
      output.summary.failed +
      output.summary.skipped;
    expect(tally).toBe(output.checks.length);

    const initRegex = /(exarchos init|git init|mkdir\s+-p?\s*\.exarchos)/i;
    const nonPassWithInitFix = output.checks.filter(
      (c) =>
        c.status !== 'Pass' &&
        c.status !== 'Skipped' &&
        c.fix !== undefined &&
        initRegex.test(c.fix),
    );
    expect(nonPassWithInitFix.length).toBeGreaterThan(0);

    for (const check of output.checks) {
      if (check.fix !== undefined) {
        expect(check.fix.trim().length).toBeGreaterThan(0);
        expect(check.fix).toBe(check.fix.trimEnd());
      }
    }
  }, 30_000);

  /**
   * The fixture is a minimal `$HOME/.claude.json` that registers `mcpServers.exarchos`.
   * The claude-code detector in `runtime/agent-environment-detector.ts` needs no other field.
   * The guarantees are zero failed checks and a pass for the two agent checks. A warning, such as a missing git repo, is acceptable.
   *
   * "Mostly pass" means that more than half of the checks pass. The remote-MCP check always has the status `Skipped`.
   * The win32 runner adds expected environment warnings that can tip that majority, so the majority check does not run on win32.
   */
  it('Doctor_ProjectWithClaudeJsonAndExarchosMcp_ReturnsMostlyPass', async () => {
    const claudeJson = {
      mcpServers: {
        exarchos: {
          command: 'node',
          args: ['/stub/path/exarchos-mcp.js'],
        },
      },
    };
    await fs.writeFile(
      path.join(homeDir, '.claude.json'),
      JSON.stringify(claudeJson, null, 2),
      'utf-8',
    );

    const { result } = await runDoctor(projectDir, homeDir);

    expect(result.success).toBe(true);

    const parsed = DoctorOutputSchema.safeParse(result.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const output: DoctorOutput = parsed.data;

    const byName = new Map(output.checks.map((c) => [c.name, c]));
    const configCheck = byName.get('agent-config-valid');
    const mcpCheck = byName.get('agent-mcp-registered');
    expect(configCheck?.status).toBe('Pass');
    expect(mcpCheck?.status).toBe('Pass');

    if (process.platform !== 'win32') {
      expect(output.summary.passed).toBeGreaterThan(output.checks.length / 2);
    }
    expect(output.summary.failed).toBe(0);
  }, 30_000);
});
