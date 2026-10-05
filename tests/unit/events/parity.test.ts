// Parity tests for `exarchos_event`: the CLI adapter and the MCP-style `dispatch()` entry point
// must give structurally equal `ToolResult` payloads for each action. The suite removes the
// expected differences, which are timestamps and UUIDs, before it compares.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../../src/events/store.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../src/format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../parity-harness.js';

import { UUID_ANY_RE } from '../parity-harness.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The normalizer of this suite. It drops ISO timestamps and UUIDs, with no placeholder, and it
 * drops the `_perf` telemetry block.
 * It uses `UUID_ANY_RE` and not a strict v4 pattern, because the event store mints some ids that
 * are not v4.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    stripTimeSensitiveValues: true,
    dropKeys: new Set(['_perf']),
    uuidRegex: UUID_ANY_RE,
  });
}

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
  await rmrfAsync(harness.stateDir);
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
 * Invokes a tool action through the CLI adapter. The suite passes flags as a string array, and
 * this function builds the structured flag map of the harness from it.
 * A token that starts with `--` opens a key. The next token is its value, unless that token also
 * starts with `--`. A key with no value is `true`.
 * The key changes from kebab-case to camelCase, so the harness maps it back to the same flag.
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
    const mcpResult = await callMcp(
      'exarchos_event',
      'append',
      { stream: STREAM_ID, event: APPEND_EVENT },
      mcpHarness,
    );

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

  /** Each side gets one append first, so the query has deterministic content. */
  it('EventParity_Query_CliAndMcp_ReturnEqualPayload', async () => {
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
