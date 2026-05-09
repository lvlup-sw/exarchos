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

// ─── DR-3 Parity Tests: exarchos_event + DR-11 deprecation envelope parity ─
// Asserts that invoking `exarchos_event` actions through the CLI adapter and
// the MCP-style `dispatch()` entry point produces structurally equivalent
// ToolResult payloads. Differences that are expected (timestamps, UUIDs,
// sequence numbers) are normalized before comparison. Runs sibling to the
// task-014 (`exarchos_workflow`) parity suite.
//
// T53 / DR-11 also extends this file with a top-level
// `describe('DR-11 Parity: workflow.set({phase}) _meta.deprecation envelope', ...)`
// block that asserts byte-equivalence of the deprecation envelope across both
// carriers. The deprecated `workflow.set({phase})` invocation must produce a
// `_meta.deprecation` payload that round-trips identically through the CLI
// and MCP entry points; the JSON.stringify of the (normalized) envelope is
// the authoritative byte-equivalence assertion.

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

// ─── DR-11 / T53 — workflow.set({phase}) deprecation envelope parity ────────
//
// Plan goal (docs/plans/2026-05-08-durable-event-store-substrate.md §T53):
// "Parity test ensuring `_meta.deprecation` envelope is byte-equivalent
// across CLI and MCP carriers per output-contract registration."
//
// The deprecated `workflow.set({phase: 'plan'})` invocation must surface a
// `_meta.deprecation` payload of shape `{ since, removeIn, replacement }`
// (see workflow-set-deprecation.acceptance.test.ts for the canonical shape).
// Both the CLI carrier (`wf set --feature-id ... --phase plan`) and the MCP
// carrier (`exarchos_workflow.set` via dispatch) MUST emit a byte-identical
// envelope.
//
// File-location decision (recommended approach 1 from the dispatch prompt):
// extending the existing `parity.test.ts` keeps the parity-suite topology
// in one place and matches the plan's literal file reference. The new block
// is scoped under its own `describe` so the existing `exarchos_event` block
// keeps its semantic identity.
//
// Authoritative assertion: `JSON.stringify` of the normalized envelope on
// each arm. We additionally do a structural deep-equal as a more specific
// failure signal — if the strings differ, the deep-equal usually points at
// the diverging key.

describe('DR-11 Parity: workflow.set({phase}) _meta.deprecation envelope', () => {
  let mcpHarness: ParityHarness;
  let cliHarness: ParityHarness;

  beforeEach(async () => {
    mcpHarness = await makeHarness('depr-mcp');
    cliHarness = await makeHarness('depr-cli');
  });

  afterEach(async () => {
    await teardownHarness(mcpHarness);
    await teardownHarness(cliHarness);
  });

  /**
   * Prime a workflow into a state where `ideate → plan` is a valid
   * transition. The deprecated path goes through the canonical
   * `applyTransition` helper, which requires `artifacts.design` for a
   * feature workflow's first phase change. Without this priming the
   * underlying `set({phase})` would fail the HSM guard and we would
   * compare error envelopes rather than success-path deprecation
   * envelopes (defeating the purpose of the parity assertion).
   */
  async function primeForIdeateToPlan(
    harness: ParityHarness,
    featureId: string,
  ): Promise<void> {
    await harnessCallMcp(harness.ctx, 'exarchos_workflow', {
      action: 'init',
      featureId,
      workflowType: 'feature',
    });
    await harnessCallMcp(harness.ctx, 'exarchos_workflow', {
      action: 'set',
      featureId,
      updates: { 'artifacts.design': 'docs/design.md' },
    });
  }

  it('WorkflowSetDeprecationParity_MetaEnvelope_CliAndMcp_ByteEqual', async () => {
    const featureId = 'depr-parity-feature';

    // Arrange — prime each arm to the same starting state.
    await primeForIdeateToPlan(mcpHarness, featureId);
    await primeForIdeateToPlan(cliHarness, featureId);

    // Act — MCP carrier: `exarchos_workflow.set({phase: 'plan'})`.
    const mcpResult = await harnessCallMcp(
      mcpHarness.ctx,
      'exarchos_workflow',
      { action: 'set', featureId, phase: 'plan' },
    );

    // Act — CLI carrier: `wf set --feature-id ... --phase plan`.
    const { result: cliResult } = await harnessCallCli(
      cliHarness.ctx,
      'wf',
      'set',
      { featureId, phase: 'plan' },
    );

    // Sanity: both arms succeeded so we are comparing success-envelope
    // deprecation payloads, not error-path branches.
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);

    const mcpMeta = (mcpResult as { _meta?: Record<string, unknown> })._meta;
    const cliMeta = (cliResult as { _meta?: Record<string, unknown> })._meta;
    expect(mcpMeta?.deprecation).toBeDefined();
    expect(cliMeta?.deprecation).toBeDefined();

    // Sanity: matches the canonical shape pinned by the T35 acceptance test.
    expect(mcpMeta!.deprecation).toEqual({
      since: '2.10.0',
      removeIn: '2.11.0',
      replacement: 'transition',
    });

    // ─── Authoritative byte-equivalence assertion ─────────────────────────
    // The plan calls for "byte-identical" parity. We normalize each
    // envelope (no-op today — the deprecation sub-shape is timestamp/UUID-
    // free — but future-proof against accidental wall-clock-tagged fields)
    // and JSON.stringify the result. If a future change introduces a
    // time-sensitive field into the envelope, surfacing it here as a
    // parity diff is exactly the signal we want; if the envelope shape
    // legitimately needs such a field, the normalize() options can
    // absorb it without weakening this assertion.
    const mcpNormalized = normalize(mcpMeta!.deprecation);
    const cliNormalized = normalize(cliMeta!.deprecation);

    // Structural deep-equal first — if this fails, the failure message
    // points at the diverging key, which is more useful than a string
    // diff for debugging.
    expect(cliNormalized).toEqual(mcpNormalized);

    // Byte-identical stringification — the plan's authoritative parity
    // contract. Stable key order is given by the source object literal in
    // workflow/composite.ts; both arms route through the same code path,
    // so the stringification ordering is identical by construction. This
    // assertion guards against a future refactor that splits the carrier
    // paths and reintroduces serialization-order drift.
    expect(JSON.stringify(cliNormalized)).toBe(JSON.stringify(mcpNormalized));
  });
});
