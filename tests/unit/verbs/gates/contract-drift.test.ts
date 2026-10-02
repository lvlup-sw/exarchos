import { describe, it, expect, vi } from 'vitest';
import {
  runContractDrift,
  type ContractDriftArgs,
  type ContractDriftResult,
  type CommandRunFn,
} from '../../../../src/verbs/gates/contract-drift.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';

/** A gitExec stub. It answers `merge-base` with a fixed sha and every other command with exit code 0. */
function gitExecWithMergeBase(mergeBaseSha: string, calls: string[][] = []): GitExec {
  return (_repoRoot, args) => {
    calls.push([...args]);
    if (args[0] === 'merge-base') {
      return { stdout: `${mergeBaseSha}\n`, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  };
}

/** A command runner stub. It picks the outcome of each leg from the command string. */
function makeRunCommand(
  outcomes: {
    codegen?: { exitCode: number; stdout?: string };
    typecheck?: { exitCode: number; stdout?: string };
    diff?: { exitCode: number; stdout?: string };
  },
  recorder?: string[],
): CommandRunFn {
  return async ({ command }) => {
    recorder?.push(command);
    if (command.includes('codegen')) {
      return { exitCode: outcomes.codegen?.exitCode ?? 0, stdout: outcomes.codegen?.stdout ?? '' };
    }
    if (command.includes('typecheck') || command.includes('tsc')) {
      return { exitCode: outcomes.typecheck?.exitCode ?? 0, stdout: outcomes.typecheck?.stdout ?? '' };
    }
    if (command.includes('diff')) {
      return { exitCode: outcomes.diff?.exitCode ?? 0, stdout: outcomes.diff?.stdout ?? '' };
    }
    return { exitCode: 0, stdout: '' };
  };
}

const BASE_ARGS = (
  over: Partial<ContractDriftArgs> = {},
): ContractDriftArgs => ({
  repoRoot: '/repo',
  baseRef: 'main',
  contract: { codegen: 'run codegen', diff: 'run diff' },
  typecheck: 'tsc --noEmit',
  gitExec: gitExecWithMergeBase('MERGEBASE0'),
  runCommand: makeRunCommand({}),
  ...over,
});

describe('runContractDrift', () => {
  /** The baseline comes from `git merge-base <baseRef> HEAD`, not from a raw `baseRef..HEAD` range. */
  it('ContractDrift_Baseline_IsMergeBase', async () => {
    const gitCalls: string[][] = [];
    const diffCalls: string[] = [];
    await runContractDrift(
      BASE_ARGS({
        gitExec: gitExecWithMergeBase('ABC123', gitCalls),
        runCommand: makeRunCommand({ diff: { exitCode: 0 } }, diffCalls),
      }),
    );
    const mergeBaseCall = gitCalls.find((c) => c[0] === 'merge-base');
    expect(mergeBaseCall).toBeDefined();
    expect(mergeBaseCall).toEqual(['merge-base', 'main', 'HEAD']);
  });

  /** A codegen failure is a failed leg, not a breaking finding. */
  it('ContractDrift_CodegenFails_ReportsFailureLeg', async () => {
    const result: ContractDriftResult = await runContractDrift(
      BASE_ARGS({
        runCommand: makeRunCommand({ codegen: { exitCode: 2, stdout: 'codegen boom' } }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.report).toMatch(/codegen/i);
    expect(result.breaking).toEqual([]);
  });

  it('ContractDrift_TypecheckFails_ReportsFailureLeg', async () => {
    const result = await runContractDrift(
      BASE_ARGS({
        runCommand: makeRunCommand({ typecheck: { exitCode: 1, stdout: 'TS2304' } }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.report).toMatch(/typecheck/i);
    expect(result.breaking).toEqual([]);
  });

  it('ContractDrift_BreakingDiff_PopulatesBreakingArray', async () => {
    const result = await runContractDrift(
      BASE_ARGS({
        runCommand: makeRunCommand({
          diff: { exitCode: 1, stdout: 'BREAKING: removed field foo\nBREAKING: changed type of bar' },
        }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.drift).toBe(true);
    expect(result.breaking.length).toBeGreaterThan(0);
    expect(result.breaking.join('\n')).toMatch(/removed field foo/);
  });

  /** With no contract tool, the gate skips as advisory and does not fail. */
  it('ContractDrift_NoToolResolves_SkippedAdvisory', async () => {
    const result = await runContractDrift(
      BASE_ARGS({ contract: null }),
    );
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.drift).toBeFalsy();
    expect(result.breaking).toEqual([]);
  });

  it('ContractDrift_CleanAllLegs_Passes_CarrierShape', async () => {
    const result = await runContractDrift(BASE_ARGS());
    expect(result).toMatchObject({
      passed: true,
      drift: false,
      breaking: [],
    });
    expect(typeof result.report).toBe('string');
  });

  /** A project can wire only the diff leg. The gate must still run it. */
  it('ContractDrift_DiffOnlyLeg_NoCodegen_StillRunsDiff', async () => {
    const diffCalls: string[] = [];
    const result = await runContractDrift(
      BASE_ARGS({
        contract: { codegen: null, diff: 'run diff' },
        runCommand: makeRunCommand({ diff: { exitCode: 0 } }, diffCalls),
      }),
    );
    expect(result.passed).toBe(true);
    expect(diffCalls.some((c) => c.includes('diff'))).toBe(true);
  });
});
