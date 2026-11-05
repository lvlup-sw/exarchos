/**
 * Tests for contract drift under the verification profile. A segment runs the argv of each leg that the capsule pins.
 * A term with no contract tool gives an advisory skip that names `profile-unresolved` and its reason.
 *
 * Each case calls the handler with a stub git and a stub runner, so no command runs. The durable gate producer is a stub that calls only the provider.
 *
 * @oracle-sources: ../../../../src/verbs/gates/contract-drift-handler.ts, and the argv that reaches the injected runner
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import type { CommandRunFn } from '../../../../src/verbs/gates/contract-drift.js';
import { handleContractDrift } from '../../../../src/verbs/gates/contract-drift-handler.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { contractTerm, nodeTestProfile } from '../../../helpers/verification-profile.js';

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (_scope: unknown, executeProvider: () => Promise<ToolResult>) => executeProvider(),
}));

/** The version of the capsule of each pinned case. */
const VERSION = 6;

/** The legs of the pin. They name no command of the worktree config. */
const PINNED_LEGS = {
  codegen: ['sh', 'pinned/codegen.sh'],
  typecheck: ['sh', 'pinned/typecheck.sh'],
  diff: ['sh', 'pinned/diff.sh'],
};

const gitMergeBase: GitExec = (_repoRoot, args) =>
  args[0] === 'merge-base' ? { stdout: 'MB0\n', exitCode: 0 } : { stdout: '', exitCode: 0 };

/** A stub runner that gives exit 0 and records each argv that it gets. */
function recordingRunner(): { readonly runner: CommandRunFn; readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const runner: CommandRunFn = async ({ argv }) => {
    calls.push(argv);
    return { exitCode: 0, stdout: '' };
  };
  return { runner, calls };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'contract-drift-profile-'));
});

afterEach(() => {
  rmrf(tmpDir);
});

describe('handleContractDrift — the contract term of the profile', () => {
  /**
   * The worktree config names other commands, and the pin wins. The runner gets the pinned argv of each leg, in the order of the gate.
   * The killing assertion: the old handler reads the worktree config, so the runner gets its commands and no pinned argv.
   */
  it('ContractDrift_InASegment_RunsThePinnedContractCommands', async () => {
    writeFileSync(
      path.join(tmpDir, '.exarchos.yml'),
      ['contract:', '  codegen: sh worktree/codegen.sh', '  diff: sh worktree/diff.sh', 'typecheck: sh worktree/typecheck.sh', ''].join('\n'),
    );
    const { runner, calls } = recordingRunner();

    const result = await handleContractDrift(
      {
        featureId: 'feat-segment',
        taskId: 'T-1',
        baseBranch: 'main',
        repoRoot: tmpDir,
        gitExec: gitMergeBase,
        runCommand: runner,
        verificationProfile: {
          capsuleVersion: VERSION,
          profile: { ...nodeTestProfile(), contract: contractTerm(PINNED_LEGS) },
        },
      },
      tmpDir,
      new EventStore(tmpDir),
    );

    expect(calls).toEqual([PINNED_LEGS.codegen, PINNED_LEGS.typecheck, PINNED_LEGS.diff]);
    expect(result.data).toMatchObject({
      passed: true,
      drift: false,
      report: expect.stringContaining(`profile = pinned by capsule v${VERSION}`),
    });
    expect(result.data).not.toHaveProperty('skipped');
  });

  /**
   * A pinned term with no contract tool gives the advisory pass of today. The carrier now states the discriminant and a reason that names both legs.
   * The reason starts with the profile path and ends with the route under a pin. The runner gets no call.
   */
  it('ContractDrift_NoContractTool_SkipsWithProfileUnresolvedAndAReason', async () => {
    const { runner, calls } = recordingRunner();

    const result = await handleContractDrift(
      {
        featureId: 'feat-segment',
        taskId: 'T-1',
        baseBranch: 'main',
        repoRoot: tmpDir,
        gitExec: gitMergeBase,
        runCommand: runner,
        verificationProfile: { capsuleVersion: VERSION, profile: nodeTestProfile() },
      },
      tmpDir,
      new EventStore(tmpDir),
    );

    expect(calls).toEqual([]);
    expect(result.data).toMatchObject({
      passed: true,
      skipped: true,
      discriminant: 'profile-unresolved',
      reason: expect.stringMatching(/^pinned by capsule v6\. contract\.codegen: .* contract\.diff: /),
    });
    expect(result.data).toMatchObject({
      reason: expect.stringContaining(`A rerun under capsule v${VERSION} gives the same verdict.`),
    });
  });

  /** A direct call has no pin, so the term resolves at its root, and the reason names the root and a rerun. */
  it('ContractDrift_ADirectCallWithNoContractTool_NamesItsRootAndARerun', async () => {
    const { runner, calls } = recordingRunner();

    const result = await handleContractDrift(
      { featureId: 'feat-direct', taskId: 'T-1', baseBranch: 'main', repoRoot: tmpDir, gitExec: gitMergeBase, runCommand: runner },
      tmpDir,
      new EventStore(tmpDir),
    );

    expect(calls).toEqual([]);
    expect(result.data).toMatchObject({
      passed: true,
      skipped: true,
      discriminant: 'profile-unresolved',
      reason: expect.stringContaining(`resolved at ${tmpDir}. contract.codegen: `),
    });
    expect(result.data).toMatchObject({ reason: expect.stringContaining('Then run the gate again.') });
  });

  /** An unresolved typecheck skips that leg, as a null command did. The other legs run, and the gate does not skip. */
  it('ContractDrift_AnUnresolvedTypecheck_SkipsOnlyThatLeg', async () => {
    const { runner, calls } = recordingRunner();
    const contract = contractTerm({ codegen: PINNED_LEGS.codegen, diff: PINNED_LEGS.diff });

    const result = await handleContractDrift(
      {
        featureId: 'feat-segment',
        taskId: 'T-1',
        baseBranch: 'main',
        repoRoot: tmpDir,
        gitExec: gitMergeBase,
        runCommand: runner,
        verificationProfile: { capsuleVersion: VERSION, profile: { ...nodeTestProfile(), contract } },
      },
      tmpDir,
      new EventStore(tmpDir),
    );

    expect(calls).toEqual([PINNED_LEGS.codegen, PINNED_LEGS.diff]);
    expect(result.data).toMatchObject({ passed: true, drift: false });
    expect(result.data).not.toHaveProperty('skipped');
  });
});
