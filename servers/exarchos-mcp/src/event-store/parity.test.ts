import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from './store.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../__tests__/parity-harness.js';

// ─── DR-3 Parity Tests: exarchos_event ──────────────────────────────────────
// Asserts that invoking `exarchos_event` actions through the CLI adapter and
// the MCP-style `dispatch()` entry point produces structurally equivalent
// ToolResult payloads. Differences that are expected (timestamps, UUIDs,
// sequence numbers) are normalized before comparison. Runs sibling to the
// task-014 (`exarchos_workflow`) parity suite.

// ─── Normalization Helpers ──────────────────────────────────────────────────

import { UUID_ANY_RE } from '../__tests__/parity-harness.js';

/**
 * Event-store suite normalizer. Historical behaviour dropped ISO
 * timestamps / UUIDs entirely (rather than replacing with placeholders)
 * and stripped the `_perf` telemetry block. Replicate via the shared
 * harness's `stripTimeSensitiveValues` + `dropKeys` options.
 *
 * Uses `UUID_ANY_RE` (not strictly v4) to match prior behaviour — the
 * event store mints non-v4 IDs in some code paths and this suite relied
 * on the broader regex.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    stripTimeSensitiveValues: true,
    dropKeys: new Set(['_perf']),
    uuidRegex: UUID_ANY_RE,
  });
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
  return harnessCallMcp(harness.ctx, tool, { action, ...args });
}

/**
 * Invoke a tool action through the CLI adapter. This suite historically
 * passed `ReadonlyArray<string>` flags (positional flag + value pairs) so
 * we translate into the harness's structured flag map here. Each flag
 * token that starts with `--` opens a new key; the following token is
 * its value unless it too begins with `--`.
 */
async function callCli(
  toolAlias: string,
  action: string,
  flags: ReadonlyArray<string>,
  harness: ParityHarness,
): Promise<ToolResult> {
  const structured: Record<string, unknown> = {};
  for (let i = 0; i < flags.length; i++) {
    const token = flags[i];
    if (!token.startsWith('--')) continue;
    // Drop the leading `--`, convert kebab-case back to camelCase so the
    // harness's own camelCase→kebab mapping is a no-op.
    const kebabKey = token.slice(2);
    const camelKey = kebabKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const next = flags[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      structured[camelKey] = next;
      i++;
    } else {
      structured[camelKey] = true;
    }
  }
  const { result } = await harnessCallCli(harness.ctx, toolAlias, action, structured);
  return result;
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
