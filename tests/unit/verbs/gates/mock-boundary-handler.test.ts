// Registration, dispatch and steer text for `check_mock_boundary`. The action
// declares a registration schema and an `outputSchema`, and `handleOrchestrate`
// routes it to the real handler.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import { steerForFinding } from '../../../../src/verbs/gates/mock-boundary-handler.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (
    _scope: unknown,
    executeProvider: () => Promise<unknown>,
  ) => executeProvider(),
}));

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

describe('check_mock_boundary registration + dispatch + steer', () => {
  const arms: Arm[] = [];
  afterEach(() => {
    for (const a of arms.splice(0)) rmrf(a.stateDir);
  });

  /**
   * The registry entry exists, declares an `outputSchema`, and marks the gate
   * advisory. A same-name field with a different base type makes
   * `buildRegistrationSchema` throw.
   */
  it('CheckMockBoundary_Registration_DoesNotThrow', () => {
    const action = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!.actions.find(
      (a) => a.name === 'check_mock_boundary',
    );
    expect(action).toBeDefined();
    expect(action!.outputSchema).toBeDefined();
    expect(action!.gate?.blocking).toBe(false);
    expect(action!.gate?.dimension).toBe('D1');
  });

  /**
   * An empty diff has no mock sites, so the real handler returns a clean pass.
   * An `UNKNOWN_ACTION` envelope fails the test.
   */
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

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; findings: unknown[] };
    expect(typeof data.passed).toBe('boolean');
    expect(data.passed).toBe(true);
    expect(Array.isArray(data.findings)).toBe(true);
    expect(data.findings).toHaveLength(0);
  });

  /**
   * axios classifies as third-party-http. The steer names the dependency, its
   * class, the concrete double and the shape-not-semantics caveat.
   */
  it('SteerForFinding_KnownDependency_ResolvesConcreteHermeticDouble', () => {
    const steer = steerForFinding({
      file: 'src/foo.test.ts',
      line: 3,
      identifier: 'mock',
      mockedTarget: 'axios',
      unowned: true,
    });
    expect(steer).toContain('axios');
    expect(steer).toMatch(/replace the mock/i);
    expect(steer).toMatch(/third-party-http/i);
    expect(steer).toMatch(/Pact-verified contract stub/i);
    expect(steer).toMatch(/shape, not provider semantics/i);
  });

  /** pg classifies as database, so the steer names Testcontainers at the boundary-offline cadence. */
  it('SteerForFinding_DatabaseDependency_ResolvesTestcontainers', () => {
    const steer = steerForFinding({
      file: 'src/db.test.ts',
      line: 5,
      identifier: 'mock',
      mockedTarget: 'pg',
      unowned: true,
    });
    expect(steer).toContain('pg');
    expect(steer).toMatch(/database/i);
    expect(steer).toMatch(/Testcontainers/i);
    expect(steer).toMatch(/boundary-offline/i);
  });

  /** An `@aws-sdk` client classifies as cloud-api, so the steer names LocalStack and flags it as a fake. */
  it('SteerForFinding_CloudApiDependency_ResolvesLocalStackWithFakeCaveat', () => {
    const steer = steerForFinding({
      file: 'src/s3.test.ts',
      line: 9,
      identifier: 'mock',
      mockedTarget: '@aws-sdk/client-s3',
      unowned: true,
    });
    expect(steer).toMatch(/cloud-api/i);
    expect(steer).toMatch(/LocalStack/i);
    expect(steer).toMatch(/FAKE of the cloud/i);
  });

  /** An unknown dependency keeps the generic hermetic menu. The resolver never guesses a concrete double. */
  it('SteerForFinding_UnclassifiedDependency_FallsBackToGenericMenu', () => {
    const steer = steerForFinding({
      file: 'src/foo.test.ts',
      line: 3,
      identifier: 'mock',
      mockedTarget: 'some-obscure-pkg',
      unowned: true,
    });
    expect(steer).toContain('some-obscure-pkg');
    expect(steer).toMatch(/hermetic fixture/i);
    expect(steer).toMatch(/contract-verified stub/i);
    expect(steer).toMatch(/a fake/i);
  });
});
