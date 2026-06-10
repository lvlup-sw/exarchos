// ─── check_mock_boundary registration + dispatch + steer (task 026) ──────────
//
// Mirrors contract-drift-handler.test.ts: prove the action is registered with a
// non-throwing registration schema + outputSchema, and that dispatch through
// handleOrchestrate routes to the real handler (NOT an UNKNOWN_ACTION envelope).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleOrchestrate } from './composite.js';
import { TOOL_REGISTRY } from '../registry.js';
import { steerForFinding } from './mock-boundary-handler.js';
import type { GitExec } from './pure/execute-merge.js';

// ─── seams ──────────────────────────────────────────────────────────────────

/**
 * A git seam that returns an empty diff for any `git diff …` call, so the
 * routing test exercises the dispatch arm without a real repo. An empty diff
 * means zero findings → a clean advisory pass.
 */
const gitEmptyDiff: GitExec = (_repoRoot, args) =>
  args[0] === 'diff' ? { stdout: '', exitCode: 0 } : { stdout: '', exitCode: 0 };

interface Arm {
  stateDir: string;
  ctx: DispatchContext;
}

async function makeArm(prefix: string): Promise<Arm> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, ctx: { stateDir, eventStore, enableTelemetry: false } as DispatchContext };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('check_mock_boundary registration + dispatch + steer', () => {
  const arms: Arm[] = [];
  afterEach(() => {
    for (const a of arms.splice(0)) rmSync(a.stateDir, { recursive: true, force: true });
  });

  it('CheckMockBoundary_Registration_DoesNotThrow', () => {
    // Building the registration schema must not throw at startup — a same-name
    // field with a different base type would make buildRegistrationSchema throw.
    const action = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!.actions.find(
      (a) => a.name === 'check_mock_boundary',
    );
    expect(action).toBeDefined();
    // The action declares a Zod outputSchema (envelope-wrapped).
    expect(action!.outputSchema).toBeDefined();
    // Advisory-by-default: registry gate.blocking is false (severity demotion
    // is resolved at runtime via DEFAULTS.review.gates, like tdd-compliance).
    expect(action!.gate?.blocking).toBe(false);
    expect(action!.gate?.dimension).toBe('D1');
  });

  it('HandleOrchestrate_CheckMockBoundary_RoutesToHandler', async () => {
    const arm = await makeArm('mock-boundary-route-');
    arms.push(arm);

    const result = await handleOrchestrate(
      {
        action: 'check_mock_boundary',
        featureId: 'feat-route',
        taskId: 'T-1',
        branch: 'feature/x',
        baseBranch: 'main',
        repoRoot: '/fake/repo',
        gitExec: gitEmptyDiff,
      } as unknown as Record<string, unknown>,
      arm.ctx,
    );

    // Routed to the real handler — NOT an UNKNOWN_ACTION envelope.
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; findings: unknown[] };
    expect(typeof data.passed).toBe('boolean');
    // Empty diff → no mock sites → clean pass with empty findings.
    expect(data.passed).toBe(true);
    expect(Array.isArray(data.findings)).toBe(true);
    expect(data.findings).toHaveLength(0);
  });

  it('SteerForFinding_NamesTheMockedTarget_AndPrescribesHermeticReplacement', () => {
    const steer = steerForFinding({
      file: 'src/foo.test.ts',
      line: 3,
      identifier: 'mock',
      mockedTarget: 'axios',
      unowned: true,
    });
    // INV-12: the steer must name the dependency AND prescribe the replacement.
    expect(steer).toContain('axios');
    expect(steer).toMatch(/replace the mock/i);
    expect(steer).toMatch(/hermetic fixture/i);
    expect(steer).toMatch(/contract-verified stub/i);
    expect(steer).toMatch(/fake/i);
  });
});
