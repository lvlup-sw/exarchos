// ─── check_mock_boundary registration + dispatch + steer (task 026) ──────────
//
// Mirrors contract-drift-handler.test.ts: prove the action is registered with a
// non-throwing registration schema + outputSchema, and that dispatch through
// handleOrchestrate routes to the real handler (NOT an UNKNOWN_ACTION envelope).

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
    for (const a of arms.splice(0)) rmrf(a.stateDir);
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

  it('SteerForFinding_KnownDependency_ResolvesConcreteHermeticDouble', () => {
    // SIV-5 (#1531): axios classifies as third-party-http → a Pact-verified
    // contract stub. The steer names the dependency, its class, the CONCRETE
    // double, and the honesty caveat — not a generic menu.
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
    // The honesty caveat (shape-not-semantics) rides the resolved descriptor.
    expect(steer).toMatch(/shape, not provider semantics/i);
  });

  it('SteerForFinding_DatabaseDependency_ResolvesTestcontainers', () => {
    // pg classifies as database → Testcontainers (real, boundary-offline).
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
    // Container-backed ⇒ boundary/offline cadence, never the inner loop.
    expect(steer).toMatch(/boundary-offline/i);
  });

  it('SteerForFinding_CloudApiDependency_ResolvesLocalStackWithFakeCaveat', () => {
    // @aws-sdk/* classifies as cloud-api → LocalStack, flagged as a FAKE.
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

  it('SteerForFinding_UnclassifiedDependency_FallsBackToGenericMenu', () => {
    // An unrecognized dependency keeps the generic hermetic menu — the resolver
    // never guesses a concrete double (resolve, don't bake).
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
