// The handoff convenience flags of `exarchos workflow checkpoint` (alias `wf checkpoint`):
// `--context <string>`, `--next-steps <step...>` and `--suggestions <suggestion...>`.
//
// The CLI maps the flags onto `handoff` (`{ context?, nextSteps?, suggestions? }`) before
// dispatch. The MCP path accepts the full `handoff` object directly.
//
// With no convenience flag, `handoff` must stay absent from the dispatched arguments. The
// idempotency-key digest is `sha256(handoff ?? {})`, and the handler writes `data.handoff` on the
// event when `handoff` is defined.
//
// `--context` accepts an inline string only, with no `@<path>` substitution.
//
// The tests drive Commander in-process against the flag surface that `buildCli()` registers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommanderError } from 'commander';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { buildCli, applyExitOverrideRecursively, CLI_EXIT_CODES } from '../../../../src/adapters/cli/cli.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

interface RunResult {
  readonly result: ToolResult;
  readonly dispatchedArgs: Record<string, unknown>;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Drives the generated `wf checkpoint` command through Commander with `dispatch()` replaced by a
 * spy. The spy records the forwarded arguments and returns a minimal success envelope, so the
 * handler does not run.
 *
 * The function reads the exit code before `finally` restores `process.exitCode`. The restore also
 * runs when `parseAsync` throws a non-Commander error, so the global does not leak into later tests.
 *
 * `emitResult` writes the envelope as multi-line JSON, so the function parses stdout from the
 * first `{` to the end. When that parse fails, `result` stays the `TEST_HARNESS_NO_OUTPUT` error.
 */
async function runWfCheckpointCli(
  ctx: DispatchContext,
  argv: readonly string[],
): Promise<RunResult> {
  const dispatchMod = await import('../../../../src/dispatch/core/dispatch.js');
  const captured: Record<string, unknown>[] = [];
  const dispatchSpy = vi
    .spyOn(dispatchMod, 'dispatch')
    .mockImplementation(async (_tool, args, _ctx) => {
      captured.push(args as Record<string, unknown>);
      return {
        success: true,
        data: { phase: 'ideate', projectionSequence: 1 },
        next_actions: [],
        _meta: { checkpointAdvised: false },
      } satisfies ToolResult;
    });

  const program = buildCli(ctx);
  applyExitOverrideRecursively(program);

  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutBuf.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrBuf.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });

  const savedExit = process.exitCode;
  process.exitCode = undefined;

  let commanderErr: CommanderError | undefined;
  let exitCode = 0;
  try {
    await program.parseAsync([...argv]);
  } catch (err) {
    if (err instanceof CommanderError) {
      commanderErr = err;
    } else {
      exitCode =
        typeof process.exitCode === 'number'
          ? process.exitCode
          : 0;
      throw err;
    }
  } finally {
    if (commanderErr !== undefined || exitCode === 0) {
      exitCode =
        typeof process.exitCode === 'number'
          ? process.exitCode
          : commanderErr?.exitCode ?? exitCode;
    }
    process.exitCode = savedExit;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    dispatchSpy.mockRestore();
  }

  const stdout = stdoutBuf.join('');
  const stderr = stderrBuf.join('');
  let parsed: ToolResult = { success: false, error: { code: 'TEST_HARNESS_NO_OUTPUT', message: 'no stdout' } };
  if (stdout.trim().length > 0) {
    const firstBrace = stdout.indexOf('{');
    if (firstBrace >= 0) {
      try {
        parsed = JSON.parse(stdout.slice(firstBrace)) as ToolResult;
      } catch {
      }
    }
  }

  return {
    result: parsed,
    dispatchedArgs: captured[0] ?? {},
    exitCode,
    stdout,
    stderr,
  };
}

describe('wf checkpoint — handoff convenience flags (T5, #1240)', () => {
  let stateDir: string;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 't5-cli-flags-'));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    ctx = { stateDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * With only `--context`, the other two handoff fields stay undefined and are not `[]`. An empty
   * array changes the JSON that the digest reads.
   */
  it('CheckpointCli_ContextFlag_BindsToHandoffContext', async () => {
    const { dispatchedArgs, exitCode } = await runWfCheckpointCli(ctx, [
      'node',
      'exarchos',
      'wf',
      'checkpoint',
      '--feature-id',
      'cli-ctx-only',
      '--context',
      'Wave 1 implementer team finished T1-T3; T4 next',
      '--json',
    ]);

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(dispatchedArgs.action).toBe('checkpoint');
    expect(dispatchedArgs.featureId).toBe('cli-ctx-only');
    expect(dispatchedArgs.handoff).toBeDefined();
    const handoff = dispatchedArgs.handoff as {
      context?: string;
      nextSteps?: string[];
      suggestions?: string[];
    };
    expect(handoff.context).toBe('Wave 1 implementer team finished T1-T3; T4 next');
    expect(handoff.nextSteps).toBeUndefined();
    expect(handoff.suggestions).toBeUndefined();
  });

  /** Each `--next-steps` occurrence appends one entry. */
  it('CheckpointCli_NextStepsFlag_AcceptsMultiple', async () => {
    const { dispatchedArgs, exitCode } = await runWfCheckpointCli(ctx, [
      'node',
      'exarchos',
      'wf',
      'checkpoint',
      '--feature-id',
      'cli-next-steps',
      '--next-steps',
      'first',
      '--next-steps',
      'second',
      '--json',
    ]);

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    const handoff = dispatchedArgs.handoff as {
      nextSteps?: string[];
      context?: string;
      suggestions?: string[];
    };
    expect(handoff).toBeDefined();
    expect(handoff.nextSteps).toEqual(['first', 'second']);
    expect(handoff.context).toBeUndefined();
    expect(handoff.suggestions).toBeUndefined();
  });

  /** Each `--suggestions` occurrence appends one entry. */
  it('CheckpointCli_SuggestionsFlag_AcceptsMultiple', async () => {
    const { dispatchedArgs, exitCode } = await runWfCheckpointCli(ctx, [
      'node',
      'exarchos',
      'wf',
      'checkpoint',
      '--feature-id',
      'cli-sugg',
      '--suggestions',
      'first',
      '--suggestions',
      'second',
      '--json',
    ]);

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    const handoff = dispatchedArgs.handoff as {
      suggestions?: string[];
      context?: string;
      nextSteps?: string[];
    };
    expect(handoff).toBeDefined();
    expect(handoff.suggestions).toEqual(['first', 'second']);
    expect(handoff.context).toBeUndefined();
    expect(handoff.nextSteps).toBeUndefined();
  });

  /**
   * `--handoff` together with a convenience flag fails before dispatch. A silent overwrite loses
   * the handoff that the operator passed as JSON.
   */
  it('CheckpointCli_HandoffJsonAndConvenienceFlag_RejectsAsInvalidInput', async () => {
    const { result, exitCode, dispatchedArgs } = await runWfCheckpointCli(ctx, [
      'node',
      'exarchos',
      'wf',
      'checkpoint',
      '--feature-id',
      'cli-handoff-conflict',
      '--handoff',
      '{"context":"from-json"}',
      '--context',
      'from-convenience',
      '--json',
    ]);

    expect(exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/--handoff/);
      expect(result.error.message).toMatch(
        /--context|--next-steps|--suggestions|mutually exclusive/i,
      );
    }
    expect(dispatchedArgs).toEqual({});
  });

  /**
   * With no handoff flag, the `handoff` key is absent. An object of undefined fields gives the same
   * digest, but the handler then writes `data.handoff` on the event.
   * The test uses `hasOwnProperty` because a lookup returns `undefined` for an absent key and for
   * an undefined value.
   */
  it('CheckpointCli_NoHandoffFlags_OmitsHandoff', async () => {
    const { dispatchedArgs, exitCode } = await runWfCheckpointCli(ctx, [
      'node',
      'exarchos',
      'wf',
      'checkpoint',
      '--feature-id',
      'cli-no-handoff',
      '--json',
    ]);

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(dispatchedArgs.action).toBe('checkpoint');
    expect(dispatchedArgs.featureId).toBe('cli-no-handoff');
    const hasHandoffKey = Object.prototype.hasOwnProperty.call(
      dispatchedArgs,
      'handoff',
    );
    expect(hasHandoffKey).toBe(false);
  });
});
