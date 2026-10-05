/** Tests for the `check_contract_drift` registration, its dispatch route, and the steer on a pass. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import {
  handleContractDrift,
  ONE_SEMANTIC_TEST_STEER,
  type ContractDriftHandlerArgs,
} from '../../../../src/verbs/gates/contract-drift-handler.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import type { CommandRunFn } from '../../../../src/verbs/gates/contract-drift.js';

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (
    _scope: unknown,
    executeProvider: () => Promise<unknown>,
  ) => executeProvider(),
}));

const gitMergeBase: GitExec = (_repoRoot, args) =>
  args[0] === 'merge-base' ? { stdout: 'MB0\n', exitCode: 0 } : { stdout: '', exitCode: 0 };

function cmdRunner(
  outcomes: { codegen?: number; typecheck?: number; diff?: { code: number; out: string } } = {},
): CommandRunFn {
  return async ({ command }) => {
    if (command.includes('codegen')) return { exitCode: outcomes.codegen ?? 0, stdout: '' };
    if (command.includes('diff')) {
      return { exitCode: outcomes.diff?.code ?? 0, stdout: outcomes.diff?.out ?? '' };
    }
    return { exitCode: outcomes.typecheck ?? 0, stdout: '' };
  };
}

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

describe('check_contract_drift registration + dispatch + steer', () => {
  const arms: Arm[] = [];
  afterEach(() => {
    for (const a of arms.splice(0)) rmrf(a.stateDir);
  });

  /**
   * `buildRegistrationSchema` throws when a same-name field has a different base type.
   * When the import of `registry.ts` throws, the test fails before it reaches an assertion.
   */
  it('CheckContractDrift_Registration_DoesNotThrow', () => {
    const action = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!.actions.find(
      (a) => a.name === 'check_contract_drift',
    );
    expect(action).toBeDefined();
    expect(action!.outputSchema).toBeDefined();
  });

  /**
   * `/fake/repo` resolves no contract.
   * A success result shows that the composite routes the action to the handler and does not return UNKNOWN_ACTION.
   */
  it('HandleOrchestrate_CheckContractDrift_RoutesToHandler', async () => {
    const arm = await makeArm('contract-route-');
    arms.push(arm);

    const result = await handleOrchestrate(
      {
        action: 'check_contract_drift',
        featureId: 'feat-route',
        taskId: 'T-1',
        branch: 'feature/x',
        baseBranch: 'main',
        repoRoot: '/fake/repo',
        gitExec: gitMergeBase,
        runCommand: cmdRunner({ diff: { code: 0, out: 'no breaking changes' } }),
      } as unknown as Record<string, unknown>,
      arm.ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; skipped?: boolean };
    expect(typeof data.passed).toBe('boolean');
  });

  /** `contractRepo()` writes an `.exarchos.yml` that resolves a contract, so a clean pass carries the steer. */
  it('NextActions_OnPass_CarriesOneSemanticTestSteer', async () => {
    const arm = await makeArm('contract-steer-');
    arms.push(arm);

    const args: ContractDriftHandlerArgs = {
      featureId: 'feat-steer',
      taskId: 'T-1',
      branch: 'feature/x',
      baseBranch: 'main',
      repoRoot: contractRepo(),
      gitExec: gitMergeBase,
      runCommand: cmdRunner({ diff: { code: 0, out: 'no breaking changes' } }),
    };
    const result = await handleContractDrift(args, arm.ctx.stateDir, arm.ctx.eventStore);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; next_actions?: string[] };
    expect(data.passed).toBe(true);
    expect(data.next_actions).toBeDefined();
    expect(data.next_actions).toContain(ONE_SEMANTIC_TEST_STEER);
    expect(ONE_SEMANTIC_TEST_STEER).toBe(
      'contracts verify shape, not meaning — keep exactly ONE semantic test for this boundary; delete redundant shape assertions',
    );
  });
});

import { writeFileSync, mkdirSync } from 'node:fs';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const _repos: string[] = [];
/** Creates a temporary repo whose `.exarchos.yml` resolves a contract to stub scripts. */
function contractRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'contract-repo-'));
  _repos.push(dir);
  mkdirSync(path.join(dir, 'stubs'), { recursive: true });
  writeFileSync(path.join(dir, 'stubs', 'codegen.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(dir, 'stubs', 'diff.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(
    path.join(dir, '.exarchos.yml'),
    ['contract:', '  codegen: sh stubs/codegen.sh', '  diff: sh stubs/diff.sh', "typecheck: 'true'", ''].join('\n'),
  );
  return dir;
}

afterEach(() => {
  for (const d of _repos.splice(0)) rmrf(d);
});
