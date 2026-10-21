// Acceptance tests for `check_test_adequacy`. They dispatch through the composite `handleOrchestrate`
// router against a real git fixture repo in a temp directory. The kill probe must tell a real test
// from a vacuous one.
// A real test fails when the source change is reverted, so the probe sees red and passes. A vacuous
// test stays green on the revert, so the probe fails with `redObserved: false`.
// `test-adequacy.test.ts` holds the unit tests for the split, the snapshot and restore, and the probe.

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { copyFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { resolveScopedTestCommand } from '../../../../src/config/test-runtime-resolver.js';
import {
  buildDefaultRunTests,
  buildScopedTestRunner,
  type ScopedTestRunLimits,
} from '../../../../src/verbs/gates/test-adequacy-handler.js';
import {
  RUN_NO_VERDICT_CAUSES,
  type RunNoVerdictCause,
  type RunOutcome,
  type TestRunFn,
} from '../../../../src/verbs/gates/test-adequacy.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller, seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';
import { execFileAsync, isolatedSync } from '../../../../tools/test-helpers/spawn.js';


function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

async function initRepo(prefix: string): Promise<string> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  return repoRoot;
}

/**
 * Writes a small node project whose tests run with `node --test`, so the temp repo needs no install.
 * The `test:run` script gives the npm tier of the resolver a runnable command. A case can replace
 * the scripts. The base source returns 1, and each task diff changes it to 2.
 */
async function writeBaseProject(
  repoRoot: string,
  scripts: Readonly<Record<string, string>> = { 'test:run': 'node --test', test: 'node --test' },
): Promise<void> {
  writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        version: '1.0.0',
        private: true,
        scripts,
      },
      null,
      2,
    ) + '\n',
  );
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 1;\n}\n');
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'base: project scaffold', '-q']);
}

function makeCtx(stateDir: string, eventStore: EventStore): DispatchContext {
  return withTrustedCaller({ stateDir, eventStore, enableTelemetry: false } as DispatchContext);
}

interface AdequacyData {
  passed: boolean;
  disposition?: string;
  redObserved: boolean;
  restoredClean: boolean;
  probedTests: string[];
  discriminant?: string;
  report?: string;
}

/**
 * Runs real `npm` and git in a temp fixture. On Windows, `runCommandSync` starts the `npm` `.cmd` shim
 * with `shell: true`, because `execFile` cannot start a `.cmd` file on Node 20.12.2 and later.
 */
describe('check_test_adequacy acceptance (kill probe through handleOrchestrate)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
  });

  async function dispatch(
    repoRoot: string,
    branch: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<{ success: boolean; data: AdequacyData }> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'test-adequacy-state-'));
    cleanups.push(() => rmrf(stateDir));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const ctx = makeCtx(stateDir, eventStore);
    const result = await orchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-adequacy',
        taskId: 'T-01',
        branch,
        repoRoot,
        baseBranch: 'main',
        ...extra,
      },
      ctx,
    );
    return result as { success: boolean; data: AdequacyData };
  }

  /**
   * The task diff changes the source and adds a test that asserts `value() === 2`. The probe must see
   * red on the revert and pass.
   */
  it(
    'HandleOrchestrate_CheckTestAdequacy_RealTest_PassesProbe',
    async () => {
      const repoRoot = await initRepo('test-adequacy-real-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot);

      await git(repoRoot, ['checkout', '-b', 'feature/real', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 2;\n}\n');
      writeFileSync(
        path.join(repoRoot, 'src', 'calc.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert';",
          "import { value } from './calc.js';",
          '',
          "test('value is 2', () => {",
          '  assert.strictEqual(value(), 2);',
          '});',
          '',
        ].join('\n'),
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat: bump value to 2 with test', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/real');

      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.redObserved).toBe(true);
      expect(data.restoredClean).toBe(true);
      expect(data.probedTests).toEqual(expect.arrayContaining(['src/calc.test.js']));
      expect(data.discriminant).toBeUndefined();
    },
    120_000,
  );

  /**
   * The task diff changes the source and adds a test that asserts nothing. The test stays green on the
   * revert, so the probe fails. The tool call still succeeds with an advisory carrier.
   */
  it(
    'HandleOrchestrate_CheckTestAdequacy_AssertNothingTest_FailsProbe',
    async () => {
      const repoRoot = await initRepo('test-adequacy-vacuous-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot);

      await git(repoRoot, ['checkout', '-b', 'feature/vacuous', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 2;\n}\n');
      writeFileSync(
        path.join(repoRoot, 'src', 'calc.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert';",
          '',
          "test('vacuous', () => {",
          '  assert.strictEqual(true, true);',
          '});',
          '',
        ].join('\n'),
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat: bump value to 2 with vacuous test', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/vacuous');

      expect(success).toBe(true);
      expect(data.passed).toBe(false);
      expect(data.redObserved).toBe(false);
      expect(data.restoredClean).toBe(true);
      expect(data.discriminant).toBeUndefined();
    },
    120_000,
  );

  /**
   * The test command fails on every run, and the test asserts nothing. The tests are red on the task
   * source before the revert, so a red run after the revert proves no kill. The probe must give the
   * indeterminate cause `baseline-red`, which blocks also at the low tier, and must restore the tree.
   */
  it(
    'HandleOrchestrate_CheckTestAdequacy_TestCommandAlwaysFails_IsBaselineRedAndBlocks',
    async () => {
      const repoRoot = await initRepo('test-adequacy-baseline-red-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot, { 'test:run': 'node -e "process.exit(1)"' });

      await git(repoRoot, ['checkout', '-b', 'feature/always-red', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 2;\n}\n');
      writeFileSync(
        path.join(repoRoot, 'src', 'calc.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert';",
          '',
          "test('vacuous', () => {",
          '  assert.strictEqual(true, true);',
          '});',
          '',
        ].join('\n'),
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat: bump value to 2 with vacuous test', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/always-red', { riskTier: 'low' });

      expect(success).toBe(true);
      expect(data.passed).toBe(false);
      expect(data.disposition).toBe('blocked');
      expect(data.discriminant).toBe('baseline-red');
      expect(data.redObserved).toBe(false);
      expect(data.restoredClean).toBe(true);
      expect(data.report).toContain('before any revert');
      expect(await git(repoRoot, ['status', '--porcelain'])).toBe('');
    },
    120_000,
  );

  /**
   * The project has a `test:files` script, and its `test:run` script fails on every run. The probe
   * must run `npm run test:files -- <files>`. The real test then goes red only after the revert, and the
   * probe passes. A probe on `test:run` gives `baseline-red`.
   */
  it(
    'HandleOrchestrate_CheckTestAdequacy_TestFilesScript_IsTheCommandTheProbeRuns',
    async () => {
      const repoRoot = await initRepo('test-adequacy-test-files-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot, { 'test:run': 'node -e "process.exit(1)"', 'test:files': 'node --test' });

      await git(repoRoot, ['checkout', '-b', 'feature/test-files', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 2;\n}\n');
      writeFileSync(
        path.join(repoRoot, 'src', 'calc.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert';",
          "import { value } from './calc.js';",
          '',
          "test('value is 2', () => {",
          '  assert.strictEqual(value(), 2);',
          '});',
          '',
        ].join('\n'),
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat: bump value to 2 with test', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/test-files', { riskTier: 'medium' });

      expect(success).toBe(true);
      expect(data.discriminant).toBeUndefined();
      expect(data.passed).toBe(true);
      expect(data.redObserved).toBe(true);
      expect(data.restoredClean).toBe(true);
      expect(data.probedTests).toEqual(['src/calc.test.js']);
      expect(await git(repoRoot, ['status', '--porcelain'])).toBe('');
    },
    120_000,
  );
});

/** The node binary of this run, quoted for `splitCommand`. */
const NODE = JSON.stringify(process.execPath);

/** The test file list that each runner case passes. The runner appends it after `--`. */
const TEST_FILES: readonly string[] = ['missing.test.ts'];

/** Runs one scoped test run of a runner. The runner spawns synchronously, so the call is isolated from the event loop of the worker. */
function runOnce(runner: TestRunFn, repoRoot: string): Promise<RunOutcome> {
  return isolatedSync(() => runner({ repoRoot, testFiles: TEST_FILES }));
}

/** One row for each no-verdict cause: the command, the limits of the run, and a text that the detail must hold. */
interface NoVerdictRow {
  readonly cause: RunNoVerdictCause;
  readonly command: string | null;
  readonly limits?: ScopedTestRunLimits;
  readonly detail: string;
  readonly posixOnly?: boolean;
}

/** Every no-verdict cause, each with a real process or a command that the runner cannot run. */
const NO_VERDICT_ROWS: readonly NoVerdictRow[] = [
  { cause: 'no-command', command: null, detail: 'no scoped test command' },
  { cause: 'unparseable-command', command: `${NODE} -e "process.exit(0)`, detail: 'unterminated quote' },
  { cause: 'did-not-start', command: 'exarchos-no-such-test-runner-for-this-test', detail: 'ENOENT' },
  {
    cause: 'timeout',
    command: `${NODE} -e "setTimeout(() => {}, 30000)"`,
    limits: { timeoutMs: 2_000 },
    detail: 'the limit is 2000 ms',
  },
  {
    cause: 'signal',
    command: `${NODE} -e "process.kill(process.pid, 'SIGKILL')"`,
    detail: 'the signal is SIGKILL',
    posixOnly: true,
  },
  {
    cause: 'overflow',
    command: `${NODE} -e "process.stdout.write('x'.repeat(2 * 1024 * 1024))"`,
    detail: 'the limit is 1048576 bytes',
  },
  {
    cause: 'unknown-exit-code',
    command: `${NODE} -e "process.exit(2)"`,
    detail: 'the command exited 2, and only exit 1 reads as a red run',
  },
];

/**
 * The default runner of the probe, driven with real processes. Exit 0 is green, and a test-failure exit code is red.
 * Every other end of a run gives no verdict, with its cause. The table holds one row for each cause of the closed list.
 */
describe('buildScopedTestRunner — each end of a real test run', () => {
  let workDir: string;
  beforeAll(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'probe-runner-'));
  });
  afterAll(() => {
    rmrf(workDir);
  });

  /** The denominator: the table holds each cause of the closed list once, so a new cause without a row fails here. */
  it('ScopedTestRunner_NoVerdictTable_HoldsEachCauseOnce', () => {
    expect(NO_VERDICT_ROWS).toHaveLength(RUN_NO_VERDICT_CAUSES.length);
    expect(NO_VERDICT_ROWS.map((row) => row.cause).sort()).toEqual([...RUN_NO_VERDICT_CAUSES].sort());
  });

  for (const row of NO_VERDICT_ROWS) {
    it.skipIf(row.posixOnly === true && process.platform === 'win32')(
      `ScopedTestRunner_${row.cause}_IsNoVerdictWithItsCause`,
      async () => {
        const scoped = row.command === null ? null : { command: row.command, testFailureExitCodes: [1] };

        const outcome = await runOnce(buildScopedTestRunner(scoped, workDir, row.limits), workDir);

        expect(outcome.kind).toBe('no-verdict');
        if (outcome.kind !== 'no-verdict') return;
        expect(outcome.cause).toBe(row.cause);
        expect(outcome.detail).toContain(row.detail);
      },
      30_000,
    );
  }

  it('ScopedTestRunner_ExitZero_IsAGreenRun', async () => {
    const runner = buildScopedTestRunner({ command: `${NODE} -e "process.stdout.write('ok')"`, testFailureExitCodes: [1] }, workDir);

    expect(await runOnce(runner, workDir)).toEqual({ kind: 'ran', result: 'green', stdout: 'ok' });
  });

  it('ScopedTestRunner_ExitOne_IsARedRunWithItsOutput', async () => {
    const runner = buildScopedTestRunner(
      { command: `${NODE} -e "process.stdout.write('out'); process.stderr.write('err'); process.exit(1)"`, testFailureExitCodes: [1] },
      workDir,
    );

    expect(await runOnce(runner, workDir)).toEqual({ kind: 'ran', result: 'red', stdout: 'out', stderr: 'err' });
  });

  /**
   * `cargo test` exits 101 when a test fails. The resolver gives a Cargo project the exit codes of the rust toolchain.
   * With them, exit 101 is a red run, and exit 1 gives no verdict, with a detail that names both codes.
   */
  it('ScopedTestRunner_RustToolchain_ReadsExit101AsRedAndExit1AsNoVerdict', async () => {
    const cargoRepo = mkdtempSync(path.join(workDir, 'cargo-'));
    writeFileSync(path.join(cargoRepo, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
    const resolved = resolveScopedTestCommand(cargoRepo);
    expect(resolved).toEqual({ command: 'cargo test', testFailureExitCodes: [101] });
    if (resolved === null) return;

    const red = await runOnce(
      buildScopedTestRunner({ ...resolved, command: `${NODE} -e "process.exit(101)"` }, cargoRepo),
      cargoRepo,
    );
    const noVerdict = await runOnce(
      buildScopedTestRunner({ ...resolved, command: `${NODE} -e "process.exit(1)"` }, cargoRepo),
      cargoRepo,
    );

    expect(red).toEqual({ kind: 'ran', result: 'red', stdout: '', stderr: '' });
    expect(noVerdict).toMatchObject({
      kind: 'no-verdict',
      cause: 'unknown-exit-code',
      detail: 'the command exited 1, and only exit 101 reads as a red run',
    });
  });

  /**
   * A measurement: the `test:files` wrapper refuses an argument that is not a file with exit 2. The case records whether
   * `npm run test:files` passes that exit through to the probe. npm 11 passes it through, so the run gives no verdict and is not red.
   */
  it('ScopedTestRunner_WrapperRefusalThroughNpm_PassesExit2ThroughAsNoVerdict', async () => {
    const pkg = mkdtempSync(path.join(workDir, 'npm-wrapper-'));
    const wrapper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../tools/test-helpers/run-test-files.mjs');
    copyFileSync(wrapper, path.join(pkg, 'run-test-files.mjs'));
    writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true, scripts: { 'test:files': 'node run-test-files.mjs' } }),
    );

    const outcome = await runOnce(buildDefaultRunTests(pkg), pkg);

    expect(outcome).toMatchObject({
      kind: 'no-verdict',
      cause: 'unknown-exit-code',
      detail: 'the command exited 2, and only exit 1 reads as a red run',
    });
    expect(outcome.stderr).toContain('test:files: refused');
  }, 60_000);
});

/** One key for each state directory and feature id, so each new store gets one seed. */
const seededWorkflows = new Set<string>();

/**
 * Calls the composite handler directly, not through `dispatch()`. It recreates the trusted dispatch
 * scope, because without it the gate runner refuses with `TRUSTED_CALLER_REQUIRED`. It also seeds a
 * started workflow with an active phase attempt, which the gate evidence binds to.
 */
async function orchestrate(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<Awaited<ReturnType<typeof handleOrchestrate>>> {
  const featureId = typeof args['featureId'] === 'string' ? args['featureId'] : undefined;
  if (featureId !== undefined) {
    const key = `${ctx.stateDir}\0${featureId}`;
    if (!seededWorkflows.has(key)) {
      seededWorkflows.add(key);
      await seedActivePhaseAttempt(ctx.eventStore, featureId);
    }
  }
  return runAsTrustedCaller(ctx.stateDir, () => handleOrchestrate(args, ctx));
}
