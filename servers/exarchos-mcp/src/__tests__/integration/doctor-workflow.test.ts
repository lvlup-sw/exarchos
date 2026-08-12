// ─── Task 022: End-to-End Acceptance — `exarchos doctor` ────────────────────
//
// Drives `handleDoctor` directly against an isolated temp project directory
// with a pinned HOME and `process.cwd()`, and asserts:
//
//   1. The returned ToolResult.data validates against the Zod schema
//      exported from `verbs/doctor/schema.ts` (contract pin —
//      handler output cannot drift from the MCP wire shape, DR-3).
//   2. In a fresh project with no `.claude/` config, at least one non-Pass
//      check produces a `fix` string suggesting an init-style remediation
//      (`exarchos init`, `git init`, `mkdir .exarchos`, etc.).
//   3. With a minimal valid `.claude.json` registering `mcpServers.exarchos`,
//      the agent-config-valid + agent-mcp-registered checks pass and the
//      overall run is mostly-Pass (no Fails).
//
// History: a previous version of this test spawned `tsx src/index.ts doctor
// --json` to pin the operator-facing CLI entry (Commander routing, exit-code
// mapping, --json output path). That subprocess approach broke when the
// substrate flipped to `bun:sqlite` for the SQLite backend — `tsx` runs under
// Node, which rejects the `bun:` URL scheme with
// `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Issue #1324 tracked the migration.
//
// In-process model: `initializeContext(stateDir)` builds a real
// DispatchContext (real EventStore, real backend), then `handleDoctor`
// composes the canonical 10-check list against `buildProbes(ctx)` — i.e.
// the same probe bundle the production handler uses. HOME and `process.cwd`
// are overridden for the test duration so the claude-code detector and
// `vcsGitAvailable` see only the test fixture filesystem.
//
// Coverage caveat: this no longer exercises Commander routing, the
// `#!/usr/bin/env node` shebang, `--json` formatting, or the CLI's
// exit-code mapping. Those are CLI-adapter contracts; the per-check
// unit tests + the composer tests
// (`verbs/doctor/index.test.ts`) already cover the handler.
// Pinning the CLI surface is tracked as a follow-up — see #1324 close
// notes — and would be reintroduced via an in-process Commander harness
// rather than a tsx spawn.
//
// Isolation discipline:
//   - `HOME`/`USERPROFILE` are stubbed to the temp dir so the claude-code
//     detector looks for `$TMP/.claude.json` rather than the developer's
//     real one.
//   - `process.cwd` is stubbed to the project temp dir for the lifetime
//     of each test so the detector + `vcsGitAvailable` only see fixture
//     state.
//   - The state directory is pinned inside the project tree so the test
//     never touches `~/.exarchos/`.
//   - Each test gets a fresh `mkdtemp` and `fs.rm` teardown.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { DoctorOutputSchema, type DoctorOutput } from '../../verbs/doctor/schema.js';
import { handleDoctor } from '../../verbs/doctor/index.js';
import { initializeContext } from '../../dispatch/core/context.js';
import type { ToolResult } from '../../format.js';
import { rmrf } from '../../test-helpers/temp-dir.js';

// ─── Harness ────────────────────────────────────────────────────────────────

interface DoctorRunResult {
  readonly result: ToolResult;
}

/**
 * Run `handleDoctor` in-process against the given fixture, with HOME and
 * cwd pinned for the duration of the call. The state directory lives
 * inside the project tree so the test never touches `~/.exarchos/`.
 */
async function runDoctor(projectDir: string, homeDir: string): Promise<DoctorRunResult> {
  // Stub HOME/USERPROFILE for the detector and any check that resolves
  // home-relative paths. `vi.stubEnv` auto-restores in `afterEach` via
  // the per-test cleanup hook (vitest 1.x+).
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);

  // Stub `process.cwd` for the detector + vcsGitAvailable check, which
  // both read it directly. `vi.spyOn` is auto-restored by the standard
  // test cleanup.
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

  try {
    const ctx = await initializeContext(path.join(projectDir, '.exarchos'));
    const result = await handleDoctor({}, ctx);
    return { result };
  } finally {
    cwdSpy.mockRestore();
  }
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all([
    rmrf(projectDir),
    rmrf(homeDir),
  ]);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('doctor end-to-end acceptance (task 022)', () => {
  it('Doctor_FreshProjectWithNoClaudeConfig_ReturnsExpectedShape', async () => {
    // Arrange: project dir is empty — no `.claude/`, no `.claude.json`,
    // no git repo. HOME is an empty mkdtemp so the claude-code detector
    // sees no `$HOME/.claude.json` either.

    // Act
    const { result } = await runDoctor(projectDir, homeDir);

    expect(result.success).toBe(true);

    // Shape pin: the handler output must validate against the same Zod
    // schema the MCP adapter projects through. Any divergence breaks
    // the wire contract (DR-3).
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
    const { result } = await runDoctor(projectDir, homeDir);

    // Assert: a zero-failure run. Warnings (e.g. missing git repo) are
    // still acceptable — the guarantee is no Fails, and the two agent
    // checks flip to Pass now that a valid config is present.
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
    // the Pass count below the majority. The windows-latest runner adds a
    // couple more expected dev-environment Warnings (e.g. build-state / git
    // probes), tipping this soft majority heuristic without any real
    // regression — the meaningful guarantees (agent checks Pass, zero Fails)
    // are asserted unconditionally above/below. (#1620)
    if (process.platform !== 'win32') {
      expect(output.summary.passed).toBeGreaterThan(output.checks.length / 2);
    }
    // No outright Fails — a Fail would indicate a real wiring regression,
    // not an expected dev-environment gap.
    expect(output.summary.failed).toBe(0);
  }, 30_000);
});
