import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from './store.js';
import { dispatch } from '../core/dispatch.js';
import { buildCli } from '../adapters/cli.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';

// ─── DR-3 Parity Tests: exarchos_event ──────────────────────────────────────
// Asserts that invoking `exarchos_event` actions through the CLI adapter and
// the MCP-style `dispatch()` entry point produces structurally equivalent
// ToolResult payloads. Differences that are expected (timestamps, UUIDs,
// sequence numbers) are normalized before comparison. Runs sibling to the
// task-014 (`exarchos_workflow`) parity suite.

// ─── Normalization Helpers ──────────────────────────────────────────────────

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recursively strip fields that are inherently non-deterministic across two
 * independent handler invocations (timestamps, UUIDs). This lets the rest of
 * the payload be compared structurally via deep-equal.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') {
        if (ISO_TIMESTAMP_RE.test(v)) continue;
        if (UUID_RE.test(v)) continue;
        out[k] = v;
        continue;
      }
      // _perf timings are telemetry-derived and non-deterministic — elide when
      // the parity suite runs with telemetry disabled they'll be absent anyway.
      if (k === '_perf') continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

// ─── Adapter Callers ────────────────────────────────────────────────────────

interface ParityHarness {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function makeHarness(label: string): Promise<ParityHarness> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `event-parity-${label}-`));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  return { stateDir, ctx };
}

async function teardownHarness(harness: ParityHarness): Promise<void> {
  await fs.rm(harness.stateDir, { recursive: true, force: true });
}

/** Invoke a tool action via the MCP-shaped `dispatch()` entry point. */
async function callMcp(
  tool: string,
  action: string,
  args: Record<string, unknown>,
  harness: ParityHarness,
): Promise<ToolResult> {
  return dispatch(tool, { action, ...args }, harness.ctx);
}

/**
 * Invoke a tool action through the CLI adapter. Builds the Commander program
 * with the given context, captures stdout under `--json` mode, parses the
 * emitted ToolResult, and restores process state.
 */
async function callCli(
  toolAlias: string,
  action: string,
  flags: ReadonlyArray<string>,
  harness: ParityHarness,
): Promise<ToolResult> {
  const program = buildCli(harness.ctx);
  const chunks: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);

  const prevExitCode = process.exitCode;
  try {
    await program.parseAsync(['node', 'exarchos', toolAlias, action, ...flags, '--json']);
  } finally {
    stdoutSpy.mockRestore();
    process.exitCode = prevExitCode;
  }

  const combined = chunks.join('');
  const firstBrace = combined.indexOf('{');
  if (firstBrace < 0) {
    throw new Error(`CLI produced no JSON output for ${toolAlias} ${action}: ${combined}`);
  }
  // Take the JSON line (the adapter writes a single line followed by \n).
  const newlineIdx = combined.indexOf('\n', firstBrace);
  const jsonText = newlineIdx > 0 ? combined.slice(firstBrace, newlineIdx) : combined.slice(firstBrace);
  return JSON.parse(jsonText) as ToolResult;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const STREAM_ID = 'parity-feature';

const APPEND_EVENT = {
  type: 'task.completed',
  data: { taskId: 'parity-task-1' },
} as const;

const BATCH_EVENTS = [
  { type: 'task.completed', data: { taskId: 'parity-task-a' } },
  { type: 'task.completed', data: { taskId: 'parity-task-b' } },
  { type: 'task.completed', data: { taskId: 'parity-task-c' } },
] as const;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DR-3: exarchos_event CLI/MCP parity', () => {
  let mcpHarness: ParityHarness;
  let cliHarness: ParityHarness;

  beforeEach(async () => {
    mcpHarness = await makeHarness('mcp');
    cliHarness = await makeHarness('cli');
  });

  afterEach(async () => {
    await teardownHarness(mcpHarness);
    await teardownHarness(cliHarness);
  });

  it('EventParity_Append_CliAndMcp_ReturnEqualPayload', async () => {
    // MCP side
    const mcpResult = await callMcp(
      'exarchos_event',
      'append',
      { stream: STREAM_ID, event: APPEND_EVENT },
      mcpHarness,
    );

    // CLI side — same canonical args, over commander
    const cliResult = await callCli(
      'ev',
      'append',
      ['--stream', STREAM_ID, '--event', JSON.stringify(APPEND_EVENT)],
      cliHarness,
    );

    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('EventParity_Query_CliAndMcp_ReturnEqualPayload', async () => {
    // Seed each side with a single append so query has deterministic content.
    await callMcp(
      'exarchos_event',
      'append',
      { stream: STREAM_ID, event: APPEND_EVENT },
      mcpHarness,
    );
    await callCli(
      'ev',
      'append',
      ['--stream', STREAM_ID, '--event', JSON.stringify(APPEND_EVENT)],
      cliHarness,
    );

    // Query both with the same small filter.
    const mcpResult = await callMcp(
      'exarchos_event',
      'query',
      { stream: STREAM_ID, filter: { type: 'task.completed' }, limit: 10 },
      mcpHarness,
    );

    const cliResult = await callCli(
      'ev',
      'query',
      [
        '--stream', STREAM_ID,
        '--filter', JSON.stringify({ type: 'task.completed' }),
        '--limit', '10',
      ],
      cliHarness,
    );

    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('EventParity_BatchAppend_CliAndMcp_ReturnEqualPayload', async () => {
    const mcpResult = await callMcp(
      'exarchos_event',
      'batch_append',
      { stream: STREAM_ID, events: BATCH_EVENTS },
      mcpHarness,
    );

    const cliResult = await callCli(
      'ev',
      'batch_append',
      ['--stream', STREAM_ID, '--events', JSON.stringify(BATCH_EVENTS)],
      cliHarness,
    );

    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
