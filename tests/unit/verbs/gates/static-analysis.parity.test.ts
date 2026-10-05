/**
 * These tests check CLI and MCP parity for `check_static_analysis`. The MCP
 * call and the generated `exarchos orch check_static_analysis` command dispatch
 * through the same composite. For one `repoRoot`, they must return the same
 * `ToolResult`, except for wall-clock fields.
 *
 * The composite stub forwards the action to the real `handleStaticAnalysis`. A
 * mock of `runStaticAnalysis` keeps the gate deterministic and stops `tsc` and
 * `eslint` from running.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * The test reads the `repoRoot` of each call to this mock, so a surface that
 * drops `repoRoot` fails the test.
 */
const mockRunStaticAnalysis = vi.fn();
vi.mock('../../../../src/verbs/pure/static-analysis.js', () => ({
  runStaticAnalysis: (...args: unknown[]) => mockRunStaticAnalysis(...args),
}));

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../parity-harness.js';

import { handleStaticAnalysis } from '../../../../src/verbs/gates/static-analysis.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';

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
    skipCount: 0,
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
    skipCount: 0,
  };
}

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
 * Drops `_perf`, `_meta` and `evidenceReferences`. The envelope stamps
 * `_perf.ms` and `_meta.timestamp` on each call. Each arm has its own event
 * store, so the gate runner mints a different evidence id in each. The gate
 * integration suites test evidence persistence.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
    dropKeys: new Set(['_perf', '_meta', 'evidenceReferences']),
  });
}

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

  /**
   * Runs a pass path, then a fail path, and checks that both surfaces send the
   * same `repoRoot` to the gate. A failing gate is still a successful tool call
   * with `passed: false` in `data`.
   */
  it('StaticAnalysis_CliVsMcp_IdenticalResultForSameRepoRoot', async () => {
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

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliData = cliResult.data as { passed: boolean; passCount: number; report: string };
    expect(cliData.passed).toBe(true);
    expect(cliData.passCount).toBe(2);
    expect(cliData.report).toContain(PARITY_REPO_ROOT);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

    for (const call of mockRunStaticAnalysis.mock.calls) {
      const callArgs = call[0] as { repoRoot: string };
      expect(callArgs.repoRoot).toBe(PARITY_REPO_ROOT);
    }

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
