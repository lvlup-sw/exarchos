// ─── #1337: doctor CLI-adapter end-to-end coverage (PR #1324 gap) ────────────
//
// PR #1324 migrated the doctor end-to-end acceptance test off a `tsx`
// subprocess and onto an in-process `handleDoctor` call (the `bun:sqlite`
// substrate flip broke the Node-based `tsx` spawn). That refactor preserved
// the handler-shape contract but DROPPED direct coverage of the doctor
// CLI-ADAPTER surface — Commander routing, exit-code mapping, `--json`
// envelope formatting, and `#!/usr/bin/env node` shebang invocation. The
// `__tests__/integration/doctor-workflow.test.ts` header (lines 30-37) flags
// this exact gap and calls for an in-process Commander harness rather than a
// tsx spawn.
//
// COMPLEMENT, NOT DUPLICATE: the sibling `cli-doctor.test.ts` already pins the
// exit-code *mapping logic* — but it MOCKS `../core/dispatch.js` and
// `./cli-format.js`, so it never exercises the real handler, the real
// `toEnvelope` formatter, or a registry-driven Commander program. This file
// drives the REAL `buildCli(ctx)` against a REAL `EventStore`, so the
// `exarchos doctor` top-level verb dispatches through
// `exarchos_orchestrate`/`doctor` → `handleDoctor` → real envelope exactly as
// the production binary does (cli.ts "Top-level exarchos doctor command",
// lines 643-717). That is the surface #1324 dropped.
//
// Exit-code contract under test (cli.ts:703-715):
//   - summary.failed > 0  → HANDLER_ERROR (exit 2)
//   - warnings-only/clean → SUCCESS (exit 0)   (warnings are advisory)
//   - dispatch failure    → HANDLER_ERROR (exit 2) / INVALID_INPUT (exit 1)
//   - uncaught throw      → UNCAUGHT_EXCEPTION (exit 3)
//
// Harness note: unlike the shared `parity-harness.callCli` (which models a
// `<tool> <action>` subcommand pair), `doctor` is a TOP-LEVEL verb. So this
// file uses a small self-contained harness that captures stdout around
// `buildCli(ctx).parseAsync(['node','exarchos','doctor', ...])`, mirroring the
// real-EventStore style of `__tests__/integration/cli-parity.test.ts`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildCli, CLI_EXIT_CODES } from './cli.js';
import { EventStore } from '../../events/store.js';
import * as dispatchModule from '../../dispatch/core/dispatch.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { DoctorOutputSchema } from '../../verbs/doctor/schema.js';
import { rmrf, rmrfAsync } from '../../test-helpers/temp-dir.js';
import { expectedTrustedContext } from '../../test-helpers/trusted-context.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

interface DoctorCliRun {
  /** Concatenated stdout the CLI wrote during the parse. */
  readonly stdout: string;
  /** `process.exitCode` set by the action callback (defaulting to 0). */
  readonly exitCode: number;
}

/**
 * Drive the `exarchos doctor` top-level verb in-process against the given
 * context. Captures stdout (the `--json` envelope / pretty-print text) and the
 * action callback's `process.exitCode`. Restores the prior exitCode so a
 * non-zero set here cannot leak into sibling tests.
 */
async function runDoctorCli(
  ctx: DispatchContext,
  extraArgs: readonly string[],
): Promise<DoctorCliRun> {
  const program = buildCli(ctx);
  // exitOverride keeps a Commander parse exit from killing the worker — the
  // action still sets process.exitCode for observability but does not call
  // process.exit() (matches the cli-parity.test.ts discipline).
  program.exitOverride();

  const chunks: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((data: unknown): boolean => {
      chunks.push(typeof data === 'string' ? data : String(data));
      return true;
    });

  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'exarchos', 'doctor', ...extraArgs]);
  } finally {
    stdoutSpy.mockRestore();
  }

  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = savedExitCode;

  return { stdout: chunks.join(''), exitCode };
}

interface DoctorEnvelope {
  success: boolean;
  data?: {
    summary?: { passed: number; warnings: number; failed: number; skipped: number };
    checks?: unknown;
  };
  error?: { code: string; message: string };
  next_actions?: unknown;
  _meta?: unknown;
  _perf?: unknown;
}

/** Parse the JSON envelope from captured `--json` stdout. */
function parseEnvelope(stdout: string): DoctorEnvelope {
  const trimmed = stdout.trim();
  const firstBrace = trimmed.indexOf('{');
  expect(
    firstBrace,
    `expected JSON on stdout, got: ${trimmed}`,
  ).toBeGreaterThanOrEqual(0);
  return JSON.parse(trimmed.slice(firstBrace)) as DoctorEnvelope;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

let tmpDir: string;
let ctx: DispatchContext;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'doctor-cli-1337-'));
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  // `cwd` is pinned to the temp dir so the doctor checks (vcs, agent-config,
  // etc.) read fixture state rather than the developer's real environment.
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false, cwd: tmpDir };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rmrfAsync(tmpDir);
});

// ─── Commander routing ──────────────────────────────────────────────────────

describe('doctor CLI-adapter — Commander routing (#1337)', () => {
  it('DoctorCli_CommanderRouting_RegistersTopLevelDoctorVerb', () => {
    // `doctor` is promoted to a TOP-LEVEL verb (not `orch doctor`) so an
    // operator types `exarchos doctor`. Pin that the Commander tree exposes it
    // at top level with the `--json` flag auto-emitted, plus the schema-driven
    // `--fix` flag.
    const program = buildCli(ctx);
    const doctorCmd = program.commands.find((c) => c.name() === 'doctor');
    expect(doctorCmd, 'exarchos doctor top-level verb not registered').toBeDefined();

    const optionFlags = doctorCmd?.options.map((o) => o.flags) ?? [];
    expect(optionFlags.some((f) => f.includes('--json'))).toBe(true);
    expect(optionFlags.some((f) => f.includes('--fix'))).toBe(true);
  });

  it('DoctorCli_CommanderRouting_DispatchesToOrchestrateDoctor', async () => {
    // Spy on the REAL dispatch to prove the top-level `doctor` verb routes to
    // the SHARED handler via `exarchos_orchestrate` with `action: 'doctor'` —
    // CLI and MCP paths share one handler + one validation gate. The spy wraps
    // (does not stub) the real implementation so the run still exercises the
    // handler end-to-end.
    const dispatchSpy = vi.spyOn(dispatchModule, 'dispatch');

    await runDoctorCli(ctx, ['--json']);

    expect(dispatchSpy).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({ action: 'doctor' }),
      expectedTrustedContext(ctx),
    );
  });
});

// ─── --json envelope + exit 0 ────────────────────────────────────────────────

describe('doctor CLI-adapter — --json formatting (#1337)', () => {
  it('DoctorCli_Json_EmitsValidEnvelopeAndExitsZero', async () => {
    // `exarchos doctor --json` on a fresh project must exit 0 (no critical
    // findings — see the default exit-code test) and emit a single valid JSON
    // envelope on stdout. The envelope is the carrier-shaped wrapper
    // `emitResult` routes `--json` through (`toCliResult(toEnvelope(result),
    // 'json')`): it carries `success`, `data`, and the canonical
    // `next_actions` / `_meta` / `_perf` siblings.
    const { stdout, exitCode } = await runDoctorCli(ctx, ['--json']);

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);

    const env = parseEnvelope(stdout);
    expect(env.success).toBe(true);
    // Canonical envelope fields — these are what distinguish the real envelope
    // from a raw ToolResult (the divergence CodeRabbit flagged on PR #1369).
    // The mocked sibling test cannot assert these because it stubs cli-format.
    expect(env).toHaveProperty('next_actions');
    expect(env).toHaveProperty('_meta');
    expect(env).toHaveProperty('_perf');

    // The doctor payload must validate against the SAME Zod schema the MCP
    // adapter projects through — the CLI cannot drift from the wire shape.
    const parsed = DoctorOutputSchema.safeParse(env.data);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.checks.length).toBeGreaterThan(0);
    // No critical findings on a writable temp-dir project under vitest's Node.
    expect(parsed.data.summary.failed).toBe(0);
  });

  it('DoctorCli_Json_StdoutIsSingleParseableDocument', async () => {
    // Machine consumers do one-shot `JSON.parse` on stdout — heartbeats and
    // diagnostics go to stderr, so stdout must be exactly one JSON document.
    const { stdout } = await runDoctorCli(ctx, ['--json']);
    const trimmed = stdout.trim();
    const firstBrace = trimmed.indexOf('{');
    expect(firstBrace).toBeGreaterThanOrEqual(0);
    // Parsing the whole slice (not a single line) must succeed — `JSON.parse`
    // throws on trailing non-whitespace, so this proves stdout is one document.
    expect(() => JSON.parse(trimmed.slice(firstBrace))).not.toThrow();
  });
});

// ─── Default (non-json) exit-code contract ───────────────────────────────────

describe('doctor CLI-adapter — default exit-code contract (#1337)', () => {
  it('DoctorCli_Default_ExitCodeMatchesContract', async () => {
    // Contract (cli.ts:703-715): a read-only `exarchos doctor` maps
    // `summary.failed > 0` → HANDLER_ERROR (2), else SUCCESS (0). Warnings
    // alone are advisory and do NOT change the exit code. We read the ACTUAL
    // summary via a parallel `--json` run, then assert the default (table) run's
    // exit code equals the contract-derived expectation for that summary —
    // pinning the relationship without hard-coding host-specific Fail counts.
    const jsonRun = await runDoctorCli(ctx, ['--json']);
    const env = parseEnvelope(jsonRun.stdout);
    const failed = env.data?.summary?.failed ?? 0;
    const expectedExit =
      failed > 0 ? CLI_EXIT_CODES.HANDLER_ERROR : CLI_EXIT_CODES.SUCCESS;

    // Default invocation (no --json → table pretty-print path).
    const defaultRun = await runDoctorCli(ctx, []);
    expect(defaultRun.exitCode).toBe(expectedExit);

    // On a writable temp-dir project under vitest the deterministic outcome is
    // a clean (or warnings-only) run → exit 0. Assert that explicitly so a
    // regression that starts emitting a spurious Fail (flipping exit to 2) is
    // caught here, not just in the relationship check above.
    expect(failed).toBe(0);
    expect(defaultRun.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
  });
});

// ─── Shebang invocation ──────────────────────────────────────────────────────
//
// Two layers, matching the existing `install-skills binary smoke` pattern in
// cli.test.ts:
//   1. An UNCONDITIONAL static guard that the CLI entry module carries the
//      `#!/usr/bin/env node` shebang — so the binary is launchable as a script.
//      This always runs (no build required) and fails loud if the shebang is
//      ever dropped.
//   2. A CONDITIONAL spawn against the compiled host binary that proves the
//      shebang actually dispatches `doctor --json` end-to-end. Skipped when the
//      binary is absent (developers without a local build) so there is no
//      phantom failure; CI builds before tests, so the binary IS present.

/** Path to the CLI entry module that carries the shebang. */
function indexModulePath(): string {
  // cli-doctor-adapter.test.ts lives at servers/exarchos-mcp/src/adapters/, so
  // the CLI entry is two directories up at servers/exarchos-mcp/src/index.ts.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'index.ts');
}

/** Locate the compiled host binary, or null when it has not been built. */
function findHostBinary(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'linux'
        ? 'linux'
        : process.platform === 'win32'
          ? 'windows'
          : null;
  if (!platform) return null;
  const ext = platform === 'windows' ? '.exe' : '';
  // src/adapters/ → repo root is four directories up.
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
  );
  const candidate = path.join(
    repoRoot,
    'dist',
    'bin',
    `exarchos-${platform}-${arch}${ext}`,
  );
  return fs.existsSync(candidate) ? candidate : null;
}

const SMOKE_BINARY = findHostBinary();

describe('doctor CLI-adapter — shebang invocation (#1337)', () => {
  it('DoctorCli_Shebang_Invokes', () => {
    // Static guard: the CLI entry module MUST start with the node shebang so
    // the compiled binary is directly invocable as a script (`./exarchos doctor`).
    // Dropping this silently breaks script-style invocation; the conditional
    // spawn below proves it actually dispatches when a binary exists, but this
    // assertion always runs.
    const firstLine = fs.readFileSync(indexModulePath(), 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it.skipIf(!SMOKE_BINARY)(
    'DoctorCli_Shebang_BinaryDispatchesDoctor',
    async () => {
      // Per-test timeout well above the child budget — process-spawn tests
      // flake at the 5s default under load (project memory: vitest spawn-timeout
      // flake). 30s mirrors the existing install-skills binary smoke test.
      if (!SMOKE_BINARY) throw new Error('binary check should have skipped');
      const { spawnSync } = await import('node:child_process');
      const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-shebang-home-'));
      const stateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-shebang-state-'));
      try {
        // Invoke the binary directly — the kernel honors the `#!/usr/bin/env
        // node` shebang to launch it. `doctor --json` must produce a parseable
        // envelope and a contract-compliant exit code (0 when no Fails).
        const result = spawnSync(SMOKE_BINARY, ['doctor', '--json'], {
          encoding: 'utf-8',
          timeout: 25_000,
          env: {
            ...process.env,
            HOME: homeTmp,
            USERPROFILE: homeTmp,
            WORKFLOW_STATE_DIR: stateTmp,
          },
        });
        expect(result.error).toBeUndefined();
        // Exit 0 (no critical findings) or 2 (Fail present) are the only
        // contract-valid statuses; never a crash (null) or INVALID_INPUT (1).
        expect([CLI_EXIT_CODES.SUCCESS, CLI_EXIT_CODES.HANDLER_ERROR]).toContain(
          result.status,
        );
        const firstBrace = result.stdout.indexOf('{');
        expect(firstBrace).toBeGreaterThanOrEqual(0);
        const env = JSON.parse(result.stdout.slice(firstBrace)) as {
          success: boolean;
          data?: { checks?: unknown[] };
        };
        expect(typeof env.success).toBe('boolean');
        expect(Array.isArray(env.data?.checks)).toBe(true);
      } finally {
        rmrf(homeTmp);
        rmrf(stateTmp);
      }
    },
    30_000,
  );
});
