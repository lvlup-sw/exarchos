/**
 * The verdict of `check_integration_suite`. The gate runs the pinned term and reads the exit code.
 *
 * Exit 0 passes, a red code of the term fails, and each other end is indeterminate and blocks.
 * Each case asserts the closed `verdict` of the carrier. The real-process cases show that a signal, a timeout or an overflow cannot read as a red exit.
 * The producer is a pass-through, so each case reads the carrier that the gate builds.
 *
 * @oracle-sources: ../../../../src/verbs/gates/check-integration-suite.ts, the carrier of each run and the argv that the stub runner gets
 */

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { STORE_LOCATION_ENV_KEYS } from '../../../../src/utils/paths.js';
import { execCommandRunner, handleCheckIntegrationSuite } from '../../../../src/verbs/gates/check-integration-suite.js';
import { WHOLE_SUITE_MAX_OUTPUT_BYTES } from '../../../../src/verbs/gates/gate-utils.js';
import { PROBE_SCRATCH_PREFIX } from '../../../../src/verbs/gates/test-adequacy-handler.js';
import type { CommandResult, RunCommandFn } from '../../../../src/verbs/pure/static-analysis.js';
import type { PinnedVerificationProfile, VerificationProfile } from '../../../../src/workflow/verification/profile.js';
import { isolatedSync } from '../../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';
import {
  UNRESOLVED_INTEGRATION_REASON,
  integrationTerm,
  pinnedIntegrationProfile,
  pinnedTestProfile,
  unresolvedIntegrationTerm,
} from '../../../helpers/verification-profile.js';

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/durable-gate-producer.js')>();
  return {
    ...actual,
    runDurableGateProducer: (_scope: unknown, executeProvider: () => Promise<unknown>) => executeProvider(),
  };
});

const FEATURE = 'feat-integration-verdict';
const CAPSULE_VERSION = 4;
/** The argv of the suite of most cases. */
const SUITE_ARGV = ['npm', 'run', 'test:run'];
/** The time limit of the real-process timeout case. */
const SHORT_LIMIT_MS = 2000;
/** The time limit of a case that runs a real process past the limit, or that loads the whole action table through `dispatch`. */
const SLOW_CASE_TIMEOUT_MS = 30_000;

/** A vitest report in which one file fails at import: one failed suite and zero failed tests. */
const LOAD_FAILURE_REPORT = JSON.stringify({
  numFailedTestSuites: 1,
  numFailedTests: 0,
  numTotalTests: 3,
  testResults: [{ name: '/repo/src/broken.test.ts', status: 'failed', assertionResults: [] }],
});

/** A vitest report with no failure. */
const CLEAN_REPORT = JSON.stringify({ numFailedTestSuites: 0, numFailedTests: 0, numTotalTests: 3, testResults: [] });

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = makeTempDir('integration-suite-verdict-');
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

/** True for an object record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The carrier of a result. */
function carrierOf(result: ToolResult): Readonly<Record<string, unknown>> {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!isRecord(result.data)) throw new Error(`the gate returned no carrier: ${JSON.stringify(result)}`);
  return result.data;
}

/** A runner that gives one fixed result, and records each call. */
function stubRunner(run: Partial<CommandResult> = {}) {
  return vi.fn((_cmd: string, _args: readonly string[], _options?: { cwd?: string }): CommandResult => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...run,
  }));
}

/** One gate call at a root with no test command. The arguments pin the term, as a segment does. */
function runGate(pin: PinnedVerificationProfile, runCommand: RunCommandFn): Promise<ToolResult> {
  return handleCheckIntegrationSuite({ featureId: FEATURE, repoRoot: '/repo', verificationProfile: pin }, stateDir, store, runCommand);
}

/** The pin of a suite with the given fields of its term. */
function pinOf(fields: Partial<Omit<VerificationProfile['integration'], 'command'>> = {}): PinnedVerificationProfile {
  return pinnedIntegrationProfile(CAPSULE_VERSION, integrationTerm(SUITE_ARGV, fields));
}

/** One real run of a script through the production runner. */
function realRun(script: string, options: { readonly timeoutMs?: number } = {}): Promise<CommandResult> {
  return isolatedSync(() => execCommandRunner(process.execPath, ['-e', script], { cwd: process.cwd(), ...options }));
}

/** The carrier of a gate call that reads one real run. */
async function carrierOfRun(run: CommandResult): Promise<Readonly<Record<string, unknown>>> {
  return carrierOf(await runGate(pinOf(), stubRunner(run)));
}

describe('the verdict of the exit code', () => {
  it('IntegrationSuite_ExitZero_Passes', async () => {
    const carrier = carrierOf(await runGate(pinOf(), stubRunner({ exitCode: 0 })));

    expect(carrier).toMatchObject({ passed: true, verdict: 'pass', completeness: 'complete', failCount: 0, parseError: false });
    expect(carrier).not.toHaveProperty('noVerdictCause');
  });

  /** The killing assertion is the carrier verdict. The old runner reads no JSON and fails closed, with `passed: false` and no `verdict` field. */
  it('IntegrationSuite_AConfiguredFailureExitCode_Fails', async () => {
    const pin = pinOf({ failureExitCodes: { codes: [3], source: 'config' } });

    const carrier = carrierOf(await runGate(pin, stubRunner({ exitCode: 3 })));

    expect(carrier).toMatchObject({ passed: false, verdict: 'fail', completeness: 'complete', parseError: false });
    expect(carrier.failCount).toBeGreaterThanOrEqual(1);
    expect(carrier).not.toHaveProperty('noVerdictCause');
  });

  it('IntegrationSuite_AnUnknownExitCode_IsIndeterminateAndBlocks', async () => {
    const carrier = carrierOf(await runGate(pinOf(), stubRunner({ exitCode: 7 })));

    expect(carrier).toMatchObject({ passed: false, verdict: 'indeterminate', noVerdictCause: 'unknown-exit', parseError: true });
    expect(carrier.report).toContain('the command exited 7, and only exit 1 reads as a red run');
    expect(carrier).not.toHaveProperty('skipped');
  });

  /** The runner gets exactly the pinned argv. The old runner adds `--reporter=json`, and it runs the fallback of its own. */
  it('IntegrationSuite_TheResolvedCommand_RunsWithNoAddedFlag', async () => {
    const pin = pinnedIntegrationProfile(CAPSULE_VERSION, integrationTerm(['pnpm', 'verify', '--bail']));
    const runner = stubRunner();

    const carrier = carrierOf(await runGate(pin, runner));

    expect(carrier.verdict).toBe('pass');
    expect(runner.mock.calls).toEqual([['pnpm', ['verify', '--bail'], { cwd: '/repo' }]]);
  });

  /** The report names the source of the profile, so a reader can tell a pinned term from a term that resolved live. */
  it('IntegrationSuite_TheReport_NamesThePathOfTheProfile', async () => {
    const carrier = carrierOf(await runGate(pinOf(), stubRunner()));

    expect(carrier.report).toContain(`profile = pinned by capsule v${CAPSULE_VERSION}`);
  });
});

describe('a term that is not resolved', () => {
  /**
   * The carrier blocks and it is not a skip, because a skip carrier never halts a segment.
   * The reason names the term and the route of a remedy under a pin. No process starts.
   */
  it('IntegrationSuite_AnUnresolvedTerm_BlocksRunsNothingAndNamesTheRoute', async () => {
    const runner = stubRunner();

    const carrier = carrierOf(await runGate(pinnedIntegrationProfile(CAPSULE_VERSION, unresolvedIntegrationTerm()), runner));

    expect(carrier).toMatchObject({ passed: false, verdict: 'indeterminate', discriminant: 'profile-unresolved', parseError: true });
    expect(carrier).not.toHaveProperty('skipped');
    expect(carrier.reason).toContain(`pinned by capsule v${CAPSULE_VERSION}. ${UNRESOLVED_INTEGRATION_REASON}`);
    expect(carrier.reason).toContain('Make the change at the checkout, run a new prepare, then claim the task in a new batch.');
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('the report of a term that selects one', () => {
  /** Twin of the case that pins the argv. The old runner folds load failures with the same parser, so the fold is kept behaviour. */
  it('IntegrationSuite_TheVitestJsonReport_FoldsLoadFailures', async () => {
    const carrier = carrierOf(await runGate(pinOf({ report: 'vitest-json' }), stubRunner({ exitCode: 1, stdout: LOAD_FAILURE_REPORT })));

    expect(carrier).toMatchObject({ passed: false, verdict: 'fail', loadFailures: 1, failCount: 1 });
    expect(carrier.report).toContain('/repo/src/broken.test.ts');
  });

  it('IntegrationSuite_AReportWithFailures_FailsOnExitZero', async () => {
    const carrier = carrierOf(await runGate(pinOf({ report: 'vitest-json' }), stubRunner({ exitCode: 0, stdout: LOAD_FAILURE_REPORT })));

    expect(carrier).toMatchObject({ passed: false, verdict: 'fail', loadFailures: 1 });
  });

  it('IntegrationSuite_ARedExitWithACleanReport_Fails', async () => {
    const carrier = carrierOf(await runGate(pinOf({ report: 'vitest-json' }), stubRunner({ exitCode: 1, stdout: CLEAN_REPORT })));

    expect(carrier).toMatchObject({ passed: false, verdict: 'fail', failCount: 1 });
    expect(carrier.report).toContain('exit 1, and the report names no failure');
  });

  /** A crashed reporter can exit 0, so a report that does not parse gives no verdict on any exit that the term reads. */
  it.each([
    ['exit 0', 0],
    ['a red exit', 1],
  ])('IntegrationSuite_AMissingReport_IsIndeterminateAndBlocks [%s]', async (_label, exitCode) => {
    const carrier = carrierOf(await runGate(pinOf({ report: 'vitest-json' }), stubRunner({ exitCode, stdout: 'no report here' })));

    expect(carrier).toMatchObject({
      passed: false,
      verdict: 'indeterminate',
      noVerdictCause: 'shape-mismatch',
      parseError: true,
      parseFailureKind: 'shape-mismatch',
    });
  });
});

describe('an end of a real process that is not an exit', () => {
  /** A signal gives no exit status, and the old runner maps a missing status to exit 1, the red code of the term. */
  it.skipIf(process.platform === 'win32')('IntegrationSuite_ASignal_IsIndeterminateNotRed', async () => {
    const run = await realRun("process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 5000);");

    expect(run.signal).toBe('SIGKILL');
    expect(await carrierOfRun(run)).toMatchObject({ passed: false, verdict: 'indeterminate', noVerdictCause: 'signal' });
  });

  it('IntegrationSuite_ARunPastItsLimit_IsIndeterminateAndBlocks', async () => {
    const run = await realRun('setTimeout(() => {}, 8000);', { timeoutMs: SHORT_LIMIT_MS });

    expect(run.spawnError).toBe('ETIMEDOUT');
    expect(await carrierOfRun(run)).toMatchObject({ passed: false, verdict: 'indeterminate', noVerdictCause: 'timeout' });
  }, SLOW_CASE_TIMEOUT_MS);

  /** The output limit is the limit of a whole suite. The short run stays under it and over the default limit of 1 MiB, and the long run passes it. */
  it('IntegrationSuite_AnOutputPastItsLimit_IsIndeterminateAndBlocks', async () => {
    const write = (bytes: number): string => `process.stdout.write(Buffer.alloc(${bytes}, 97));`;

    const underTheLimit = await realRun(write(2 * 1024 * 1024));
    const pastTheLimit = await realRun(write(WHOLE_SUITE_MAX_OUTPUT_BYTES + 1024));

    expect(underTheLimit.spawnError).toBeUndefined();
    expect(underTheLimit.exitCode).toBe(0);
    expect(pastTheLimit.spawnError).toBe('ENOBUFS');
    expect(await carrierOfRun(pastTheLimit)).toMatchObject({ passed: false, verdict: 'indeterminate', noVerdictCause: 'overflow' });
  }, SLOW_CASE_TIMEOUT_MS);

  it('IntegrationSuite_ACommandThatDoesNotStart_IsIndeterminateAndBlocks', async () => {
    const run = await isolatedSync(() => execCommandRunner('exarchos-no-such-command-for-this-test', [], { cwd: process.cwd() }));

    expect(run.spawnError).toBe('ENOENT');
    expect(await carrierOfRun(run)).toMatchObject({
      passed: false,
      verdict: 'indeterminate',
      noVerdictCause: 'spawn-error',
      parseFailureKind: 'spawn-failure',
    });
  });

  /** A real process prints its store keys. Each key points under one new scratch directory, and the runner deletes the directory after the run. */
  it('IntegrationSuite_TheSuite_RunsWithTheStoreKeysOfAScratchDirectory', async () => {
    const keys = Object.values(STORE_LOCATION_ENV_KEYS);
    const run = await realRun(`process.stdout.write(JSON.stringify(${JSON.stringify(keys)}.map((key) => process.env[key])));`);

    const printed: unknown = JSON.parse(run.stdout);
    if (!Array.isArray(printed)) throw new Error(`the run printed no list: ${run.stdout}`);
    const scratchDirs = new Set(printed.map((value) => path.dirname(String(value))));

    expect(printed).toHaveLength(keys.length);
    expect(scratchDirs.size).toBe(1);
    const [scratchDir = ''] = scratchDirs;
    expect(scratchDir.startsWith(path.join(tmpdir(), PROBE_SCRATCH_PREFIX))).toBe(true);
    expect(existsSync(scratchDir)).toBe(false);
  });
});

describe('the input of the gate', () => {
  /** The action schema is strict, so a call of an earlier client that still passes the removed field is refused before the handler. */
  it('CheckIntegrationSuite_ATestScriptArgument_IsRefused', async () => {
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_integration_suite', featureId: FEATURE, repoRoot: stateDir, testScript: 'test:ci' },
      withTrustedCaller({ stateDir, eventStore: store, enableTelemetry: false }),
    );

    expect(result.success, JSON.stringify(result)).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('testScript');
  }, SLOW_CASE_TIMEOUT_MS);

  /** A low-tier task is outside the sequence of the policy, so the gate skips and no process starts. The carrier passes, so the segment goes on. */
  it('CheckIntegrationSuite_ALowTierTask_IsSkippedByPolicy', async () => {
    const runner = stubRunner({ exitCode: 1 });

    const result = await handleCheckIntegrationSuite(
      {
        featureId: FEATURE,
        repoRoot: '/repo',
        riskTier: 'low',
        boundaryTouching: false,
        verificationProfile: pinnedTestProfile(CAPSULE_VERSION),
      },
      stateDir,
      store,
      runner,
    );

    const carrier = carrierOf(result);
    expect(carrier).toMatchObject({ passed: true, skipped: true, discriminant: 'skipped-by-policy' });
    expect(carrier.report).toContain("check_integration_suite is not in the resolved sequence for riskTier='low'");
    expect(runner).not.toHaveBeenCalled();
  });

  /** A high-tier task is in the sequence of the policy, so the same call runs the suite. */
  it('CheckIntegrationSuite_AHighTierTask_RunsTheSuite', async () => {
    const runner = stubRunner({ exitCode: 1 });

    const result = await handleCheckIntegrationSuite(
      {
        featureId: FEATURE,
        repoRoot: '/repo',
        riskTier: 'high',
        boundaryTouching: false,
        verificationProfile: pinnedTestProfile(CAPSULE_VERSION),
      },
      stateDir,
      store,
      runner,
    );

    expect(carrierOf(result)).toMatchObject({ passed: false, verdict: 'fail' });
    expect(carrierOf(result)).not.toHaveProperty('skipped');
    expect(runner).toHaveBeenCalledOnce();
  });
});
