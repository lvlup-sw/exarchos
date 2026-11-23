/**
 * Tests for the boundary legs under the verification profile. A segment runs the boundary checks that the capsule pins, with the `firstParty` term of the pin.
 * The worktree config gives only a load failure. A check of the pin cannot turn off through a change in the worktree.
 *
 * The handler cases run each approved leg through a fake executor, and each fixture root holds an installed bin, so the real lookup finds it.
 * The cases of the adapters inject the runner and the bin lookup. The durable gate producer is a stub that calls only the provider.
 *
 * @oracle-sources: ../../../../src/verbs/gates/static-analysis.ts, and the argv that reaches the process call
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { planBoundaryCheck, positiveCount, runBoundaryLint, runRawIoTaint } from '../../../../src/config/boundary-adapters.js';
import { runStaticAnalysis } from '../../../../src/verbs/pure/static-analysis.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { handleStaticAnalysis } from '../../../../src/verbs/gates/static-analysis.js';
import type { CommandResult, RunCommandFn } from '../../../../src/verbs/pure/static-analysis.js';
import type { VerificationProfile } from '../../../../src/workflow/verification/profile.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import {
  boundaryProfile,
  cruiserCheck,
  taintCheck,
  UNRESOLVED_FIRST_PARTY_REASON,
} from '../../../helpers/verification-profile.js';
import { fakeExecutor } from '../../../helpers/verification/check-executor.js';

/** Each argv that reaches the process call, and the report that the stub cruiser prints. A case can change the report. */
const spawns = vi.hoisted(() => {
  const ran: (readonly string[])[] = [];
  return { ran, cruiserReport: '', produced: 0 };
});


vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (_scope: unknown, executeProvider: () => Promise<ToolResult>) => { spawns.produced++; return executeProvider(); },
}));

/** The version of the capsule of each pinned case. */
const VERSION = 5;

/** The JSON report of a scan with no violation. */
const CLEAN_REPORT = JSON.stringify({ summary: { error: 0, totalCruised: 2, violations: [] } });

/** The file name of the installed bin on this platform. */
const BIN_NAME = process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise';

/** A boundary config that the stub runner never reads. */
const CRUISER_CONFIG = 'module.exports = { forbidden: [] };\n';

let tmpDir: string;

/** Makes a fixture root that holds `files` and the installed bin. A name with a directory makes that directory. */
function fixtureRoot(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(tmpDir, 'worktree-'));
  for (const [name, text] of Object.entries({ ...files, [`node_modules/.bin/${BIN_NAME}`]: '' })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text, 'utf-8');
  }
  return root;
}

/** The runner of the fake executor. It records each argv, and the cruiser prints the report of the case. */
const processRunner: RunCommandFn = (cmd, args) => {
  spawns.ran.push([cmd, ...args]);
  return { exitCode: 0, stdout: cmd.includes('depcruise') ? spawns.cruiserReport : '', stderr: '' };
};

/** The argv of each call of the installed bin. */
function cruiserCalls(): (readonly string[])[] {
  return spawns.ran.filter(([cmd]) => cmd?.includes('depcruise'));
}

/** Runs the handler at `repoRoot` with no pin. */
async function runDirect(repoRoot: string): Promise<ToolResult> {
  return handleStaticAnalysis({ featureId: 'feat-direct', repoRoot }, tmpDir, new EventStore(tmpDir), fakeExecutor(processRunner).executor);
}

/** Runs the handler at `repoRoot` under `profile`, as a segment does. */
async function runPinned(repoRoot: string, profile: VerificationProfile): Promise<ToolResult> {
  return handleStaticAnalysis(
    { featureId: 'feat-segment', repoRoot, verificationProfile: { capsuleVersion: VERSION, profile } },
    tmpDir,
    new EventStore(tmpDir),
    fakeExecutor(processRunner).executor,
  );
}

/** The report of a gate result. */
function reportOf(result: ToolResult): string {
  const data: unknown = result.data;
  return typeof data === 'object' && data !== null && 'report' in data && typeof data.report === 'string' ? data.report : '';
}

/** The report line of one leg, by the label of its adapter. */
function legLine(result: ToolResult, label: string): string | undefined {
  return reportOf(result)
    .split('\n')
    .find((line) => line.includes(label));
}

/** A stub runner that gives `result` and records each call. */
function stubRunner(result: CommandResult): { readonly runner: RunCommandFn; readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    runner: (cmd, args) => {
      calls.push([cmd, ...args]);
      return result;
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-profile-'));
  spawns.ran.splice(0);
  spawns.produced = 0;
  spawns.cruiserReport = CLEAN_REPORT;
});

afterEach(() => {
  rmrf(tmpDir);
});

describe('handleStaticAnalysis — the boundary terms of the pin', () => {
  /**
   * The worktree config names `src/**`, and the pin names `lib/**`. The scope comes from the pin, so a task cannot narrow what scans it.
   * The killing assertion: the old gate reads the scope of the worktree config and scans `src`.
   */
  it('StaticAnalysis_InASegment_UsesThePinnedFirstPartyGlobs', async () => {
    const worktree = fixtureRoot({
      '.dependency-cruiser.cjs': CRUISER_CONFIG,
      '.exarchos.yml': 'ownership:\n  firstParty:\n    - src/**\n',
      'src/a.ts': '',
      'lib/b.ts': '',
    });
    const firstParty: VerificationProfile['firstParty'] = { state: 'resolved', globs: ['lib/**'], source: 'config' };

    const result = await runPinned(worktree, boundaryProfile([cruiserCheck()], firstParty));

    expect(cruiserCalls()).toHaveLength(1);
    expect(cruiserCalls()[0]?.at(-1)).toBe('lib');
    expect(cruiserCalls()[0]).not.toContain('src');
    expect(result.data).toMatchObject({ passed: true, verdict: 'pass' });
  });

  /**
   * The worktree breaks its `.exarchos.yml`. Only the worktree read can find that, so a segment keeps the read for this failure.
   * The `dependency-cruiser` leg fails and names the file and the load fault. The line of the taint leg does not name the fault.
   * The old gate also reads the worktree config, so this case is a twin.
   * It fails when a change drops the read in a segment, or gives the error to the taint leg.
   */
  it('StaticAnalysis_InASegment_AWorktreeConfigThatDoesNotLoad_FailsTheBoundaryLeg', async () => {
    const worktree = fixtureRoot({
      '.dependency-cruiser.cjs': CRUISER_CONFIG,
      '.semgrep/no-raw-io-into-core.yml': 'rules: []\n',
      '.exarchos.yml': 'not_a_known_key: true\n',
      'src/a.ts': '',
    });

    const result = await runPinned(worktree, boundaryProfile([cruiserCheck(), taintCheck()]));

    expect(result.data).toMatchObject({ passed: false, verdict: 'fail' });
    const cruiserLine = legLine(result, 'Import boundaries');
    expect(cruiserLine).toContain(`**FAIL**`);
    expect(cruiserLine).toContain(path.join(worktree, '.exarchos.yml'));
    expect(cruiserLine).toContain('does not load');
    expect(cruiserCalls()).toEqual([]);
    const taintLine = legLine(result, 'Boundary IO taint');
    expect(taintLine).toBeDefined();
    expect(taintLine).not.toContain('does not load');
    expect(taintLine).not.toContain('.exarchos.yml');
  });

  /**
   * The pin names the check, and the worktree deleted its config. The pin wins, so the leg fails and the scan does not run.
   * The killing assertion: the old gate finds no config, reads the leg as not configured, and passes.
   */
  it('StaticAnalysis_AWorktreeThatDeletesThePinnedCruiserConfig_FailsTheLeg', async () => {
    const worktree = fixtureRoot({ 'src/a.ts': '' });

    const result = await runPinned(worktree, boundaryProfile([cruiserCheck()]));

    expect(result.data).toMatchObject({ passed: false, verdict: 'fail', failCount: 1 });
    const cruiserLine = legLine(result, 'Import boundaries');
    expect(cruiserLine).toContain('**FAIL**');
    expect(cruiserLine).toContain('.dependency-cruiser.cjs');
    expect(cruiserCalls()).toEqual([]);
  });

  /** The same rule holds for a pinned taint ruleset: a deleted ruleset fails the leg, and the engine does not run. */
  it('StaticAnalysis_AWorktreeThatDeletesThePinnedTaintRuleset_FailsTheLeg', async () => {
    const worktree = fixtureRoot({ 'src/a.ts': '' });

    const result = await runPinned(worktree, boundaryProfile([taintCheck()]));

    expect(result.data).toMatchObject({ passed: false, verdict: 'fail', failCount: 1 });
    expect(legLine(result, 'Boundary IO taint')).toContain('.semgrep/no-raw-io-into-core.yml');
    expect(spawns.ran.filter(([cmd]) => cmd === 'semgrep')).toEqual([]);
  });

  /**
   * The pinned term is unresolved, and the worktree config loads with the default globs. The leg has no scope, so it fails before its scan.
   * It does not scan the default roots in its place. The taint leg reads no scope, so it runs.
   * The killing assertion: the old gate reads the worktree scope, runs the scan, and the stub report passes.
   */
  it('StaticAnalysis_InASegment_AnUnresolvedFirstPartyTerm_FailsTheCruiserLegAndNamesTheKey', async () => {
    const worktree = fixtureRoot({
      '.dependency-cruiser.cjs': CRUISER_CONFIG,
      '.semgrep/no-raw-io-into-core.yml': 'rules: []\n',
      '.exarchos.yml': 'ownership:\n  firstParty:\n    - src/**\n',
      'src/a.ts': '',
    });
    const firstParty: VerificationProfile['firstParty'] = { state: 'unresolved', reason: UNRESOLVED_FIRST_PARTY_REASON };

    const result = await runPinned(worktree, boundaryProfile([cruiserCheck(), taintCheck()], firstParty));

    expect(result.data).toMatchObject({ passed: false, verdict: 'fail' });
    const cruiserLine = legLine(result, 'Import boundaries');
    expect(cruiserLine).toContain('**FAIL**');
    expect(cruiserLine).toContain('ownership.firstParty');
    expect(cruiserLine).toContain(`pinned by capsule v${VERSION}. ${UNRESOLVED_FIRST_PARTY_REASON}`);
    expect(cruiserLine).toContain(`A rerun under capsule v${VERSION} gives the same verdict.`);
    expect(cruiserCalls()).toEqual([]);
    expect(spawns.ran.filter(([cmd]) => cmd === 'semgrep')).toHaveLength(1);
  });

  /**
   * The pinned entry names a config at a path that the old gate never looks at, and the root holds no `.dependency-cruiser.*`.
   * The killing assertion: the executor gets the approved argv of the pin, with the scan roots after it. The executor resolves its program.
   * The old gate finds no config at the root, so the leg does not run.
   */
  it('StaticAnalysis_AConfiguredBoundaryCheck_RunsThePinnedArgvWithTheScanRoots', async () => {
    const worktree = fixtureRoot({ 'rules/boundaries.cjs': CRUISER_CONFIG, 'src/a.ts': '' });

    const result = await runPinned(worktree, boundaryProfile([cruiserCheck('rules/boundaries.cjs')]));

    expect(cruiserCalls()).toEqual([
      [
        'depcruise',
        '--validate',
        'rules/boundaries.cjs',
        '--output-type',
        'json',
        'src',
      ],
    ]);
    expect(result.data).toMatchObject({ passed: true, verdict: 'pass' });
  });

  /** A pinned taint check runs its argv with the core sources after it. The old gate finds no ruleset at the default path and runs no engine. */
  it('StaticAnalysis_AConfiguredTaintCheck_RunsThePinnedArgvWithTheCoreSources', async () => {
    const worktree = fixtureRoot({ 'rules/taint.yml': 'rules: []\n', 'src/a.ts': '' });

    await runPinned(worktree, boundaryProfile([taintCheck('rules/taint.yml')]));

    expect(spawns.ran.filter(([cmd]) => cmd === 'semgrep')).toEqual([
      ['semgrep', '--error', '--quiet', '--config', 'rules/taint.yml', '.'],
    ]);
  });

  /** The pin holds no boundary check, and the worktree added a config. No leg runs, so a task cannot add a check that judges it. */
  it('StaticAnalysis_APinWithNoBoundaryCheck_RunsNoLeg', async () => {
    const worktree = fixtureRoot({ '.dependency-cruiser.cjs': CRUISER_CONFIG, 'src/a.ts': '' });

    const result = await runPinned(worktree, boundaryProfile([]));

    expect(cruiserCalls()).toEqual([]);
    expect(legLine(result, 'Import boundaries')).toBeUndefined();
    expect(result.data).toMatchObject({ passed: true, passCount: 2 });
  });

  /** A list gives one leg for each entry, in list order, each with the report label of its adapter. */
  it('StaticAnalysis_TheBoundaryChecks_RunInListOrderWithTheLabelOfEachAdapter', async () => {
    const worktree = fixtureRoot({
      '.dependency-cruiser.cjs': CRUISER_CONFIG,
      '.semgrep/no-raw-io-into-core.yml': 'rules: []\n',
      'src/a.ts': '',
    });

    const result = await runPinned(worktree, boundaryProfile([taintCheck(), cruiserCheck()]));

    const report = reportOf(result);
    expect(report.indexOf('Boundary IO taint')).toBeGreaterThan(-1);
    expect(report.indexOf('Boundary IO taint')).toBeLessThan(report.indexOf('Import boundaries'));
  });

  /**
   * A direct call keeps the scope of its config read. It drops a glob that leaves the root and names it, as before.
   * This case is a twin: it pins the kept behaviour beside `StaticAnalysis_InASegment_UsesThePinnedFirstPartyGlobs`.
   */
  it('StaticAnalysis_ADirectCall_DropsAGlobThatLeavesTheRootAndNamesIt', async () => {
    const repoRoot = fixtureRoot({
      '.dependency-cruiser.cjs': CRUISER_CONFIG,
      '.exarchos.yml': 'ownership:\n  firstParty:\n    - src/**\n    - ../shared/**\n',
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } }),
      'src/a.ts': '',
    });

    const result = await runDirect(repoRoot);

    expect(cruiserCalls()[0]?.at(-1)).toBe('src');
    expect(legLine(result, 'Import boundaries')).toContain('../shared/**');
    expect(legLine(result, 'Import boundaries')).toContain('**PASS**');
  });
});

describe('boundary adapters — the report reader of a check', () => {
  /** 256 errors wrap to exit 0, so the adapter reads the JSON report. A report with errors fails on exit 0, and a clean report passes on exit 1. */
  it('BoundaryAdapters_TheCruiseReport_GivesTheVerdictNotTheExitCode', () => {
    const repoRoot = fixtureRoot({ '.dependency-cruiser.cjs': CRUISER_CONFIG, 'src/a.ts': '' });
    const violating = JSON.stringify({ summary: { error: 1, totalCruised: 2, violations: [] } });

    const onExitZero = runBoundaryLint({
      repoRoot,
      check: cruiserCheck(),
      runCommand: stubRunner({ exitCode: 0, stdout: violating, stderr: '' }).runner,
      findDepcruise: () => 'bin/depcruise',
    });
    const onExitOne = runBoundaryLint({
      repoRoot,
      check: cruiserCheck(),
      runCommand: stubRunner({ exitCode: 1, stdout: CLEAN_REPORT, stderr: '' }).runner,
      findDepcruise: () => 'bin/depcruise',
    });

    expect(onExitZero).toMatchObject({ status: 'FAIL', cause: 'violations' });
    expect(onExitOne).toMatchObject({ status: 'PASS', cruised: 2 });
  });

  /** A configured command that prints no report gets the FAIL of an incomplete report, and the rerun names its argv with no report flag. */
  it('BoundaryAdapters_ACommandWithNoReport_FailsAndTheRerunNamesItsArgv', () => {
    const repoRoot = fixtureRoot({ 'rules/boundaries.cjs': CRUISER_CONFIG, 'src/a.ts': '' });

    const result = runBoundaryLint({
      repoRoot,
      check: cruiserCheck('rules/boundaries.cjs'),
      runCommand: stubRunner({ exitCode: 0, stdout: 'all good', stderr: '' }).runner,
      findDepcruise: () => path.join(repoRoot, 'node_modules', '.bin', BIN_NAME),
    });

    expect(result).toMatchObject({ status: 'FAIL', cause: 'config-or-usage' });
    expect(result.status === 'FAIL' ? result.detail : '').toContain(
      `Re-run \`${path.join('node_modules', '.bin', BIN_NAME)} --validate rules/boundaries.cjs src\``,
    );
  });

  /** Only the program `depcruise` resolves through the lookup. Each other program runs as the argv names it, and the rerun names it the same way. */
  it('BoundaryAdapters_AnotherProgram_RunsAsItsArgvNamesIt', () => {
    const repoRoot = fixtureRoot({ '.dependency-cruiser.cjs': CRUISER_CONFIG, 'src/a.ts': '' });
    const check = {
      ...cruiserCheck(),
      command: { state: 'resolved' as const, argv: ['./tools/cruise.sh', '--validate'], source: 'config' as const },
    };
    const lookup = vi.fn(() => 'bin/depcruise');
    const { runner, calls } = stubRunner({ exitCode: 1, stdout: '', stderr: 'no report' });

    const result = runBoundaryLint({ repoRoot, check, runCommand: runner, findDepcruise: lookup });

    expect(calls).toEqual([['./tools/cruise.sh', '--validate', 'src']]);
    expect(lookup).not.toHaveBeenCalled();
    expect(result.status === 'FAIL' ? result.detail : '').toContain('Re-run `./tools/cruise.sh --validate src`');
  });

  /** The taint rerun names the argv of the check less the flag that hides the messages of the tool. */
  it('BoundaryAdapters_TheTaintRerun_NamesItsArgvWithoutTheQuietFlag', () => {
    const repoRoot = fixtureRoot({ 'rules/taint.yml': 'rules: []\n' });

    const result = runRawIoTaint({
      repoRoot,
      check: taintCheck('rules/taint.yml'),
      runCommand: stubRunner({ exitCode: 9, stdout: '', stderr: '' }).runner,
    });

    expect(result).toMatchObject({ status: 'FAIL', cause: 'unknown-exit' });
    expect(result.status === 'FAIL' ? result.detail : '').toContain(
      'Re-run `semgrep --error --config rules/taint.yml .` without --quiet to read its message',
    );
  });
});

describe('boundary legs that the verifier plans and observes', () => {
  /** The verifier plans the leg on its image, runs the planned argv, and reads the complete result with the reader of the local runner. */
  it('BoundaryAdapters_APlannedLeg_RunsTheLocalArgvAndReadsTheSameVerdict', () => {
    const repoRoot = fixtureRoot({ '.dependency-cruiser.cjs': CRUISER_CONFIG, 'src/a.ts': '' });
    const bin = path.join(repoRoot, 'node_modules', '.bin', BIN_NAME);
    const violating = JSON.stringify({ summary: { error: 1, totalCruised: 2,
      violations: [{ rule: { name: 'no-cycle', severity: 'error' }, from: 'src/a.ts', to: 'src/b.ts' }] } });
    const report: CommandResult = { exitCode: 0, stdout: violating, stderr: '' };
    const { runner, calls } = stubRunner(report);
    const local = runBoundaryLint({ repoRoot, check: cruiserCheck(), runCommand: runner, findDepcruise: () => bin });
    const planned = planBoundaryCheck(cruiserCheck(), { repoRoot, findDepcruise: () => bin });

    expect(planned).toMatchObject({ adapter: 'dependency-cruiser', name: 'Import boundaries', plan: { kind: 'run' } });
    if (planned.plan.kind !== 'run') return;
    expect([planned.plan.bin, ...planned.plan.args]).toEqual(calls[0]);
    expect(planned.plan.classify(report)).toEqual(local);
    expect(local).toMatchObject({ status: 'FAIL', cause: 'violations' });
  });

  /** A missing config settles with no process. The detail names the registered checkout and never the private image. */
  it('BoundaryAdapters_APlannedLegWithNoConfig_SettlesAndNamesTheDisplayRoot', () => {
    const repoRoot = fixtureRoot({ 'src/a.ts': '' });
    const planned = planBoundaryCheck(cruiserCheck(), { repoRoot, displayRoot: '/registered/checkout' });

    expect(planned.plan).toMatchObject({ kind: 'settled', result: { status: 'FAIL', cause: 'config-or-usage' } });
    expect(JSON.stringify(planned.plan)).toContain('/registered/checkout');
    expect(JSON.stringify(planned.plan)).not.toContain(repoRoot);
  });

  /** Observed legs run no boundary command. A scope that cannot be read still fails the import-boundary leg, as on a local run. */
  it('StaticAnalysis_ObservedBoundaryLegs_RunNoBoundaryCommandAndKeepTheScopeFailure', () => {
    const repoRoot = fixtureRoot({ '.dependency-cruiser.cjs': CRUISER_CONFIG, 'src/a.ts': '' });
    const cruised = positiveCount(2);
    if (cruised === undefined) throw new Error('Missing positive count');
    const checks: VerificationProfile['staticAnalysis'] = { state: 'resolved', source: 'config',
      checks: [{ name: 'lint', command: { state: 'resolved', source: 'config', argv: ['lint'] } }] };
    const observedBoundaryLegs = [{ name: 'Import boundaries', result: { status: 'PASS' as const, cruised, detail: '2 modules checked' } }];
    const { runner, calls } = stubRunner({ exitCode: 0, stdout: '', stderr: '' });
    const observed = runStaticAnalysis({ repoRoot, checks, boundaryChecks: [cruiserCheck()], runCommand: runner, observedBoundaryLegs });

    expect(calls).toEqual([['lint']]);
    expect(observed.status).toBe('pass');
    expect(observed.output).toContain('Import boundaries — 2 modules checked');

    const broken = runStaticAnalysis({ repoRoot, checks, boundaryChecks: [cruiserCheck()], runCommand: runner, observedBoundaryLegs,
      projectConfigError: { source: '.exarchos.yml', message: 'bad YAML' } });
    expect(broken.status).toBe('fail');
    expect(broken.output).toContain('the project config .exarchos.yml does not load');
  });

  /** A refusal of the executor runs no leg. The producer records the refusal, which reads with no verdict. */
  it('StaticAnalysis_ARefusedCheck_RunsNoProcessAndRecordsTheRefusal', async () => {
    const worktree = fixtureRoot({ '.dependency-cruiser.cjs': CRUISER_CONFIG, 'src/a.ts': '' });

    const result = await handleStaticAnalysis({ featureId: 'feat-refused', repoRoot: worktree,
      verificationProfile: { capsuleVersion: VERSION, profile: boundaryProfile([cruiserCheck()]) } }, tmpDir, new EventStore(tmpDir),
      fakeExecutor(processRunner, 'The program depcruise lies inside the checkout.').executor);

    expect(result).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED' } });
    expect(spawns.ran).toEqual([]);
    expect(spawns.produced).toBe(1);
  });
});
