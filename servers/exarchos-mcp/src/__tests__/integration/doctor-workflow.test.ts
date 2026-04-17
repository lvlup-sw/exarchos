// ─── Task 022: End-to-End Acceptance — `exarchos doctor` CLI ────────────────
//
// Spawns the real doctor CLI (`tsx src/index.ts doctor --json`) against an
// isolated temp project directory with a pinned HOME, and asserts:
//
//   1. The emitted DoctorOutput validates against the Zod schema exported
//      from `orchestrate/doctor/schema.ts` (contract pin — the CLI cannot
//      drift from the MCP output shape, DR-3).
//   2. In a fresh project with no `.claude/` config, at least one non-Pass
//      check produces a `fix` string suggesting an init-style remediation
//      (`exarchos init`, `git init`, `mkdir .exarchos`, etc.).
//   3. With a minimal valid `.claude.json` registering `mcpServers.exarchos`,
//      the agent-config-valid + agent-mcp-registered checks pass and the
//      overall run is mostly-Pass (no Fails).
//
// Why spawn the real CLI rather than call `handleDoctor` directly: the
// unit + composer tests already cover handler wiring. This test pins the
// surface that operators actually invoke — the `#!/usr/bin/env node`
// entry, Commander routing, exit-code mapping, and `--json` output path.
// Any regression in the top-level `exarchos doctor` verb would escape the
// existing suite; this test is the final gate.
//
// Isolation discipline:
//   - `HOME` is overridden to the temp dir so the claude-code detector
//     looks for `$TMP/.claude.json` rather than the developer's real one.
//   - `WORKFLOW_STATE_DIR` pins the state directory inside the temp tree
//     so the spawned process never touches `~/.exarchos/`.
//   - Each test gets a fresh `mkdtemp` and `fs.rm` teardown.
//
// Cost note: spawning `tsx src/index.ts` pays the full cold-start (sqlite
// hydration, migration scan, command registration). Keeping these tests
// to two scenarios is intentional — richer per-check coverage belongs in
// the unit tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import { DoctorOutputSchema, type DoctorOutput } from '../../orchestrate/doctor/schema.js';
import type { ToolResult } from '../../format.js';

// ─── Harness ────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Repo root = .../servers/exarchos-mcp/src/__tests__/integration → up 5.
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = path.join(
  REPO_ROOT,
  'servers',
  'exarchos-mcp',
  'src',
  'index.ts',
);

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn `exarchos doctor --json` in the given project dir with HOME
 * pinned to `homeDir` and WORKFLOW_STATE_DIR pinned inside the project
 * tree. Resolves with stdout/stderr/exitCode; never rejects on a
 * non-zero exit (callers assert on the code explicitly).
 */
function spawnDoctor(projectDir: string, homeDir: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      TSX_BIN,
      [CLI_ENTRY, 'doctor', '--json'],
      {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          // Minimal env — avoid leaking unrelated EXARCHOS_* vars from
          // the parent that would trigger the env-variables check's
          // unknown-variable Warning path.
          PATH: process.env.PATH,
          NODE_OPTIONS: process.env.NODE_OPTIONS,
          HOME: homeDir,
          USERPROFILE: homeDir,
          WORKFLOW_STATE_DIR: path.join(projectDir, '.exarchos'),
          EXARCHOS_LOG_LEVEL: 'silent',
          EXARCHOS_TELEMETRY: 'false',
        },
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });
  });
}

/**
 * Parse the last non-empty line of stdout as a ToolResult. The CLI may
 * emit a trailing newline and some log lines can slip through despite
 * `EXARCHOS_LOG_LEVEL=silent` on older machines; anchoring to the last
 * JSON-looking line keeps the test robust without over-specifying the
 * adapter's output shape.
 */
function parseToolResult(stdout: string): ToolResult {
  const lines = stdout.trim().split('\n').filter((l) => l.trim().length > 0);
  // The CLI writes a single JSON line per invocation; take the last one
  // so any stray log preamble doesn't confuse the parser.
  const last = lines[lines.length - 1] ?? '';
  return JSON.parse(last) as ToolResult;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

let projectDir: string;
let homeDir: string;

beforeEach(async () => {
  // One mkdtemp for the project root, another nested for HOME so the
  // claude-code detector's `$HOME/.claude.json` path is fully under
  // our control and tests cannot cross-contaminate.
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-e2e-project-'));
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-e2e-home-'));
});

afterEach(async () => {
  await Promise.all([
    fs.rm(projectDir, { recursive: true, force: true }),
    fs.rm(homeDir, { recursive: true, force: true }),
  ]);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('doctor end-to-end acceptance (task 022)', () => {
  it('Doctor_FreshProjectWithNoClaudeConfig_ReturnsExpectedShape', async () => {
    // Arrange: project dir is empty — no `.claude/`, no `.claude.json`,
    // no git repo. HOME is an empty mkdtemp so the claude-code detector
    // sees no `$HOME/.claude.json` either.

    // Act
    const { exitCode, stdout } = await spawnDoctor(projectDir, homeDir);

    // Assert: the CLI produced parseable JSON. Exit code may be 0
    // (warnings only) or 2 (any check failed) — both are valid for a
    // fresh project; the shape contract is the load-bearing assertion.
    expect([0, 2]).toContain(exitCode);

    const result = parseToolResult(stdout);
    expect(result.success).toBe(true);

    // Shape pin: the CLI's JSON must validate against the same Zod
    // schema the MCP adapter projects through. Any divergence breaks
    // the CLI/MCP parity contract (DR-3).
    const parsed = DoctorOutputSchema.safeParse(result.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return; // narrow for TS below

    const output: DoctorOutput = parsed.data;
    expect(output.checks.length).toBeGreaterThan(0);
    // Tally invariant is enforced inside the schema refinement, but
    // re-assert here so a failure message points at the right field.
    const tally =
      output.summary.passed +
      output.summary.warnings +
      output.summary.failed +
      output.summary.skipped;
    expect(tally).toBe(output.checks.length);

    // At least one non-Pass check must offer an init-style remediation
    // so a fresh-install operator has a clear next step. The UX
    // contract is "the user sees an actionable init-style command" —
    // `exarchos init` for the agent/plugin surface, or an equivalent
    // project-level init (`git init`, `mkdir -p .exarchos`) for the
    // runtime/vcs surface. Matching the broader set keeps the test
    // robust to which specific check surfaces the gap on a given host.
    const initRegex = /(exarchos init|git init|mkdir\s+-p?\s*\.exarchos)/i;
    const nonPassWithInitFix = output.checks.filter(
      (c) =>
        c.status !== 'Pass' &&
        c.status !== 'Skipped' &&
        c.fix !== undefined &&
        initRegex.test(c.fix),
    );
    expect(nonPassWithInitFix.length).toBeGreaterThan(0);

    // DIM-8 prose-quality spot-check: every emitted `fix` string ends
    // without a trailing space and does not collapse into an empty
    // string (the Zod schema already rejects `""`, but a fix made of
    // pure whitespace would sneak past the minimum-length constraint).
    // This is the acceptance-level mirror of the convention check —
    // the per-check unit tests own message/fix content; this test owns
    // the cross-cutting quality gate.
    for (const check of output.checks) {
      if (check.fix !== undefined) {
        expect(check.fix.trim().length).toBeGreaterThan(0);
        expect(check.fix).toBe(check.fix.trimEnd());
      }
    }
  }, 30_000);

  it('Doctor_ProjectWithClaudeJsonAndExarchosMcp_ReturnsMostlyPass', async () => {
    // Arrange: stage a minimal valid `$HOME/.claude.json` that registers
    // `mcpServers.exarchos`. This is the single wiring the claude-code
    // detector reads (see `runtime/agent-environment-detector.ts`). No
    // fields beyond `mcpServers` are required for the detector to mark
    // configPresent=true, configValid=true, mcpRegistered=true.
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

    // Act
    const { exitCode, stdout } = await spawnDoctor(projectDir, homeDir);

    // Assert: a zero-failure run. Warnings (e.g. missing git repo) are
    // still acceptable — the guarantee is no Fails, and the two agent
    // checks flip to Pass now that a valid config is present.
    expect([0, 2]).toContain(exitCode);
    const result = parseToolResult(stdout);
    expect(result.success).toBe(true);

    const parsed = DoctorOutputSchema.safeParse(result.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const output: DoctorOutput = parsed.data;

    // The two claude-code-aware checks MUST pass now.
    const byName = new Map(output.checks.map((c) => [c.name, c]));
    const configCheck = byName.get('agent-config-valid');
    const mcpCheck = byName.get('agent-mcp-registered');
    expect(configCheck?.status).toBe('Pass');
    expect(mcpCheck?.status).toBe('Pass');

    // "Mostly pass" = majority of checks are Pass. The remote-MCP check
    // is always Skipped by design; git may Warning; neither should push
    // the Pass count below the majority.
    expect(output.summary.passed).toBeGreaterThan(output.checks.length / 2);
    // No outright Fails — a Fail would indicate a real wiring regression,
    // not an expected dev-environment gap.
    expect(output.summary.failed).toBe(0);
  }, 30_000);
});
