/**
 * CLI↔MCP parity tests for the `check_invariant_conformance` action
 * (DR-3 / T-15, INV-2).
 *
 * `check_invariant_conformance` has two user-visible facades:
 *   1. MCP — `exarchos_orchestrate { action: 'check_invariant_conformance' }`
 *      over the MCP SDK.
 *   2. CLI — the auto-generated `exarchos orch check_invariant_conformance`
 *      surface, emitted from the action's Zod schema in registry.ts.
 *
 * Both facades dispatch through the same `exarchos_orchestrate` composite, so
 * for the same DispatchContext + args they MUST project byte-identical
 * `ToolResult` payloads (modulo wall-clock fields the envelope wrapper
 * injects). This is INV-2.
 *
 * Strategy (mirrors static-analysis.parity.test.ts):
 *   - Stub the `exarchos_orchestrate` composite via `stubCompositeHandler`. The
 *     stub forwards `check_invariant_conformance` invocations to the real
 *     `handleCheckInvariantConformance`, injecting a deterministic in-memory
 *     catalog via `loadInvariantsFn` so the gate never reads disk and two arms
 *     produce byte-equal output.
 *   - Two arms (CLI + MCP) run against isolated tmp state dirs; their outputs
 *     are normalized (timestamps / `_perf` / `_meta`) before a deep-equal check.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import type { InvariantEntry } from '../../../../src/architecture/invariants-loader.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../parity-harness.js';

import { handleCheckInvariantConformance } from '../../../../src/verbs/gates/check-invariant-conformance.js';
import { handleInit } from '../../../../src/workflow/handlers/init.js';
import { ADMISSION_EVENT_TYPES } from '../../../../src/workflow/admission/types.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PARITY_DIFF = [
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1 +1,2 @@',
  '+console.log("debug");',
].join('\n');

const PARITY_ARGS = {
  featureId: 'feat-invariant-conformance-parity',
  workflowType: 'feature',
  diffContent: PARITY_DIFF,
} as const;

/** Deterministic in-memory catalog: one blocking check-mode invariant. */
const PARITY_CATALOG: InvariantEntry[] = [
  {
    id: 'USER-1',
    dimension: 'Test',
    axis: 'substrate',
    costOfLoad: 'always-load',
    appliesTo: ['**'],
    summary: 'No stray console.log in committed source',
    references: [],
    raw: {},
    severity: { default: 'blocking' },
    enforcement: {
      mode: 'check',
      check: { kind: 'grep', pattern: 'console\\.log', fileGlob: '*.ts' },
    },
  },
];

// ─── Arm helpers ───────────────────────────────────────────────────────────

interface ArmContext {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

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
 * Admission fail-closes declared requires without a store-backed subject
 * and a passing review-floor record. Seed both so the stubbed handler is
 * what the parity arms compare, not the deny envelope.
 */
async function seedReviewFloor(arm: ArmContext, featureId: string): Promise<void> {
  const init = await handleInit(
    { featureId, workflowType: 'feature' },
    arm.stateDir,
    arm.ctx.eventStore,
  );
  if (!init.success) {
    throw new Error(init.error?.message ?? 'init failed');
  }
  const state = JSON.parse(
    await readFile(path.join(arm.stateDir, `${featureId}.state.json`), 'utf8'),
  ) as { phaseAttemptId?: unknown };
  const phaseAttemptId =
    typeof state.phaseAttemptId === 'string' ? state.phaseAttemptId : 'phase-attempt-parity';
  const digest = { algorithm: 'sha256' as const, value: 'a'.repeat(64) };
  await arm.ctx.eventStore.append(featureId, {
    type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
    source: 'test',
    data: {
      eventVersion: '1.0',
      evidence: {
        contractVersion: '1.0',
        evidenceId: `evidence-${featureId}`,
        requirementId: 'review',
        phaseAttemptId,
        subject: { kind: 'task', taskId: 'task-parity-001', digest },
        producer: {
          producerId: 'producer.gate-runner',
          providerRef: 'provider.review',
          providerVersion: '1.0.0',
          invocationId: `invocation-${featureId}`,
        },
        policyId: 'policy-parity-001',
        policyDigest: digest,
        contentDigest: digest,
        createdAt: new Date().toISOString(),
        kind: 'gate',
        verdict: 'pass',
      },
    },
  });
}

/**
 * Build a composite stub whose `check_invariant_conformance` action calls the
 * real handler with a deterministic injected catalog. Two arms against the
 * same stub project byte-equal output.
 */
function buildConformanceCompositeStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'check_invariant_conformance') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `invariant-conformance parity stub only handles "check_invariant_conformance", got "${String(action)}"`,
        },
      };
    }
    return handleCheckInvariantConformance(
      { ...(rest as Record<string, unknown>), loadInvariantsFn: () => PARITY_CATALOG },
      ctx.stateDir,
      ctx.eventStore,
    );
  };
}

/**
 * Strip wall-clock / telemetry fields. `_perf.ms` and `_meta.timestamp` are
 * stamped at envelope-wrap time and drift between arms even when the
 * underlying ToolResult is identical.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('exarchos check_invariant_conformance CLI↔MCP parity (DR-3/T-15, INV-2)', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rmrfAsync(arm.stateDir);
    }
    arms = [];
    vi.restoreAllMocks();
  });

  it('CheckInvariantConformance_CliVsMcp_IdenticalToolResult', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildConformanceCompositeStub(),
    );

    const cliArm = await createArm('inv-conformance-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('inv-conformance-parity-mcp-');
    arms.push(mcpArm);
    await seedReviewFloor(cliArm, PARITY_ARGS.featureId);
    await seedReviewFloor(mcpArm, PARITY_ARGS.featureId);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'check_invariant_conformance',
      PARITY_ARGS,
    );

    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'check_invariant_conformance',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliData = cliResult.data as { verdict: string; high: number };
    expect(cliData.verdict).toBe('NEEDS_FIXES');
    expect(cliData.high).toBeGreaterThanOrEqual(1);

    // INV-2: byte-equal ToolResult across carriers after stripping wall-clock.
    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));
  });
});
