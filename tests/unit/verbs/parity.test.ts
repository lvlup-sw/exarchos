/**
 * CLI-versus-MCP parity tests for a fast subset of `exarchos_orchestrate` actions.
 * Each test calls the action through the CLI and through MCP dispatch, each arm in its own temp state dir.
 * The test normalizes both payloads before it compares them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../src/format.js';
import { resetMaterializerCache } from '../../../src/projections/views/tools.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../parity-harness.js';

interface ArmContext {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

/**
 * Builds a DispatchContext on a fresh temp state dir and EventStore, with a seeded active phase attempt.
 * Each arm has its own context, so the side effects stay apart.
 */
async function createArm(prefix: string): Promise<ArmContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  await seedActivePhaseAttempt(eventStore, 'parity-feat');
  const ctx: DispatchContext = withTrustedCaller({
    stateDir,
    eventStore,
    enableTelemetry: false,
  });
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

import { UUID_ANY_RE } from '../parity-harness.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../tools/test-helpers/trusted-context.js';

/** Keys whose values the normalizer replaces with `<TIMESTAMP>`, whatever the value format. */
const TIMESTAMP_KEYS = new Set([
  'timestamp',
  'claimedAt',
  'completedAt',
  'createdAt',
  'updatedAt',
]);
const UUID_KEYS = new Set(['eventId', 'id']);

/**
 * Replaces timestamps, UUIDs, commit SHAs, and temp paths with placeholders. It drops `_perf`, `_meta`, and `evidenceReferences`.
 * Each arm has its own event store, so the content-addressed evidence ids differ. They are not part of the payload contract under comparison.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TIMESTAMP>',
    uuidPlaceholder: '<UUID>',
    shaPlaceholder: '<SHA>',
    tmpPathPlaceholder: '<TMP_PATH>',
    uuidRegex: UUID_ANY_RE,
    timestampKeys: TIMESTAMP_KEYS,
    uuidKeys: UUID_KEYS,
    dropKeys: new Set(['_perf', '_meta', 'evidenceReferences']),
  });
}

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

/**
 * `check_design_completeness` is a deprecated alias of `check_plan_coverage` on the unified spec.
 * A task covers each design section of this fixture, so the delegated run succeeds.
 */
const UNIFIED_SPEC = `${MINIMAL_DESIGN}
## Decomposition

### Task 001: Build the Widget Component
**Implements:** DR-1
Render the main UI.

### Task 002: Build the API Client
**Implements:** DR-2
Handle data fetching.
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

describe('exarchos_orchestrate CLI-vs-MCP parity', () => {
  let arms: ArmContext[] = [];

  beforeEach(() => {
    resetMaterializerCache();
  });

  afterEach(async () => {
    resetMaterializerCache();
    for (const arm of arms) {
      await rmrfAsync(arm.stateDir);
    }
    arms = [];
    vi.restoreAllMocks();
  });

  it('OrchestrateParity_CheckDesignCompleteness_CliAndMcp_ReturnEqualPayload', async () => {
    const cliArm = await createArm('parity-design-cli-');
    arms.push(cliArm);
    const cliDesign = path.join(cliArm.stateDir, 'design.md');
    await writeFile(cliDesign, UNIFIED_SPEC, 'utf-8');

    resetMaterializerCache();
    const cliResult = await callCli(cliArm.ctx, 'check_design_completeness', {
      featureId: 'parity-feat',
      designPath: cliDesign,
    });

    const mcpArm = await createArm('parity-design-mcp-');
    arms.push(mcpArm);
    const mcpDesign = path.join(mcpArm.stateDir, 'design.md');
    await writeFile(mcpDesign, UNIFIED_SPEC, 'utf-8');

    resetMaterializerCache();
    const mcpResult = await callMcp(mcpArm.ctx, 'check_design_completeness', {
      featureId: 'parity-feat',
      designPath: mcpDesign,
    });

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliResult.success).toBe(true);
  });

  it('OrchestrateParity_CheckPlanCoverage_CliAndMcp_ReturnEqualPayload', async () => {
    const cliArm = await createArm('parity-plan-cli-');
    arms.push(cliArm);
    const cliDesign = path.join(cliArm.stateDir, 'design.md');
    const cliPlan = path.join(cliArm.stateDir, 'plan.md');
    await writeFile(cliDesign, MINIMAL_DESIGN, 'utf-8');
    await writeFile(cliPlan, MINIMAL_PLAN, 'utf-8');

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

    resetMaterializerCache();
    const mcpResult = await callMcp(mcpArm.ctx, 'check_plan_coverage', {
      featureId: 'parity-feat',
      designPath: mcpDesign,
      planPath: mcpPlan,
    });

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliResult.success).toBe(true);
  });

  /** Each arm gets a `task.assigned` event, so the claim is legal. The seed uses the event store of the arm, because dispatch reads through that store. */
  it('OrchestrateParity_TaskClaim_CliAndMcp_ReturnEqualPayload', async () => {
    const streamId = 'parity-claim-wf';

    const cliArm = await createArm('parity-claim-cli-');
    arms.push(cliArm);
    await cliArm.ctx.eventStore.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't-parity-1', title: 'Parity claim', assignee: 'agent-parity' },
    });

    resetMaterializerCache();
    const cliResult = await callCli(cliArm.ctx, 'task_claim', {
      taskId: 't-parity-1',
      agentId: 'agent-parity',
      streamId,
    });

    const mcpArm = await createArm('parity-claim-mcp-');
    arms.push(mcpArm);
    await mcpArm.ctx.eventStore.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't-parity-1', title: 'Parity claim', assignee: 'agent-parity' },
    });

    resetMaterializerCache();
    const mcpResult = await callMcp(mcpArm.ctx, 'task_claim', {
      taskId: 't-parity-1',
      agentId: 'agent-parity',
      streamId,
    });

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliResult.success).toBe(true);
  });

  /**
   * Each arm gets `task.assigned`, `task.claimed`, and a passing `static-analysis` gate row, so `task_complete` is legal.
   * Caller evidence cannot satisfy a blocking gate, so the fixture seeds the gate row. The `evidence` argument stays because it records provenance.
   * The seed uses the event store of the arm, because dispatch reads through that store.
   */
  it('OrchestrateParity_TaskComplete_CliAndMcp_ReturnEqualPayload', async () => {
    const streamId = 'parity-complete-wf';

    const seedStream = async (store: EventStore) => {
      await store.append(streamId, {
        type: 'task.assigned',
        data: { taskId: 't-parity-2', title: 'Parity complete', assignee: 'agent-parity' },
      });
      await store.append(streamId, {
        type: 'task.claimed',
        data: { taskId: 't-parity-2', agentId: 'agent-parity', claimedAt: new Date().toISOString() },
        agentId: 'agent-parity',
      });
      await store.append(streamId, {
        type: 'gate.executed',
        data: {
          gateName: 'static-analysis',
          layer: 'quality',
          passed: true,
          details: { taskId: 't-parity-2' },
        },
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
    await seedStream(cliArm.ctx.eventStore);

    resetMaterializerCache();
    const cliResult = await callCli(cliArm.ctx, 'task_complete', completeArgs);

    const mcpArm = await createArm('parity-complete-mcp-');
    arms.push(mcpArm);
    await seedStream(mcpArm.ctx.eventStore);

    resetMaterializerCache();
    const mcpResult = await callMcp(mcpArm.ctx, 'task_complete', completeArgs);

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliResult.success).toBe(true);
  });

  /**
   * Both arms must return the same hints for a workflow in the `review` phase. Neither lists the auto-emitted `review.routed` as missing.
   * Two seed events put the stream in the `review` phase without the HSM guard.
   */
  it('OrchestrateParity_CheckEventEmissions_ReviewRoutedAuto_CliAndMcp_ReturnEqualPayload', async () => {
    const streamId = 'parity-emissions-review';

    const seedReviewPhase = async (
      store: ArmContext['ctx']['eventStore'],
    ): Promise<void> => {
      await store.append(streamId, {
        type: 'workflow.started',
        data: { featureId: streamId, workflowType: 'feature' },
      });
      await store.append(streamId, {
        type: 'workflow.transition',
        data: { from: '', to: 'review' },
      });
    };

    const cliArm = await createArm('parity-emissions-cli-');
    arms.push(cliArm);
    await seedReviewPhase(cliArm.ctx.eventStore);

    resetMaterializerCache();
    const cliResult = await callCli(cliArm.ctx, 'check_event_emissions', {
      featureId: streamId,
    });

    const mcpArm = await createArm('parity-emissions-mcp-');
    arms.push(mcpArm);
    await seedReviewPhase(mcpArm.ctx.eventStore);

    resetMaterializerCache();
    const mcpResult = await callMcp(mcpArm.ctx, 'check_event_emissions', {
      featureId: streamId,
    });

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliResult.success).toBe(true);

    const hintTypes = (r: ToolResult): string[] => {
      const data = (r as { data?: { hints?: Array<{ eventType: string }> } }).data;
      return (data?.hints ?? []).map((h) => h.eventType);
    };
    expect(hintTypes(cliResult)).not.toContain('review.routed');
    expect(hintTypes(mcpResult)).not.toContain('review.routed');
  });
});
