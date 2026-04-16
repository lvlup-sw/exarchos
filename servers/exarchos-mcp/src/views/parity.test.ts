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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import { CLI_EXIT_CODES } from '../adapters/cli.js';
import { TOOL_REGISTRY } from '../registry.js';
import { resetMaterializerCache } from './tools.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  UUID_ANY_RE,
} from '../__tests__/parity-harness.js';

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
  return harnessCallMcp(ctx, VIEW_TOOL, { action, ...args });
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
 * Run the CLI program in-process and parse the ToolResult from stdout.
 * Delegates to the shared harness; this wrapper only resolves the
 * `cli.alias` to the effective subcommand name Commander registered.
 */
async function callCli(
  action: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<{ result: ToolResult; exitCode: number }> {
  const cliAction = resolveCliActionName(action);
  return harnessCallCli(ctx, 'vw', cliAction, args);
}

// ─── Normalization ─────────────────────────────────────────────────────────

/**
 * Views suite normalizer. Historical placeholders are `<ISO>` for
 * timestamps and `<UUID>` (any version) for UUIDs, with `_perf` dropped.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<ISO>',
    uuidPlaceholder: '<UUID>',
    uuidRegex: UUID_ANY_RE,
    dropKeys: new Set(['_perf']),
  });
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
