// ─── CLI-vs-MCP Parity Tests for exarchos_view (DR-3) ──────────────────────
//
// Sibling of tasks 014 (workflow), 015 (event), 016 (orchestrate). Exercises
// a fast subset of view actions through both adapters and asserts the
// payloads match after normalization.
//
// Strategy:
//   - Per-test tmp stateDir (isolated).
//   - Shared DispatchContext/EventStore between both calls so both adapters
//     observe the same materialized state.
//   - MCP path: call dispatch() directly (what adapters/mcp.ts does under
//     the hood after arg validation).
//   - CLI path: build the Commander program with buildCli(ctx), run with
//     --json, capture stdout, parse the ToolResult. Exit-code must be
//     CLI_EXIT_CODES.SUCCESS (0) for a success-parity assertion.
//   - Normalize: strip timing-dependent `_perf` and any ISO timestamps /
//     UUIDs recursively before deep-equality.
//
// Notes on state:
//   Views read materialized state. For an empty stateDir both adapters
//   return empty projections; that's still a valid payload-shape parity
//   check (see issue #1082 — this test only asserts shape equivalence,
//   not non-emptiness).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { EventStore } from '../event-store/store.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import { buildCli, CLI_EXIT_CODES } from '../adapters/cli.js';
import { TOOL_REGISTRY } from '../registry.js';
import { resetMaterializerCache } from './tools.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const VIEW_TOOL = 'exarchos_view';

interface RunArtifacts {
  tmpDir: string;
  ctx: DispatchContext;
}

async function setupCtx(): Promise<RunArtifacts> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-parity-'));
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  const ctx: DispatchContext = {
    stateDir: tmpDir,
    eventStore,
    enableTelemetry: false,
  };
  return { tmpDir, ctx };
}

async function cleanupCtx(artifacts: RunArtifacts): Promise<void> {
  await fs.rm(artifacts.tmpDir, { recursive: true, force: true });
}

// ─── Adapter call helpers ──────────────────────────────────────────────────

/** Call the MCP transport-agnostic dispatch directly. */
async function callMcp(
  action: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  return dispatch(VIEW_TOOL, { action, ...args }, ctx);
}

/**
 * Resolve the CLI subcommand name for a view action.
 *
 * Commander is built from the registry with `action.cli?.alias ?? action.name`,
 * so e.g. `pipeline` → `ls`. Resolve from the registry to avoid hardcoding.
 */
function resolveCliActionName(action: string): string {
  const tool = TOOL_REGISTRY.find((t) => t.name === VIEW_TOOL);
  if (!tool) throw new Error(`Tool ${VIEW_TOOL} missing from registry`);
  const def = tool.actions.find((a) => a.name === action);
  if (!def) throw new Error(`Action ${action} missing on ${VIEW_TOOL}`);
  return def.cli?.alias ?? def.name;
}

/**
 * Build CLI command-line args for a view action.
 *
 * The CLI tree strips the `exarchos_` prefix and uses `cli.alias` when
 * present. For exarchos_view the tool alias is `vw`. Flags are kebab-cased.
 */
function buildCliArgv(action: string, args: Record<string, unknown>): string[] {
  const cliAction = resolveCliActionName(action);
  const argv: string[] = ['node', 'exarchos', 'vw', cliAction, '--json'];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const flag = '--' + k.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase());
    if (typeof v === 'boolean') {
      argv.push(v ? flag : `--no-${flag.slice(2)}`);
    } else {
      argv.push(flag, String(v));
    }
  }
  return argv;
}

/** Run the CLI program in-process and parse the ToolResult from stdout. */
async function callCli(
  action: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<{ result: ToolResult; exitCode: number }> {
  const program = buildCli(ctx);

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(
    ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as typeof process.stdout.write,
  );

  try {
    await program.parseAsync(buildCliArgv(action, args));
  } finally {
    stdoutSpy.mockRestore();
  }

  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = previousExitCode;

  const stdoutText = chunks.join('').trim();
  if (stdoutText.length === 0) {
    throw new Error(`CLI produced no stdout for action=${action}`);
  }
  const parsed = JSON.parse(stdoutText) as ToolResult;
  return { result: parsed, exitCode };
}

// ─── Normalization ─────────────────────────────────────────────────────────

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strip timing-dependent fields, ISO timestamps, and UUIDs recursively. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '_perf') continue; // timing-dependent, scrub
      out[k] = normalize(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP_RE.test(value)) return '<ISO>';
    if (UUID_RE.test(value)) return '<UUID>';
  }
  return value;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('exarchos_view CLI/MCP payload parity (DR-3)', () => {
  let artifacts: RunArtifacts;

  beforeEach(async () => {
    // Singleton materializer cache must be cleared between tests so each
    // per-test tmpDir gets a fresh projection state.
    resetMaterializerCache();
    artifacts = await setupCtx();
  });

  afterEach(async () => {
    resetMaterializerCache();
    await cleanupCtx(artifacts);
  });

  it('ViewParity_Pipeline_CliAndMcp_ReturnEqualPayload', async () => {
    // Arrange
    const args = { limit: 10, offset: 0 };

    // Act — both adapters, same context
    const mcpResult = await callMcp('pipeline', args, artifacts.ctx);
    const { result: cliResult, exitCode } = await callCli('pipeline', args, artifacts.ctx);

    // Assert — exit code maps to success, payloads match after normalization
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('ViewParity_WorkflowStatus_CliAndMcp_ReturnEqualPayload', async () => {
    // Arrange — workflow_status takes an optional workflowId; empty state
    // dir returns the default projection. That's fine for parity.
    const args = { workflowId: 'parity-test-feature' };

    // Act
    const mcpResult = await callMcp('workflow_status', args, artifacts.ctx);
    const { result: cliResult, exitCode } = await callCli('workflow_status', args, artifacts.ctx);

    // Assert
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('ViewParity_Tasks_CliAndMcp_ReturnEqualPayload', async () => {
    // Arrange — tasks view with a filter and pagination to exercise
    // argument coercion through the CLI schema-to-flags layer.
    const args = { workflowId: 'parity-test-feature', limit: 5, offset: 0 };

    // Act
    const mcpResult = await callMcp('tasks', args, artifacts.ctx);
    const { result: cliResult, exitCode } = await callCli('tasks', args, artifacts.ctx);

    // Assert
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
