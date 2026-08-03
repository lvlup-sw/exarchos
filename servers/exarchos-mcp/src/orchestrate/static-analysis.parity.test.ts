/**
 * CLI↔MCP parity tests for the `check_static_analysis` action (#1330, INV-2).
 *
 * `check_static_analysis` has two user-visible facades:
 *   1. MCP — `exarchos_orchestrate { action: 'check_static_analysis' }` over the
 *      MCP SDK.
 *   2. CLI — the auto-generated `exarchos orch check_static_analysis` surface,
 *      emitted from the action's Zod schema in registry.ts.
 *
 * Both facades dispatch through the same `exarchos_orchestrate` composite, so
 * for a given `repoRoot` they MUST project byte-identical `ToolResult` payloads
 * (modulo wall-clock fields the envelope wrapper injects). This is INV-2 for the
 * gate input the #1330 worktree-aware change threads (T-04/T-05): whatever
 * `repoRoot` the task-completion runbook supplies, the gate must behave the same
 * regardless of whether it was invoked over the CLI or the MCP carrier.
 *
 * Strategy (mirrors merge-orchestrate.parity.test.ts):
 *   - Stub the `exarchos_orchestrate` composite via `stubCompositeHandler`. The
 *     stub forwards `check_static_analysis` invocations to the real
 *     `handleStaticAnalysis`. The pure `runStaticAnalysis` module is mocked at
 *     the file level so the gate never actually shells out to `tsc`/`eslint` —
 *     the deterministic result lets two arms produce byte-equal output.
 *   - Two arms (CLI + MCP) run against isolated tmp state dirs; their outputs are
 *     normalized (timestamps / `_perf` / `_meta`) before a deep-equal check.
 *   - Two cases — pass and fail — exercise both branches across both surfaces.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Mock the pure static-analysis module so the gate is deterministic and never
// shells out. The mock is keyed off `repoRoot` so a future arg-threading
// regression (one carrier dropping repoRoot) would surface as a parity diff.
const mockRunStaticAnalysis = vi.fn();
vi.mock('./pure/static-analysis.js', () => ({
  runStaticAnalysis: (...args: unknown[]) => mockRunStaticAnalysis(...args),
}));

import { EventStore } from '../event-store/store.js';
import type { DispatchContext, CompositeHandler } from '../core/dispatch.js';
import { stubCompositeHandler } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../__tests__/parity-harness.js';

import { handleStaticAnalysis } from './static-analysis.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../test-helpers/trusted-context.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PARITY_REPO_ROOT = '/fake/agent/worktree';

const PARITY_ARGS = {
  featureId: 'feat-static-analysis-parity',
  repoRoot: PARITY_REPO_ROOT,
} as const;

function makePassingResult() {
  return {
    status: 'pass' as const,
    output: [
      '## Static Analysis Report',
      '',
      `**Repository:** \`${PARITY_REPO_ROOT}\``,
      '',
      '- **PASS**: Lint',
      '- **PASS**: Typecheck',
      '',
      '---',
      '',
      '**Result: PASS** (2/2 checks passed)',
    ].join('\n'),
    passCount: 2,
    failCount: 0,
  };
}

function makeFailingResult() {
  return {
    status: 'fail' as const,
    output: [
      '## Static Analysis Report',
      '',
      `**Repository:** \`${PARITY_REPO_ROOT}\``,
      '',
      '- **PASS**: Lint',
      '- **FAIL**: Typecheck — npm run typecheck failed',
      '',
      '---',
      '',
      '**Result: FAIL** (1/2 checks failed)',
    ].join('\n'),
    passCount: 1,
    failCount: 1,
  };
}

// ─── Arm helpers ───────────────────────────────────────────────────────────

interface ArmContext {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function createArm(prefix: string): Promise<ArmContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  await seedActivePhaseAttempt(eventStore, 'feat-static-analysis-parity');
  const ctx: DispatchContext = withTrustedCaller({
    stateDir,
    eventStore,
    enableTelemetry: false,
  });
  return { stateDir, ctx };
}

/**
 * Build a composite stub whose `check_static_analysis` action calls the real
 * `handleStaticAnalysis`. The mocked pure module makes the underlying gate
 * deterministic, so two arms against the same stub project byte-equal output.
 */
function buildStaticAnalysisCompositeStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'check_static_analysis') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `static-analysis parity stub only handles "check_static_analysis", got "${String(action)}"`,
        },
      };
    }
    return handleStaticAnalysis(
      rest as Parameters<typeof handleStaticAnalysis>[0],
      ctx.stateDir,
      ctx.eventStore,
    );
  };
}

/**
 * Strip wall-clock / telemetry fields. `_perf.ms` and `_meta.timestamp` are
 * stamped at envelope-wrap time and drift between arms even when the underlying
 * ToolResult is identical.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
    // videnceReferences carries the durable evidence identity the canonical
    // gate runner minted for THIS arm. Each arm owns a separate state dir and
    // event store, so the content-addressed evidenceId necessarily differs —
    // it is arm-local provenance, not part of the CLI/MCP payload contract
    // under comparison. Evidence PERSISTENCE is proven by the gate integration
    // suites, which assert the reference and its digest directly.
    dropKeys: new Set(['_perf', '_meta', 'evidenceReferences']),
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('exarchos check_static_analysis CLI↔MCP parity (#1330, INV-2)', () => {
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
    mockRunStaticAnalysis.mockReset();
  });

  it('StaticAnalysis_CliVsMcp_IdenticalResultForSameRepoRoot', async () => {
    // ─── Pass path ─────────────────────────────────────────────────────────
    mockRunStaticAnalysis.mockReturnValue(makePassingResult());
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildStaticAnalysisCompositeStub(),
    );

    const cliArm = await createArm('static-analysis-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('static-analysis-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'check_static_analysis',
      PARITY_ARGS,
    );

    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'check_static_analysis',
      ...PARITY_ARGS,
    });

    // Both surfaces report success with the same repoRoot threaded through.
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliData = cliResult.data as { passed: boolean; passCount: number; report: string };
    expect(cliData.passed).toBe(true);
    expect(cliData.passCount).toBe(2);
    expect(cliData.report).toContain(PARITY_REPO_ROOT);

    // INV-2: byte-equal ToolResult across carriers after stripping wall-clock.
    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

    // The same repoRoot reached the pure gate on both arms.
    for (const call of mockRunStaticAnalysis.mock.calls) {
      const callArgs = call[0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(PARITY_REPO_ROOT);
    }

    // ─── Fail path ─────────────────────────────────────────────────────────
    mockRunStaticAnalysis.mockReturnValue(makeFailingResult());

    const cliFailArm = await createArm('static-analysis-parity-cli-fail-');
    arms.push(cliFailArm);
    const mcpFailArm = await createArm('static-analysis-parity-mcp-fail-');
    arms.push(mcpFailArm);

    const { result: cliFail } = await harnessCallCli(
      cliFailArm.ctx,
      'orch',
      'check_static_analysis',
      PARITY_ARGS,
    );
    const mcpFail = await harnessCallMcp(mcpFailArm.ctx, 'exarchos_orchestrate', {
      action: 'check_static_analysis',
      ...PARITY_ARGS,
    });

    // A failing gate is still a successful tool call (the handler reports
    // passed:false in data, not a tool-level error) — that mapping must match.
    expect(cliFail.success).toBe(true);
    expect(mcpFail.success).toBe(true);
    const cliFailData = cliFail.data as { passed: boolean; failCount: number };
    expect(cliFailData.passed).toBe(false);
    expect(cliFailData.failCount).toBe(1);

    expect(normalize(cliFail)).toEqual(normalize(mcpFail));
    expect(JSON.stringify(normalize(cliFail))).toEqual(
      JSON.stringify(normalize(mcpFail)),
    );
  });
});
