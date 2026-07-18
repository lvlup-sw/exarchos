// ─── T5 (#1240) — `wf checkpoint` CLI handoff convenience flags (RED) ──────
//
// T5 of the checkpoint-handoff bundle adds three convenience CLI flags on
// `exarchos workflow checkpoint` (alias `wf checkpoint`):
//
//   --context <string>         Inline handoff context (max 2KB).
//   --next-steps <step...>     Repeatable handoff next-step entries.
//   --suggestions <sug...>     Repeatable handoff suggestion entries.
//
// These map client-side onto `CheckpointInput.handoff` (a `HandoffEntryData`-
// shaped object: `{ context?, nextSteps?, suggestions? }`) before the call
// hits dispatch. No new MCP-side input shape — the same
// `CheckpointInputSchema.handoff` already accepted by `handleCheckpoint`
// (T4 wiring) is what the dispatch consumes — the flags are purely a
// CLI surface convenience so agents don't have to type nested JSON.
//
// Critical contract (parity-bearing):
//   - When NONE of the convenience flags are present, `handoff` MUST stay
//     ABSENT from the dispatched args (NOT `{ context: undefined, ... }`).
//     The C3 (#1241) idempotency-key digest is `sha256(handoff ?? {})`,
//     and an all-undefined object stringifies to `{}` only by coincidence
//     — explicit absence keeps the digest stable across pre-T5 callers
//     and the new CLI shape.
//   - The flags are CLI-only sugar. The MCP path continues to accept the
//     full `handoff: { context, nextSteps, suggestions }` object directly.
//   - `@<path>` substitution for `--context` was OUT OF SCOPE for T5 and
//     landed in v2.12.0 (DR-20, #1245) — at the HANDLER seam, so the
//     `@<path>` token still passes through this reshape unchanged. See
//     the DR-20 suite at the bottom of this file.
//
// Tests drive Commander in-process (the same harness `parity.test.ts` uses
// for the C9 parity suites) so we exercise the actual auto-generated flag
// surface registered by `buildCli()`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommanderError } from 'commander';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import { handleInit } from '../workflow/tools.js';
import { CONTEXT_AT_PATH_MAX_BYTES } from '../workflow/checkpoint.js';
import { buildCli, applyExitOverrideRecursively, CLI_EXIT_CODES } from './cli.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

interface RunResult {
  readonly result: ToolResult;
  readonly dispatchedArgs: Record<string, unknown>;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Drive the auto-generated `wf checkpoint` CLI command through Commander,
 * with `dispatch()` patched to capture the exact args the action callback
 * forwards to it.  Returns both the captured args (so we can assert on
 * the convenience-flag → `handoff` reshape contract) and the rendered
 * envelope (so we can assert exit code + parity).
 *
 * Patching `dispatch()` rather than running the full handler keeps the
 * test laser-focused on the CLI flag → dispatch arg mapping — which is
 * the only thing T5 changes.
 */
async function runWfCheckpointCli(
  ctx: DispatchContext,
  argv: readonly string[],
): Promise<RunResult> {
  // Lazy-import the dispatch module so we can swap its export with a spy.
  const dispatchMod = await import('../core/dispatch.js');
  const captured: Record<string, unknown>[] = [];
  const dispatchSpy = vi
    .spyOn(dispatchMod, 'dispatch')
    .mockImplementation(async (_tool, args, _ctx) => {
      captured.push(args as Record<string, unknown>);
      // Return a minimal success envelope; we are not exercising the
      // handler here, only the CLI argument-marshalling path.
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

  // CodeRabbit minor on PR #1297: capture the per-call exit code BEFORE
  // the finally block restores `process.exitCode`. If `parseAsync` threw
  // a non-CommanderError it rethrows out of this function, but the
  // restore must still run so the mutated global doesn't leak into
  // subsequent tests in the same Vitest worker.
  let commanderErr: CommanderError | undefined;
  let exitCode = 0;
  try {
    await program.parseAsync([...argv]);
  } catch (err) {
    if (err instanceof CommanderError) {
      commanderErr = err;
    } else {
      // Compute the exit code from the partial run so the restore in
      // `finally` is unconditional, then rethrow.
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
  // The action callback emits a JSON envelope on stdout under --json.
  // PR-B (#1368): post-W1 `emitResult` writes pretty-printed envelope
  // JSON spanning multiple lines (`JSON.stringify(env, null, 2)`), so
  // slicing at the first newline truncates the document at `{`. Parse
  // from the first `{` through end-of-stdout instead — `JSON.parse`
  // tolerates trailing whitespace and stops at the matching brace.
  let parsed: ToolResult = { success: false, error: { code: 'TEST_HARNESS_NO_OUTPUT', message: 'no stdout' } };
  if (stdout.trim().length > 0) {
    const firstBrace = stdout.indexOf('{');
    if (firstBrace >= 0) {
      try {
        parsed = JSON.parse(stdout.slice(firstBrace)) as ToolResult;
      } catch {
        // leave default
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

// ─── Test suite ─────────────────────────────────────────────────────────────

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
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it('CheckpointCli_ContextFlag_BindsToHandoffContext', async () => {
    // GIVEN: a `wf checkpoint --feature-id X --context "value"` invocation.
    // WHEN: the CLI dispatches.
    // THEN: the dispatch args include `handoff.context === "value"` and no
    //       other handoff fields are populated.
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
    // The other two fields stay undefined when only --context is supplied.
    // Asserting absence (rather than `[]`) preserves the C3 digest contract
    // — `JSON.stringify({ context: 'x' })` differs from
    // `JSON.stringify({ context: 'x', nextSteps: [], suggestions: [] })`.
    expect(handoff.nextSteps).toBeUndefined();
    expect(handoff.suggestions).toBeUndefined();
  });

  it('CheckpointCli_NextStepsFlag_AcceptsMultiple', async () => {
    // GIVEN: a `wf checkpoint` invocation with two `--next-steps` flags
    //        (Commander variadic syntax: each occurrence appends).
    // WHEN: the CLI dispatches.
    // THEN: `handoff.nextSteps` is `['first', 'second']`.
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

  it('CheckpointCli_SuggestionsFlag_AcceptsMultiple', async () => {
    // GIVEN: a `wf checkpoint` invocation with two `--suggestions` flags.
    // WHEN: the CLI dispatches.
    // THEN: `handoff.suggestions` is `['first', 'second']`.
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

  it('CheckpointCli_HandoffJsonAndConvenienceFlag_RejectsAsInvalidInput', async () => {
    // GIVEN: a `wf checkpoint` invocation that passes BOTH the raw
    //        `--handoff '{"context":"a"}'` JSON flag AND a convenience
    //        flag (`--context "b"`) on the same command line.
    // WHEN: the CLI dispatches.
    // THEN: the invocation MUST fail with INVALID_INPUT — silently
    //       overwriting the JSON-passed handoff with the synthesized
    //       convenience-flag object would lose data the operator
    //       explicitly supplied. Mutual exclusion is the contract the
    //       error message must convey.
    //
    // Regression guard for Sentry bug-prediction on PR #1297
    // (servers/exarchos-mcp/src/adapters/cli.ts:276-291): pre-fix the
    // reshape block ran unconditionally and clobbered `flagOpts.handoff`.
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
      expect(result.error!.code).toBe('INVALID_INPUT');
      expect(result.error!.message).toMatch(/--handoff/);
      expect(result.error!.message).toMatch(
        /--context|--next-steps|--suggestions|mutually exclusive/i,
      );
    }
    // Dispatch must NOT be invoked when the CLI rejects pre-dispatch.
    expect(dispatchedArgs).toEqual({});
  });

  it('CheckpointCli_NoHandoffFlags_OmitsHandoff', async () => {
    // GIVEN: a `wf checkpoint` invocation with NO handoff convenience
    //        flags (only `--feature-id`).
    // WHEN: the CLI dispatches.
    // THEN: `dispatchedArgs.handoff` is `undefined` — NOT `{}` and NOT
    //       `{ context: undefined, nextSteps: undefined, suggestions: undefined }`.
    //       This is the C3 (#1241) digest-stability contract: pre-T5
    //       no-handoff callers produced `JSON.stringify({}) → '{}'`, and
    //       post-T5 no-handoff callers must produce the same digest.
    //       An all-undefined object would stringify to '{}' too, but the
    //       handler treats `validated.handoff !== undefined` as the
    //       persistence trigger (writes `data.handoff` on the event), so
    //       absence vs. all-undefined is observable on disk.
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
    // Use Object.prototype.hasOwnProperty so we discriminate "key absent"
    // from "key present with undefined value" — both yield
    // `dispatchedArgs.handoff === undefined` under JS lookup, but the
    // contract here is the former.
    const hasHandoffKey = Object.prototype.hasOwnProperty.call(
      dispatchedArgs,
      'handoff',
    );
    expect(hasHandoffKey).toBe(false);
  });
});

// ─── DR-20 (#1245): `--context @<path>` substitution ────────────────────────
//
// v2.12.0 lifts the T5 out-of-scope note: `wf checkpoint --context @<path>`
// now reads the file at `<path>` into `handoff.context`. The substitution
// lives at the HANDLER seam (`resolveContextArgument` in
// workflow/checkpoint.ts, invoked by `handleCheckpoint`) — NOT in the CLI
// reshape block — because CLI flags auto-emit from the action schema and
// the MCP arm must observe identical behavior (INV-4 parity). These tests
// therefore drive the REAL dispatch (no spy): the `@<path>` token flows
// through the convenience-flag reshape and the schema parse unchanged, and
// the handler performs the read. Assertions land on the persisted event
// (success) and on the rendered INV-5b error envelope + exit code
// (failure paths).

/**
 * Drive `wf checkpoint` through Commander with the REAL dispatch chain
 * (composite handler → handleCheckpoint). Unlike `runWfCheckpointCli`
 * above, nothing is mocked — the workflow must already exist in
 * `ctx.stateDir`. Returns the parsed stdout envelope and exit code.
 */
async function runWfCheckpointCliRealDispatch(
  ctx: DispatchContext,
  argv: readonly string[],
): Promise<Omit<RunResult, 'dispatchedArgs'>> {
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
      exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
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
  }

  const stdout = stdoutBuf.join('');
  const stderr = stderrBuf.join('');
  let parsed: ToolResult = {
    success: false,
    error: { code: 'TEST_HARNESS_NO_OUTPUT', message: 'no stdout' },
  };
  if (stdout.trim().length > 0) {
    const firstBrace = stdout.indexOf('{');
    if (firstBrace >= 0) {
      try {
        parsed = JSON.parse(stdout.slice(firstBrace)) as ToolResult;
      } catch {
        // leave default
      }
    }
  }

  return { result: parsed, exitCode, stdout, stderr };
}

describe('wf checkpoint — --context @<path> substitution (DR-20, #1245)', () => {
  let stateDir: string;
  let contextDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dr20-cli-state-'));
    contextDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dr20-cli-ctx-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    ctx = { stateDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(contextDir, { recursive: true, force: true });
  });

  it('CheckpointCli_ContextAtPath_ValidFile_Substitutes', async () => {
    // GIVEN: an existing workflow and a context file under the byte cap.
    const featureId = 'cli-dr20-valid';
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    const fileContent = 'CLI-arm handoff: read from disk, not typed inline.\n';
    const contextFile = path.join(contextDir, 'notes.md');
    await fs.writeFile(contextFile, fileContent, 'utf8');

    // WHEN: `wf checkpoint --context @<path>` runs against real dispatch.
    const { result, exitCode } = await runWfCheckpointCliRealDispatch(ctx, [
      'node',
      'exarchos',
      'wf',
      'checkpoint',
      '--feature-id',
      featureId,
      '--context',
      `@${contextFile}`,
      '--json',
    ]);

    // THEN: success, and the persisted workflow.checkpoint event carries
    // the FILE CONTENT — the raw `@<path>` token never reaches disk.
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(result.success).toBe(true);
    const events = await eventStore.query(featureId, {
      type: 'workflow.checkpoint',
    });
    expect(events.length).toBe(1);
    const data = events[0]!.data as { handoff?: { context?: string } };
    expect(data.handoff?.context).toBe(fileContent);
  });

  it('CheckpointCli_ContextAtPath_MissingFile_StructuredEnoent', async () => {
    // GIVEN: an existing workflow and a path with no file behind it.
    const featureId = 'cli-dr20-missing';
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    const missingFile = path.join(contextDir, 'nope.md');

    const { result, exitCode } = await runWfCheckpointCliRealDispatch(ctx, [
      'node',
      'exarchos',
      'wf',
      'checkpoint',
      '--feature-id',
      featureId,
      '--context',
      `@${missingFile}`,
      '--json',
    ]);

    // THEN: a structured FILE_IO_ERROR envelope naming ENOENT rendered on
    // stdout (INV-5b) with the generic handler-error exit code — the CLI
    // process must NOT die on an uncaught exception (exit 3).
    expect(exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_IO_ERROR');
    expect(result.error?.message).toMatch(/ENOENT/);
    expect(result.error?.message).toContain(missingFile);

    // Rejection is pre-write: no checkpoint event landed.
    const events = await eventStore.query(featureId, {
      type: 'workflow.checkpoint',
    });
    expect(events.length).toBe(0);
  });

  it('CheckpointCli_ContextAtPath_OversizeFile_StructuredError', async () => {
    // GIVEN: an existing workflow and a file one byte over the cap.
    const featureId = 'cli-dr20-oversize';
    const init = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      eventStore,
    );
    expect(init.success).toBe(true);

    const oversizeFile = path.join(contextDir, 'oversize.md');
    await fs.writeFile(
      oversizeFile,
      'x'.repeat(CONTEXT_AT_PATH_MAX_BYTES + 1),
      'utf8',
    );

    const { result, exitCode } = await runWfCheckpointCliRealDispatch(ctx, [
      'node',
      'exarchos',
      'wf',
      'checkpoint',
      '--feature-id',
      featureId,
      '--context',
      `@${oversizeFile}`,
      '--json',
    ]);

    // THEN: structured INVALID_INPUT with the byte cap in the message,
    // mapped to the INVALID_INPUT exit code.
    expect(exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(
      new RegExp(String(CONTEXT_AT_PATH_MAX_BYTES)),
    );

    const events = await eventStore.query(featureId, {
      type: 'workflow.checkpoint',
    });
    expect(events.length).toBe(0);
  });
});
