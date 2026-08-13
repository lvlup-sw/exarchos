// ─── check_contract_drift registration + dispatch + steer (task 023) ──────────

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { handleOrchestrate } from '../composite.js';
import { TOOL_REGISTRY } from '../../registry.js';
import {
  handleContractDrift,
  ONE_SEMANTIC_TEST_STEER,
  type ContractDriftHandlerArgs,
} from './contract-drift-handler.js';
import type { GitExec } from '../pure/execute-merge.js';
import type { CommandRunFn } from './contract-drift.js';

vi.mock('./durable-gate-producer.js', () => ({
  runDurableGateProducer: (
    _scope: unknown,
    executeProvider: () => Promise<unknown>,
  ) => executeProvider(),
}));

// ─── seams ──────────────────────────────────────────────────────────────────

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

// ─── tests ───────────────────────────────────────────────────────────────────

describe('check_contract_drift registration + dispatch + steer', () => {
  const arms: Arm[] = [];
  afterEach(() => {
    for (const a of arms.splice(0)) rmrf(a.stateDir);
  });

  it('CheckContractDrift_Registration_DoesNotThrow', () => {
    // Building the registration schema must not throw at startup — a same-name
    // field with a different base type would make buildRegistrationSchema throw.
    const action = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')!.actions.find(
      (a) => a.name === 'check_contract_drift',
    );
    expect(action).toBeDefined();
    // The action declares a Zod outputSchema (envelope-wrapped).
    expect(action!.outputSchema).toBeDefined();
    // Importing registry.ts (which runs buildRegistrationSchema-adjacent
    // validation paths) did not throw — reaching here is the assertion.
  });

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
        // Test seams routed through the composite args bag.
        gitExec: gitMergeBase,
        runCommand: cmdRunner({ diff: { code: 0, out: 'no breaking changes' } }),
        // Force a resolvable contract via a literal repoRoot is hard in-unit;
        // the handler resolves commands from the repo. Use the no-tool path to
        // prove routing: an unrecognized repo resolves no contract → skipped.
      } as unknown as Record<string, unknown>,
      arm.ctx,
    );

    // Routed to the real handler — NOT an UNKNOWN_ACTION envelope.
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; skipped?: boolean };
    expect(typeof data.passed).toBe('boolean');
  });

  it('NextActions_OnPass_CarriesOneSemanticTestSteer', async () => {
    const arm = await makeArm('contract-steer-');
    arms.push(arm);

    // Drive the handler directly with seams that resolve a contract tool by
    // injecting runCommand, but the handler resolves `contract` from the repo —
    // so we exercise the steer via a stub repo that DOES resolve a contract.
    // Instead, assert the steer text contract is exactly the required copy and
    // that a clean PASS surfaces it.
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
    // Exact required copy.
    expect(ONE_SEMANTIC_TEST_STEER).toBe(
      'contracts verify shape, not meaning — keep exactly ONE semantic test for this boundary; delete redundant shape assertions',
    );
  });
});

// ─── helper: a temp repo wiring a resolvable contract via .exarchos.yml ───────

import { writeFileSync, mkdirSync } from 'node:fs';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const _repos: string[] = [];
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
