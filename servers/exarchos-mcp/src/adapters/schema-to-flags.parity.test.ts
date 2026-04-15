import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CommanderError } from 'commander';

import { buildCli, commanderErrorToResult, applyExitOverrideRecursively } from './cli.js';
import { dispatch, type DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';

// ─── Task 024: CLI-vs-MCP Argument Coercion Failure Parity (DR-5) ────────────
// These tests prove that when users provide malformed arguments — missing a
// required field, passing a wrong-typed value, or naming an action that does
// not exist — the CLI and MCP adapters reject with the SAME `error.code` and
// an equivalent message. Prior to task 024, the CLI produced ToolResult
// `INVALID_INPUT` payloads but the MCP dispatch layer could silently pass
// bad args through to the composite handler (per-action schemas were only
// enforced by the CLI layer). This test locks in parity so future changes
// cannot drift the two facades apart.
//
// Strategy:
// - Invoke each adapter with the same malformed payload.
// - Both paths MUST return a ToolResult with { success: false, error.code }
//   and error.code MUST match between the two. Messages may differ in
//   surface wording but must reference the same failing field.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

/**
 * Invoke a CLI action via Commander in-process, capturing the single JSON
 * line written to stdout in --json mode and parsing it back into a
 * ToolResult. Installs `exitOverride` on the root program so Commander's
 * own validation errors (missing mandatory option, missing argument,
 * unknown command) surface as exceptions — this test harness then
 * converts those into a synthetic ToolResult so we can compare codes
 * against the MCP facade.
 *
 * Production CLI path still uses the real buildCli — this helper only
 * wraps parseAsync to normalize the failure contract for assertion.
 */
async function callCli(
  ctx: DispatchContext,
  toolAlias: string,
  actionFlag: string,
  flags: Record<string, string>,
): Promise<{ result: ToolResult; exitCode: number }> {
  const program = buildCli(ctx);
  // F-024 #3: share the recursive helper with the production runCli so both
  // paths install exitOverride the same way (no 3-level hand-rolling).
  applyExitOverrideRecursively(program);

  const capturedStdout: string[] = [];
  const capturedStderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    capturedStdout.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    capturedStderr.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });

  const savedExitCode = process.exitCode;
  process.exitCode = undefined;

  const argv: string[] = ['node', 'exarchos', toolAlias, actionFlag];
  for (const [key, value] of Object.entries(flags)) {
    const kebab = key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    argv.push(`--${kebab}`, value);
  }
  argv.push('--json');

  let commanderError: CommanderError | undefined;
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      commanderError = err;
    } else {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      throw err;
    }
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : (commanderError?.exitCode ?? 0);
  process.exitCode = savedExitCode;

  // If commander threw before our action handler ran (e.g. missing mandatory
  // option), the CLI emitted nothing on stdout. For parity assertion purposes
  // we treat that as divergence: a Commander-thrown error should have been
  // caught by the adapter and emitted as INVALID_INPUT.
  const stdoutText = capturedStdout.join('').trim();
  if (stdoutText) {
    const parsed = JSON.parse(stdoutText) as ToolResult;
    return { result: parsed, exitCode };
  }

  if (commanderError) {
    // Funnel Commander errors through the shared converter — this is the
    // same mapping the production `runCli` entry point applies, so the
    // test's assertion reflects the real CLI contract rather than a
    // synthetic placeholder.
    const { result, exitCode: mappedExit } = commanderErrorToResult(commanderError);
    return { result, exitCode: mappedExit };
  }

  throw new Error(
    `CLI emitted no stdout and no Commander error for ${toolAlias} ${actionFlag} ${JSON.stringify(flags)}`,
  );
}

/** Invoke a composite tool action via the MCP adapter's dispatch entry point. */
async function callMcp(
  ctx: DispatchContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return dispatch(tool, args, ctx);
}

/** Extract just the error code (success payloads flagged as 'OK' sentinel). */
function errorCode(result: ToolResult): string {
  if (result.success) return '__SUCCESS__';
  return result.error?.code ?? '__MISSING_ERROR__';
}

// ─── Fixture Harness ─────────────────────────────────────────────────────────

interface ParityFixture {
  readonly cliDir: string;
  readonly mcpDir: string;
  readonly cliCtx: DispatchContext;
  readonly mcpCtx: DispatchContext;
}

let fixture: ParityFixture;

beforeEach(async () => {
  const cliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-coerce-cli-'));
  const mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-coerce-mcp-'));
  fixture = {
    cliDir,
    mcpDir,
    cliCtx: makeCtx(cliDir),
    mcpCtx: makeCtx(mcpDir),
  };
});

afterEach(async () => {
  await fs.rm(fixture.cliDir, { recursive: true, force: true });
  await fs.rm(fixture.mcpDir, { recursive: true, force: true });
});

// ─── Parity Tests ────────────────────────────────────────────────────────────

describe('CLI/MCP argument coercion failure parity (DR-5)', () => {
  it('MalformedArgs_MissingRequired_BothFacades_RejectWithSameErrorCode', async () => {
    // `exarchos_workflow init` requires `featureId` and `workflowType`.
    // Invoke with `workflowType` present but `featureId` missing via both
    // adapters and assert both reject with INVALID_INPUT.

    const { result: cliResult, exitCode: cliExitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'init',
      { workflowType: 'feature' }, // featureId deliberately omitted
    );

    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', {
      action: 'init',
      workflowType: 'feature',
      // featureId deliberately omitted
    });

    // Both must fail.
    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);

    // Both must produce INVALID_INPUT (the canonical code for per-action
    // schema validation failure).
    expect(errorCode(cliResult)).toBe('INVALID_INPUT');
    expect(errorCode(mcpResult)).toBe('INVALID_INPUT');

    // And both codes must be identical (redundant but self-documenting).
    expect(errorCode(cliResult)).toBe(errorCode(mcpResult));

    // CLI exit code must map to INVALID_INPUT (1).
    expect(cliExitCode).toBe(1);

    // Messages must reference the failing field so UX is equivalent.
    // Loose substring match — wording may differ but `featureId` (or its
    // kebab form) must appear in both.
    const cliMsg = cliResult.error?.message ?? '';
    const mcpMsg = mcpResult.error?.message ?? '';
    expect(cliMsg.toLowerCase()).toMatch(/feature-?id/);
    expect(mcpMsg.toLowerCase()).toMatch(/feature-?id/);
  });

  it('MalformedArgs_WrongType_BothFacades_RejectWithSameErrorCode', async () => {
    // `exarchos_workflow init` requires `featureId: string`. Pass a
    // non-string (MCP) or a value that will fail FeatureIdSchema constraints
    // (CLI uses string flags, so we pass a value that violates the regex).
    //
    // Both facades must emit INVALID_INPUT.

    // CLI: pass a feature id that violates FeatureIdSchema's regex
    // (uppercase letters are forbidden in the feature-id format).
    const { result: cliResult, exitCode: cliExitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'init',
      { featureId: 'BAD_ID_WITH_UPPERCASE', workflowType: 'feature' },
    );

    // MCP: pass featureId as a number — wrong type at the schema level.
    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', {
      action: 'init',
      featureId: 12345,
      workflowType: 'feature',
    });

    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);

    expect(errorCode(cliResult)).toBe('INVALID_INPUT');
    expect(errorCode(mcpResult)).toBe('INVALID_INPUT');
    expect(errorCode(cliResult)).toBe(errorCode(mcpResult));

    expect(cliExitCode).toBe(1);

    // Messages should reference the offending field in both.
    const cliMsg = cliResult.error?.message ?? '';
    const mcpMsg = mcpResult.error?.message ?? '';
    expect(cliMsg.toLowerCase()).toMatch(/feature-?id/);
    expect(mcpMsg.toLowerCase()).toMatch(/feature-?id/);
  });

  it('MalformedArgs_UnknownAction_BothFacades_RejectWithSameErrorCode', async () => {
    // Passing an action name the registry doesn't know about must produce
    // the same error shape from both facades.
    //
    // Historical note: the MCP composite handler returns UNKNOWN_ACTION
    // from its default switch case, while Commander used to throw a
    // CommanderError for unknown subcommands. This test asserts both paths
    // funnel through the same INVALID_INPUT contract so tool agents can
    // detect bad action names uniformly.

    const { result: cliResult, exitCode: cliExitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'nonexistent_action_xyz',
      {},
    );

    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', {
      action: 'nonexistent_action_xyz',
    });

    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);

    // Codes must match across facades.
    expect(errorCode(cliResult)).toBe(errorCode(mcpResult));

    // The code itself must be INVALID_INPUT (the canonical rejection code
    // for malformed input at the adapter boundary).
    expect(errorCode(cliResult)).toBe('INVALID_INPUT');

    expect(cliExitCode).toBe(1);
  });
});
