import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildCli, CLI_EXIT_CODES } from '../adapters/cli.js';
import { dispatch, type DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';

// ─── Task 014: CLI-vs-MCP Parity for exarchos_workflow (DR-3) ─────────────────
// These tests prove that the CLI adapter (task 013 work) and the MCP adapter
// emit byte-for-byte equal ToolResult payloads for the three core workflow
// actions: init, get, set. Downstream parity tasks (015-017) extend this
// pattern to the other composite tools.
//
// Strategy:
// - Run both adapters in-process against *separate* tmp state dirs with the
//   same feature id so their side effects don't collide.
// - Normalize timestamps (ISO 8601) and UUIDs before deep-equal comparison
//   so wall-clock jitter between the two calls doesn't produce false diffs.
// - Compare the full ToolResult (success flag + data + _meta + error shape).

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

/**
 * Invoke a composite tool action via the CLI adapter. Captures the single
 * JSON line emitted by `--json` mode, parses it, and returns the parsed
 * ToolResult. Uses Commander's `parseAsync` (in-process, no subprocess).
 *
 * @param toolAlias CLI alias for the composite tool (e.g. 'wf' for exarchos_workflow)
 * @param actionFlag CLI action name — may differ from the action's registry
 *        name when the action declares `cli.alias` (e.g. 'get' is aliased to
 *        'status'; callers pass the alias they want on the command line).
 * @param flags Key/value pairs, converted to --kebab-case flags.
 */
async function callCli(
  ctx: DispatchContext,
  toolAlias: string,
  actionFlag: string,
  flags: Record<string, string>,
): Promise<{ result: ToolResult; exitCode: number }> {
  const program = buildCli(ctx);

  // Capture stdout — the CLI writes exactly one JSON line in --json mode.
  const captured: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });

  const savedExitCode = process.exitCode;
  process.exitCode = undefined;

  const argv: string[] = ['node', 'exarchos', toolAlias, actionFlag];
  for (const [key, value] of Object.entries(flags)) {
    // Convert camelCase to kebab-case for the CLI flag name.
    const kebab = key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    argv.push(`--${kebab}`, value);
  }
  argv.push('--json');

  try {
    await program.parseAsync(argv);
  } finally {
    stdoutSpy.mockRestore();
  }

  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = savedExitCode;

  const stdoutText = captured.join('').trim();
  if (!stdoutText) {
    throw new Error(
      `CLI emitted no stdout for ${toolAlias} ${actionFlag} ${JSON.stringify(flags)} — exit code ${exitCode}`,
    );
  }
  const parsed = JSON.parse(stdoutText) as ToolResult;
  return { result: parsed, exitCode };
}

/**
 * Invoke a composite tool action via the MCP adapter's dispatch entry point.
 * This bypasses the stdio transport (which only matters for wire formatting)
 * and returns the raw ToolResult — exactly what dispatch.ts hands to the
 * MCP SDK `formatResult` wrapper before JSON-stringifying for the SDK.
 */
async function callMcp(
  ctx: DispatchContext,
  tool: string,
  action: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return dispatch(tool, { action, ...args }, ctx);
}

/** Regex for ISO 8601 timestamps — matches both with and without milliseconds. */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

/** Regex for RFC 4122 v4 UUIDs. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Recursively replace time-sensitive or random fields with stable placeholders
 * so two in-process invocations — spaced apart by a few milliseconds — produce
 * byte-equal trees. Volatile fields:
 *  - ISO 8601 timestamps (anywhere in the tree) → `<TS>`
 *  - UUID v4 strings → `<UUID>`
 *  - `minutesSinceActivity` (integer derived from wall-clock) → `<MINUTES>`
 *  - `lastCheckpointTimestamp` / `timestamp` / `lastActivityTimestamp` keys
 *    (redundant with ISO match, but explicit for readability).
 */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP_RE.test(value)) return '<TS>';
    if (UUID_V4_RE.test(value)) return '<UUID>';
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'minutesSinceActivity') {
        out[k] = '<MINUTES>';
      } else {
        out[k] = normalize(v);
      }
    }
    return out;
  }
  return value;
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
  const cliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-parity-cli-'));
  const mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-parity-mcp-'));
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

describe('exarchos_workflow CLI/MCP parity (DR-3)', () => {
  it('WorkflowParity_Init_CliAndMcp_ReturnEqualPayload', async () => {
    const featureId = 'parity-init-feature';
    const workflowType = 'feature';

    // MCP adapter call — dispatch in-process.
    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'init', {
      featureId,
      workflowType,
    });

    // CLI adapter call — parseAsync in-process, --json flag, parse stdout.
    // CLI alias for exarchos_workflow is 'wf'; init action has no cli.alias.
    const { result: cliResult, exitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'init',
      { featureId, workflowType },
    );

    // Exit-code contract (task 013): success → 0.
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);

    // Normalize timestamps so wall-clock jitter doesn't produce false diffs,
    // then deep-equal the full ToolResult (success + data + _meta).
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('WorkflowParity_Get_CliAndMcp_ReturnEqualPayload', async () => {
    const featureId = 'parity-get-feature';
    const workflowType = 'feature';

    // Arrange: init the same workflow on *both* state dirs so each adapter
    // has state to read. This primes the fixture; we then compare the GET
    // call, not the init call.
    await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'init', { featureId, workflowType });
    await callMcp(fixture.cliCtx, 'exarchos_workflow', 'init', { featureId, workflowType });

    // Act — read via both adapters. `get` is exposed as CLI alias `status`.
    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'get', {
      featureId,
      query: 'phase',
    });
    const { result: cliResult, exitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'status',
      { featureId, query: 'phase' },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('WorkflowParity_Set_CliAndMcp_ReturnEqualPayload', async () => {
    const featureId = 'parity-set-feature';
    const workflowType = 'feature';

    // Arrange: init both dirs so `set` has state to mutate.
    await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'init', { featureId, workflowType });
    await callMcp(fixture.cliCtx, 'exarchos_workflow', 'init', { featureId, workflowType });

    // Act — issue the same `set` call through both adapters. We set an
    // artifacts field via --updates rather than a phase transition to keep
    // the test focused on the payload shape (phase transitions trigger HSM
    // guards that would dominate the assertion signal).
    const updates = { 'artifacts.design': 'docs/design.md' };

    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'set', {
      featureId,
      updates,
    });
    const { result: cliResult, exitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'set',
      { featureId, updates: JSON.stringify(updates) },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
