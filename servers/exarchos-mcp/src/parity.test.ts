// ─── CLI/MCP Parity — v2.9.0 Bug Cluster (Commit C9, #1109) ───────────────
//
// Closes the second half of the #1109 verification checklist: identical
// event log → identical ToolResult envelope from CLI invocation and MCP
// invocation. The existing per-tool parity suites (`views/parity.test.ts`,
// `workflow/parity.test.ts`, `event-store/parity.test.ts`) cover empty
// or trivial state. The C9 tests here drive the assertion through the
// concrete bug-cluster shapes: a duplicate-task.completed event log for
// `workflow_status` (the C4 dedup target), and a no-handoff invocation
// of `workflow_checkpoint` (the C3 idempotency-key digest target).
//
// The shared parity-harness primitives (`callCli`, `callMcp`, `normalize`)
// from `src/__tests__/parity-harness.ts` are the same ones the older
// suites use — single source of truth for normalization (timestamps,
// UUIDs, `_perf` telemetry).
//
// Strategy:
//   - Per-test pair of tmp state dirs (CLI arm + MCP arm) so neither side
//     sees the other's state.
//   - Seed both arms with the SAME event log via direct `EventStore.append`
//     calls, then issue the same query through CLI and MCP adapters.
//   - Normalize and deep-equal the two ToolResult payloads.
//
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DispatchContext } from './core/dispatch.js';
import { EventStore } from './event-store/store.js';
import type { ToolResult } from './format.js';
import { CLI_EXIT_CODES } from './adapters/cli.js';
import { resetMaterializerCache } from './views/tools.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  UUID_ANY_RE,
} from './__tests__/parity-harness.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

interface ParityArm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function makeArm(label: string): Promise<ParityArm> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `c9-parity-${label}-`));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  return { stateDir, ctx };
}

async function teardownArm(arm: ParityArm): Promise<void> {
  await fs.rm(arm.stateDir, { recursive: true, force: true });
}

// ─── Normalization ─────────────────────────────────────────────────────────

/**
 * C9 normalizer — the views suite's defaults (`<ISO>` placeholder,
 * `<UUID>` placeholder, any-version UUID regex, `_perf` dropped) plus
 * the workflow-suite's `minutesSinceActivity` keyed transform so a
 * `workflow_status` envelope that includes that derived field renders
 * stably across arms.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<ISO>',
    uuidPlaceholder: '<UUID>',
    uuidRegex: UUID_ANY_RE,
    keyPlaceholders: { minutesSinceActivity: '<MINUTES>' },
    dropKeys: new Set(['_perf']),
  });
}

// ─── Test 9.2 — workflow_status parity under C4 dedup shape ────────────────

describe('CLI/MCP parity — workflow_status (C9, #1109)', () => {
  let cliArm: ParityArm;
  let mcpArm: ParityArm;

  beforeEach(async () => {
    // The view materializer caches projection state per-stream across
    // the in-process call; without a reset the second arm reuses the
    // first arm's cached state, contaminating the parity assertion.
    resetMaterializerCache();
    cliArm = await makeArm('status-cli');
    mcpArm = await makeArm('status-mcp');
  });

  afterEach(async () => {
    resetMaterializerCache();
    await teardownArm(cliArm);
    await teardownArm(mcpArm);
  });

  /**
   * Seed both arms with an identical event log that exercises the C4
   * dedup invariant (#1226): two `task.completed` events for the same
   * taskId. The post-C4 projection counts the duplicate once. CLI and
   * MCP must surface the same envelope.
   */
  async function seedDuplicateTaskCompleted(arm: ParityArm, featureId: string): Promise<void> {
    await arm.ctx.eventStore.append(featureId, {
      type: 'workflow.started',
      correlationId: featureId,
      data: { featureId, workflowType: 'feature' },
    });
    await arm.ctx.eventStore.append(featureId, {
      type: 'task.assigned',
      correlationId: featureId,
      data: { taskId: 't1' },
    });
    await arm.ctx.eventStore.append(featureId, {
      type: 'task.completed',
      correlationId: featureId,
      data: { taskId: 't1' },
    });
    // Duplicate — what the C4 dedup must collapse.
    await arm.ctx.eventStore.append(
      featureId,
      {
        type: 'task.completed',
        correlationId: featureId,
        data: { taskId: 't1' },
      },
      // Distinct idempotencyKey so the AtomicAppender admits it; the
      // dedup that matters here is the projection's, not the appender's.
      { idempotencyKey: `${featureId}:dup-completed` },
    );
  }

  it('assertParity_workflowStatus_cliAndMcpByteEqual', async () => {
    const featureId = 'c9-parity-status';

    // Arrange — seed both arms with identical event logs.
    await seedDuplicateTaskCompleted(cliArm, featureId);
    await seedDuplicateTaskCompleted(mcpArm, featureId);

    // Act — issue the same `workflow_status` query through both adapters.
    const mcpResult: ToolResult = await harnessCallMcp(
      mcpArm.ctx,
      'exarchos_view',
      { action: 'workflow_status', workflowId: featureId },
    );

    const { result: cliResult, exitCode } = await harnessCallCli(
      cliArm.ctx,
      'vw',
      'workflow_status',
      { workflowId: featureId },
    );

    // Assert — both arms succeed with byte-equal payloads after
    // normalization. The C4 dedup invariant means tasksCompleted in
    // both envelopes equals 1, not 2.
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});

// ─── Test 9.3 — workflow_checkpoint parity (no-handoff, stable digest) ─────

describe('CLI/MCP parity — workflow_checkpoint (C9, #1109)', () => {
  let cliArm: ParityArm;
  let mcpArm: ParityArm;

  beforeEach(async () => {
    resetMaterializerCache();
    cliArm = await makeArm('checkpoint-cli');
    mcpArm = await makeArm('checkpoint-mcp');
  });

  afterEach(async () => {
    resetMaterializerCache();
    await teardownArm(cliArm);
    await teardownArm(mcpArm);
  });

  /**
   * Initialize a workflow on the given arm so `handleCheckpoint` has
   * persisted state to read. Both arms see the same init payload, so
   * the resulting state file is identical modulo wall-clock timestamps
   * (which the parity normalizer strips).
   */
  async function initWorkflow(arm: ParityArm, featureId: string): Promise<void> {
    await harnessCallMcp(arm.ctx, 'exarchos_workflow', {
      action: 'init',
      featureId,
      workflowType: 'feature',
    });
  }

  it('assertParity_workflowCheckpoint_cliAndMcpByteEqual', async () => {
    const featureId = 'c9-parity-checkpoint';

    // Arrange — both arms initialized to the same starting state.
    await initWorkflow(cliArm, featureId);
    await initWorkflow(mcpArm, featureId);

    // Act — issue a no-handoff checkpoint through both adapters. With
    // no `handoff` payload, C3's sha256(handoff ?? {}) digest is
    // identical between the two calls, so the idempotencyKey is too.
    // (A handoff-bearing call would still parity, but the digest path
    // is best exercised by the deterministic empty-payload shape.)
    const mcpResult: ToolResult = await harnessCallMcp(
      mcpArm.ctx,
      'exarchos_workflow',
      { action: 'checkpoint', featureId, summary: 'C9 parity checkpoint' },
    );

    const { result: cliResult, exitCode } = await harnessCallCli(
      cliArm.ctx,
      'wf',
      'checkpoint',
      { featureId, summary: 'C9 parity checkpoint' },
    );

    // Assert — exit-code success on the CLI arm, both envelopes equal
    // after normalization. The interesting normalization here is around
    // the wall-clock timestamps `handleCheckpoint` writes into the
    // `_checkpoint` block; the harness's `stripTimeSensitiveValues`-
    // equivalent ISO regex collapses them to `<ISO>` on both sides.
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
