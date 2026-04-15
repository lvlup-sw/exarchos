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
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import { resetMaterializerCache } from '../views/tools.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../__tests__/parity-harness.js';

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
 * Thin adapter over the shared harness `callCli`. This suite's call
 * sites pass `(ctx, action, flags)` without a `toolAlias` (always
 * `'orch'`), so fix the alias here and delegate the rest.
 */
async function callCli(
  ctx: DispatchContext,
  action: string,
  flags: Record<string, unknown>,
): Promise<ToolResult> {
  const { result } = await harnessCallCli(ctx, 'orch', action, flags);
  return result;
}

/** Invoke the orchestrate composite directly via the MCP dispatch entry point. */
async function callMcp(
  ctx: DispatchContext,
  action: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return harnessCallMcp(ctx, 'exarchos_orchestrate', { action, ...args });
}

// ─── Normalization ─────────────────────────────────────────────────────────

import { UUID_ANY_RE } from '../__tests__/parity-harness.js';

/**
 * Orchestrate suite normalizer. Historical placeholders:
 *   • ISO-8601 timestamps → `<TIMESTAMP>`
 *   • UUIDs (any version) → `<UUID>`
 *   • Commit SHAs → `<SHA>`
 *   • Tmp paths → `<TMP_PATH>`
 *   • `_perf` / `_meta` keys dropped
 *   • Keyed transforms: timestamp/UUID keys replaced even when the value
 *     isn't a matching ISO/UUID string (e.g. `claimedAt: Date` already
 *     serialized to string but still keyed explicitly).
 */
const TIMESTAMP_KEYS = new Set([
  'timestamp',
  'claimedAt',
  'completedAt',
  'createdAt',
  'updatedAt',
]);
const UUID_KEYS = new Set(['eventId', 'id']);

function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TIMESTAMP>',
    uuidPlaceholder: '<UUID>',
    shaPlaceholder: '<SHA>',
    tmpPathPlaceholder: '<TMP_PATH>',
    uuidRegex: UUID_ANY_RE,
    timestampKeys: TIMESTAMP_KEYS,
    uuidKeys: UUID_KEYS,
    dropKeys: new Set(['_perf', '_meta']),
  });
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
