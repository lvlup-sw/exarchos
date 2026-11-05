/**
 * Tests for contract drift when the profile does not resolve the codegen leg or the diff leg.
 * The gate runs the leg that resolves and names each leg that it does not run, with the reason of its term.
 * A pass of such a run carries `profile-unresolved` and the reason, with no `skipped` field and no clean-pass steer.
 *
 * Each case uses a stub git and a stub runner, so no command runs. The durable gate producer is a stub that calls only the provider.
 * A direct call resolves the profile at a temporary root whose `.exarchos.yml` holds a `contract:` block.
 *
 * @oracle-sources: ../../../../src/verbs/gates/contract-drift-handler.ts, and the argv that reaches the injected runner
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { runContractDrift, type CommandRunFn } from '../../../../src/verbs/gates/contract-drift.js';
import { handleContractDrift, type ContractDriftHandlerArgs } from '../../../../src/verbs/gates/contract-drift-handler.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { contractTerm, nodeTestProfile } from '../../../helpers/verification-profile.js';

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (_scope: unknown, executeProvider: () => Promise<ToolResult>) => executeProvider(),
}));

/** The version of the capsule of each pinned case. */
const VERSION = 8;

/** The argv of the codegen leg of each case. */
const CODEGEN = ['sh', 'pinned/codegen.sh'];

/** A `contract:` block whose diff command does not split, because its quote does not close. Its codegen resolves. */
const UNSPLIT_DIFF_CONFIG = ['contract:', '  codegen: sh gen.sh', '  diff: oasdiff breaking "base.yaml', ''].join('\n');

/** A `contract:` block in which neither the codegen command nor the diff command splits. */
const UNSPLIT_LEGS_CONFIG = ['contract:', '  codegen: sh "gen.sh', '  diff: oasdiff breaking "base.yaml', ''].join('\n');

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

/** True for an object record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text of a carrier field. A field that is not a string fails the case. */
function textOf(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`the field is not a string: ${JSON.stringify(value)}`);
  return value;
}

/** The carrier of a gate call. */
function carrierOf(result: ToolResult): Readonly<Record<string, unknown>> {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!isRecord(result.data)) throw new Error(`the gate returned no carrier: ${JSON.stringify(result)}`);
  return result.data;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'contract-drift-one-leg-'));
});

afterEach(() => {
  rmrf(tmpDir);
});

/** One gate call at the temporary root, with a stub git and the given runner. A case adds its pin in `extra`. */
function callGate(runner: CommandRunFn, extra: Partial<ContractDriftHandlerArgs> = {}): Promise<ToolResult> {
  return handleContractDrift(
    { featureId: 'feat-one-leg', taskId: 'T-1', baseBranch: 'main', repoRoot: tmpDir, gitExec: gitMergeBase, runCommand: runner, ...extra },
    tmpDir,
    new EventStore(tmpDir),
  );
}

describe('runContractDrift — a codegen or diff leg that does not resolve', () => {
  /**
   * A resolved codegen and an unresolved diff. The gate runs the codegen leg only.
   * The killing assertion: the report holds `diff not run:`, and the result carries `profile-unresolved`. The old gate names neither.
   */
  it('ContractDrift_OneUnresolvedLeg_RunsTheOtherAndNamesTheLegThatDidNotRun', async () => {
    const { runner, calls } = recordingRunner();
    const contract = contractTerm({ codegen: CODEGEN });

    const result = await runContractDrift({ repoRoot: tmpDir, baseRef: 'main', contract, gitExec: gitMergeBase, runCommand: runner });

    expect(calls).toEqual([CODEGEN]);
    expect(result.passed).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.report).toContain('codegen ok');
    expect(result.report).toContain('diff not run: contract.diff: no contract command resolves.');
    expect(result.report).not.toContain('codegen not run:');
    expect(result.discriminant).toBe('profile-unresolved');
    expect(result.reason).toContain('contract.diff: ');
  });
});

describe('handleContractDrift — a codegen or diff leg that does not resolve', () => {
  /**
   * The same run through the handler, live at a root whose configured diff does not split, and pinned with an unresolved diff.
   * The killing assertion: the old handler adds the clean-pass steer to each pass that does not skip.
   */
  it('ContractDrift_OneUnresolvedLeg_GivesNoCleanPassSteer', async () => {
    writeFileSync(path.join(tmpDir, '.exarchos.yml'), UNSPLIT_DIFF_CONFIG);
    const live = recordingRunner();
    const pinned = recordingRunner();

    const liveCarrier = carrierOf(await callGate(live.runner));
    const pinnedCarrier = carrierOf(
      await callGate(pinned.runner, {
        verificationProfile: { capsuleVersion: VERSION, profile: { ...nodeTestProfile(), contract: contractTerm({ codegen: CODEGEN }) } },
      }),
    );

    expect(live.calls).toEqual([['sh', 'gen.sh']]);
    expect(pinned.calls).toEqual([CODEGEN]);
    for (const carrier of [liveCarrier, pinnedCarrier]) {
      expect(carrier).toMatchObject({ passed: true, drift: false, discriminant: 'profile-unresolved' });
      expect(carrier).not.toHaveProperty('skipped');
      expect(carrier).not.toHaveProperty('next_actions');
      expect(textOf(carrier.report)).toContain('diff not run: contract.diff: ');
    }
    expect(textOf(liveCarrier.reason).startsWith(`resolved at ${tmpDir}. contract.diff: `)).toBe(true);
    expect(textOf(pinnedCarrier.reason).startsWith(`pinned by capsule v${VERSION}. contract.diff: `)).toBe(true);
    expect(textOf(pinnedCarrier.reason)).toContain(`A rerun under capsule v${VERSION} gives the same verdict.`);
  });

  /**
   * A `contract:` block exists, and neither leg resolves. The skip names the reason of each leg.
   * The killing assertion: the old skip report says that no `contract:` block exists.
   */
  it('ContractDrift_TwoUnresolvedLegs_TheSkipReportDoesNotClaimAMissingBlock', async () => {
    writeFileSync(path.join(tmpDir, '.exarchos.yml'), UNSPLIT_LEGS_CONFIG);
    const { runner, calls } = recordingRunner();

    const carrier = carrierOf(await callGate(runner));

    expect(calls).toEqual([]);
    expect(carrier).toMatchObject({ passed: true, skipped: true, discriminant: 'profile-unresolved' });
    expect(textOf(carrier.report)).not.toContain('contract: block');
    expect(textOf(carrier.report)).toContain('codegen not run: contract.codegen: ');
    expect(textOf(carrier.report)).toContain('diff not run: contract.diff: ');
  });
});
