// ─── CLI-vs-MCP Parity Tests for exarchos_orchestrate ──────────────────────
//
// Implements DR-3 (CLI output parity with MCP) for a fast subset of orchestrate
// actions: check_design_completeness, check_plan_coverage, task_claim, task_complete.
//
// For each action, we invoke the handler twice:
//   • CLI arm — via `buildCli(ctx).parseAsync([...])`, capturing JSON stdout.
//   • MCP arm — via direct `dispatch('exarchos_orchestrate', ...)`.
//
// Both arms use isolated tmp state dirs (so side effects don't collide).
// Payloads are normalized (timestamps/UUIDs stripped) before deep-equal.
// ───────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import { buildCli } from '../adapters/cli.js';
import { resetMaterializerCache } from '../views/tools.js';

// ─── Shared Helpers ────────────────────────────────────────────────────────

interface ArmContext {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

/**
 * Build an isolated DispatchContext backed by a fresh tmp state dir + EventStore.
 * Each arm of a parity test gets its own arm so side effects don't cross-contaminate.
 */
async function createArm(prefix: string): Promise<ArmContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = {
    stateDir,
    eventStore,
    enableTelemetry: false,
  };
  return { stateDir, ctx };
}

/**
 * Invoke the orchestrate composite via the CLI adapter in-process.
 * Captures JSON stdout (emitted when `--json` is passed) and parses it into a ToolResult.
 *
 * `flags` are camelCase keys matching the action schema; they are converted to
 * kebab-case `--long-flags` here to match Commander's flag registration.
 */
async function callCli(
  ctx: DispatchContext,
  action: string,
  flags: Record<string, unknown>,
): Promise<ToolResult> {
  const program = buildCli(ctx);

  const argv: string[] = ['node', 'exarchos', 'orch', action];
  for (const [key, value] of Object.entries(flags)) {
    const kebab = key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    if (typeof value === 'boolean') {
      argv.push(value ? `--${kebab}` : `--no-${kebab}`);
    } else if (typeof value === 'object' && value !== null) {
      // Object/record/array flags are passed as JSON strings per coerceFlags().
      argv.push(`--${kebab}`, JSON.stringify(value));
    } else {
      argv.push(`--${kebab}`, String(value));
    }
  }
  argv.push('--json');

  const writes: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });

  try {
    await program.parseAsync(argv);
  } finally {
    stdoutSpy.mockRestore();
  }

  const body = writes.join('');
  // Extract the last complete JSON object in stdout (the CLI writes exactly
  // one JSON payload + trailing newline when --json is set). Using `.trim()`
  // then parsing is enough; tests fail loudly if something else leaked.
  const json = body.trim();
  if (!json) {
    throw new Error(`CLI emitted no stdout for action '${action}'. argv=${argv.join(' ')}`);
  }
  return JSON.parse(json) as ToolResult;
}

/** Invoke the orchestrate composite directly via the MCP dispatch entry point. */
async function callMcp(
  ctx: DispatchContext,
  action: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return dispatch('exarchos_orchestrate', { action, ...args }, ctx);
}

// ─── Normalization ─────────────────────────────────────────────────────────

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const TIMESTAMP_KEYS = new Set(['timestamp', 'claimedAt', 'completedAt', 'createdAt', 'updatedAt']);
const UUID_KEYS = new Set(['eventId', 'id']);

// Scrub tmp paths embedded in error/finding strings (e.g. mkdtemp output like
// "/tmp/parity-design-mcp-qZUrby/parity-feat.json"). The mkdtemp suffix is
// non-deterministic; if two arms' state dirs leak into the payload, the
// parity comparison would falsely diverge even though semantics match.
const TMP_PATH_RE = /\/(?:tmp|var\/folders\/[^/\s"']+)\/[A-Za-z0-9_.\-/]*/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip non-deterministic fields from a payload so two runs across different
 * tmp dirs can be deep-equal. Removes:
 *   • ISO-8601 timestamps (keyed or value-detected)
 *   • UUIDs (keyed or value-detected)
 *   • git commit SHAs (value-detected, len 7–40 hex)
 *   • `_perf` and `_meta` metadata
 *   • absolute tmp paths (they embed the random mkdtemp suffix)
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '_perf' || k === '_meta') continue;
      if (TIMESTAMP_KEYS.has(k)) {
        out[k] = '<TIMESTAMP>';
        continue;
      }
      if (UUID_KEYS.has(k)) {
        out[k] = '<UUID>';
        continue;
      }
      out[k] = normalize(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP_RE.test(value)) return '<TIMESTAMP>';
    if (UUID_RE.test(value)) return '<UUID>';
    if (COMMIT_SHA_RE.test(value) && value.length >= 7) return '<SHA>';
    // Replace any embedded tmp path occurrences with a stable placeholder.
    if (TMP_PATH_RE.test(value)) {
      return value.replace(TMP_PATH_RE, '<TMP_PATH>');
    }
  }
  return value;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const MINIMAL_DESIGN = `# Widget System — Design

## Problem Statement
We need a widget system for rendering user-facing UI primitives.

## Requirements
- DR-1: Render widgets
- DR-2: Fetch widget data

## Chosen Approach
Component-based architecture.

## Technical Design
### Widget Component
Renders the main UI.
### API Client
Handles data fetching.

## Integration Points
- Design system tokens
- API gateway

## Testing Strategy
Unit tests for all components.

## Open Questions
- None blocking.
`;

const MINIMAL_PLAN = `# Implementation Plan

## Technical Design
### Widget Component
### API Client

## Tasks
### Task 001: Create Widget Component
Build the widget rendering layer.
Design section: Widget Component

### Task 002: Create API Client
Build the API integration.
Design section: API Client
`;

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('exarchos_orchestrate CLI-vs-MCP parity', () => {
  let arms: ArmContext[] = [];

  beforeEach(() => {
    resetMaterializerCache();
  });

  afterEach(async () => {
    resetMaterializerCache();
    for (const arm of arms) {
      await rm(arm.stateDir, { recursive: true, force: true });
    }
    arms = [];
    vi.restoreAllMocks();
  });

  it('OrchestrateParity_CheckDesignCompleteness_CliAndMcp_ReturnEqualPayload', async () => {
    // Arrange — two isolated arms, each with its own copy of the design fixture.
    const cliArm = await createArm('parity-design-cli-');
    arms.push(cliArm);
    const cliDesign = path.join(cliArm.stateDir, 'design.md');
    await writeFile(cliDesign, MINIMAL_DESIGN, 'utf-8');

    // Act (CLI)
    resetMaterializerCache();
    const cliResult = await callCli(cliArm.ctx, 'check_design_completeness', {
      featureId: 'parity-feat',
      designPath: cliDesign,
    });

    const mcpArm = await createArm('parity-design-mcp-');
    arms.push(mcpArm);
    const mcpDesign = path.join(mcpArm.stateDir, 'design.md');
    await writeFile(mcpDesign, MINIMAL_DESIGN, 'utf-8');

    // Act (MCP)
    resetMaterializerCache();
    const mcpResult = await callMcp(mcpArm.ctx, 'check_design_completeness', {
      featureId: 'parity-feat',
      designPath: mcpDesign,
    });

    // Assert — payloads equal modulo timestamps/UUIDs/perf
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliResult.success).toBe(true);
  });

  it('OrchestrateParity_CheckPlanCoverage_CliAndMcp_ReturnEqualPayload', async () => {
    // Arrange — two isolated arms, each with design + plan fixtures.
    const cliArm = await createArm('parity-plan-cli-');
    arms.push(cliArm);
    const cliDesign = path.join(cliArm.stateDir, 'design.md');
    const cliPlan = path.join(cliArm.stateDir, 'plan.md');
    await writeFile(cliDesign, MINIMAL_DESIGN, 'utf-8');
    await writeFile(cliPlan, MINIMAL_PLAN, 'utf-8');

    // Act (CLI)
    resetMaterializerCache();
    const cliResult = await callCli(cliArm.ctx, 'check_plan_coverage', {
      featureId: 'parity-feat',
      designPath: cliDesign,
      planPath: cliPlan,
    });

    const mcpArm = await createArm('parity-plan-mcp-');
    arms.push(mcpArm);
    const mcpDesign = path.join(mcpArm.stateDir, 'design.md');
    const mcpPlan = path.join(mcpArm.stateDir, 'plan.md');
    await writeFile(mcpDesign, MINIMAL_DESIGN, 'utf-8');
    await writeFile(mcpPlan, MINIMAL_PLAN, 'utf-8');

    // Act (MCP)
    resetMaterializerCache();
    const mcpResult = await callMcp(mcpArm.ctx, 'check_plan_coverage', {
      featureId: 'parity-feat',
      designPath: mcpDesign,
      planPath: mcpPlan,
    });

    // Assert — payloads equal modulo timestamps/UUIDs/perf
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliResult.success).toBe(true);
  });

  it('OrchestrateParity_TaskClaim_CliAndMcp_ReturnEqualPayload', async () => {
    // Arrange — seed task.assigned events in each arm so the claim is legal.
    const streamId = 'parity-claim-wf';

    const cliArm = await createArm('parity-claim-cli-');
    arms.push(cliArm);
    const cliStore = new EventStore(cliArm.stateDir);
    await cliStore.initialize();
    await cliStore.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't-parity-1', title: 'Parity claim', assignee: 'agent-parity' },
    });

    // Act (CLI)
    resetMaterializerCache();
    const cliResult = await callCli(cliArm.ctx, 'task_claim', {
      taskId: 't-parity-1',
      agentId: 'agent-parity',
      streamId,
    });

    const mcpArm = await createArm('parity-claim-mcp-');
    arms.push(mcpArm);
    const mcpStore = new EventStore(mcpArm.stateDir);
    await mcpStore.initialize();
    await mcpStore.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't-parity-1', title: 'Parity claim', assignee: 'agent-parity' },
    });

    // Act (MCP)
    resetMaterializerCache();
    const mcpResult = await callMcp(mcpArm.ctx, 'task_claim', {
      taskId: 't-parity-1',
      agentId: 'agent-parity',
      streamId,
    });

    // Assert
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliResult.success).toBe(true);
  });

  it('OrchestrateParity_TaskComplete_CliAndMcp_ReturnEqualPayload', async () => {
    // Arrange — seed each arm with task.assigned + task.claimed so `task_complete`
    // is legal. We supply `evidence.type: 'manual'` + `passed: true` so the gate
    // bypass triggers and we don't need to seed tdd/static-analysis gate events.
    const streamId = 'parity-complete-wf';

    const seedStream = async (stateDir: string) => {
      const store = new EventStore(stateDir);
      await store.initialize();
      await store.append(streamId, {
        type: 'task.assigned',
        data: { taskId: 't-parity-2', title: 'Parity complete', assignee: 'agent-parity' },
      });
      await store.append(streamId, {
        type: 'task.claimed',
        data: { taskId: 't-parity-2', agentId: 'agent-parity', claimedAt: new Date().toISOString() },
        agentId: 'agent-parity',
      });
    };

    const completeArgs = {
      taskId: 't-parity-2',
      streamId,
      result: { files: ['src/foo.ts'], duration: 42 },
      evidence: {
        type: 'manual' as const,
        output: 'docs-only parity fixture — bypass gates',
        passed: true,
      },
    };

    const cliArm = await createArm('parity-complete-cli-');
    arms.push(cliArm);
    await seedStream(cliArm.stateDir);

    // Act (CLI)
    resetMaterializerCache();
    const cliResult = await callCli(cliArm.ctx, 'task_complete', completeArgs);

    const mcpArm = await createArm('parity-complete-mcp-');
    arms.push(mcpArm);
    await seedStream(mcpArm.stateDir);

    // Act (MCP)
    resetMaterializerCache();
    const mcpResult = await callMcp(mcpArm.ctx, 'task_complete', completeArgs);

    // Assert
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliResult.success).toBe(true);
  });
});
