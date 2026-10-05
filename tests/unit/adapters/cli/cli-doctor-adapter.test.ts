// End-to-end tests of the `exarchos doctor` CLI adapter: Commander routing, the exit code, the
// `--json` envelope, and the shebang of the entry module.
//
// The sibling `cli-doctor.test.ts` pins the exit-code mapping, but it mocks `dispatch` and
// `cli-format`. This file drives the real `buildCli(ctx)` against a real `EventStore`, so the
// verb runs the real handler and the real `toEnvelope` formatter.
//
// The exit code is HANDLER_ERROR (2) when `summary.failed > 0`, and SUCCESS (0) otherwise.
// Warnings do not change the exit code.
//
// `doctor` is a top-level verb, so the file has its own harness around `parseAsync`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildCli, CLI_EXIT_CODES } from '../../../../src/adapters/cli/cli.js';
import { EventStore } from '../../../../src/events/store.js';
import * as dispatchModule from '../../../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { DoctorOutputSchema } from '../../../../src/verbs/doctor/schema.js';
import { spawnAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { expectedTrustedContext } from '../../../../tools/test-helpers/trusted-context.js';

interface DoctorCliRun {
  /** Concatenated stdout the CLI wrote during the parse. */
  readonly stdout: string;
  /** `process.exitCode` set by the action callback (defaulting to 0). */
  readonly exitCode: number;
}

/**
 * Runs the top-level `exarchos doctor` verb in-process and captures stdout and `process.exitCode`.
 * `exitOverride` stops a Commander parse exit from ending the worker. The function restores the
 * earlier exit code, so a non-zero value does not leak into other tests.
 */
async function runDoctorCli(
  ctx: DispatchContext,
  extraArgs: readonly string[],
): Promise<DoctorCliRun> {
  const program = buildCli(ctx);
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

let tmpDir: string;
let ctx: DispatchContext;

/** `cwd` is the temp directory, so the doctor checks read fixture state and not the real environment. */
beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'doctor-cli-1337-'));
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false, cwd: tmpDir };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rmrfAsync(tmpDir);
});

describe('doctor CLI-adapter — Commander routing (#1337)', () => {
  /** `doctor` is a top-level verb with the `--json` flag and the schema-driven `--fix` flag. */
  it('DoctorCli_CommanderRouting_RegistersTopLevelDoctorVerb', () => {
    const program = buildCli(ctx);
    const doctorCmd = program.commands.find((c) => c.name() === 'doctor');
    expect(doctorCmd, 'exarchos doctor top-level verb not registered').toBeDefined();

    const optionFlags = doctorCmd?.options.map((o) => o.flags) ?? [];
    expect(optionFlags.some((f) => f.includes('--json'))).toBe(true);
    expect(optionFlags.some((f) => f.includes('--fix'))).toBe(true);
  });

  /** The spy wraps the real `dispatch` and does not stub it, so the run still reaches the shared handler. */
  it('DoctorCli_CommanderRouting_DispatchesToOrchestrateDoctor', async () => {
    const dispatchSpy = vi.spyOn(dispatchModule, 'dispatch');

    await runDoctorCli(ctx, ['--json']);

    expect(dispatchSpy).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({ action: 'doctor' }),
      expectedTrustedContext(ctx),
    );
  });
});

describe('doctor CLI-adapter — --json formatting (#1337)', () => {
  /**
   * A writable temp project has no failed check, so `doctor --json` exits 0 with one envelope on
   * stdout. `next_actions`, `_meta` and `_perf` distinguish the envelope from a raw `ToolResult`.
   * The sibling test stubs `cli-format` and cannot assert them.
   * The payload must also pass `DoctorOutputSchema`, the schema of the handler output.
   */
  it('DoctorCli_Json_EmitsValidEnvelopeAndExitsZero', async () => {
    const { stdout, exitCode } = await runDoctorCli(ctx, ['--json']);

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);

    const env = parseEnvelope(stdout);
    expect(env.success).toBe(true);
    expect(env).toHaveProperty('next_actions');
    expect(env).toHaveProperty('_meta');
    expect(env).toHaveProperty('_perf');

    const parsed = DoctorOutputSchema.safeParse(env.data);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.checks.length).toBeGreaterThan(0);
    expect(parsed.data.summary.failed).toBe(0);
  });

  /**
   * Machine consumers parse stdout one time, and heartbeats and diagnostics go to stderr.
   * `JSON.parse` throws on trailing text, so a parse of the whole slice proves one document.
   */
  it('DoctorCli_Json_StdoutIsSingleParseableDocument', async () => {
    const { stdout } = await runDoctorCli(ctx, ['--json']);
    const trimmed = stdout.trim();
    const firstBrace = trimmed.indexOf('{');
    expect(firstBrace).toBeGreaterThanOrEqual(0);
    expect(() => JSON.parse(trimmed.slice(firstBrace))).not.toThrow();
  });
});

describe('doctor CLI-adapter — default exit-code contract (#1337)', () => {
  /**
   * A `--json` run gives the actual summary. The default (table) run must then exit with the code
   * that the contract gives for that summary, so the test holds no host-specific count.
   * A writable temp project has no failed check, so the test also asserts exit 0 directly. That
   * assertion catches a spurious failed check.
   */
  it('DoctorCli_Default_ExitCodeMatchesContract', async () => {
    const jsonRun = await runDoctorCli(ctx, ['--json']);
    const env = parseEnvelope(jsonRun.stdout);
    const failed = env.data?.summary?.failed ?? 0;
    const expectedExit =
      failed > 0 ? CLI_EXIT_CODES.HANDLER_ERROR : CLI_EXIT_CODES.SUCCESS;

    const defaultRun = await runDoctorCli(ctx, []);
    expect(defaultRun.exitCode).toBe(expectedExit);

    expect(failed).toBe(0);
    expect(defaultRun.exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
  });
});

/** Path to the CLI entry module that carries the shebang. */
function indexModulePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../src/index.ts');
}

/** Returns the path of the compiled host binary, or null when no build exists. */
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
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..');
  const candidate = path.join(
    repoRoot,
    'dist',
    'bin',
    `exarchos-${platform}-${arch}${ext}`,
  );
  return fs.existsSync(candidate) ? candidate : null;
}

const SMOKE_BINARY = findHostBinary();

/**
 * Two layers. A static guard needs no build and always runs: the CLI entry module must start with
 * the node shebang. A spawn of the compiled host binary then runs `doctor --json` end to end.
 * The spawn test skips when the binary is absent.
 */
describe('doctor CLI-adapter — shebang invocation (#1337)', () => {
  it('DoctorCli_Shebang_Invokes', () => {
    const firstLine = fs.readFileSync(indexModulePath(), 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  /**
   * Only exit 0 and exit 2 are valid. A crash (null) and INVALID_INPUT (1) fail the test.
   * The 30 s test timeout is above the 25 s child budget, because a spawn test can exceed the 5 s
   * default under load.
   */
  it.skipIf(!SMOKE_BINARY)(
    'DoctorCli_Shebang_BinaryDispatchesDoctor',
    async () => {
      if (!SMOKE_BINARY) throw new Error('binary check should have skipped');
      const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-shebang-home-'));
      const stateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-shebang-state-'));
      try {
        const result = await spawnAsync(SMOKE_BINARY, ['doctor', '--json'], {
          timeout: 25_000,
          env: {
            ...process.env,
            HOME: homeTmp,
            USERPROFILE: homeTmp,
            WORKFLOW_STATE_DIR: stateTmp,
          },
        });
        expect(result.error).toBeUndefined();
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
