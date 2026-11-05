/**
 * The kill probe classifies and runs with the terms of the verification profile.
 *
 * Each case calls `handleTestAdequacy` directly, in a trusted scope, against a real git fixture and a real event store.
 * A case with a pinned profile passes it in `args.verificationProfile`, because a call through the dispatcher removes it.
 * A case that injects `runTests` records each run. A case that asserts an argv uses the default runner with a recorder script.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { EventStore } from '../../../../src/events/store.js';
import {
  buildScopedTestRunner,
  handleTestAdequacy,
  runLimitsOf,
  type TestAdequacyArgs,
} from '../../../../src/verbs/gates/test-adequacy-handler.js';
import type { RunOutcome, TestRunFn } from '../../../../src/verbs/gates/test-adequacy.js';
import type { RiskTier } from '../../../../src/workflow/verification-policy.js';
import { execFileAsync, isolatedSync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller, seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import {
  pinnedTestProfile,
  pinnedUnresolvedGlobProfile,
  polyglotGlobTerm,
  UNRESOLVED_GLOBS_REASON,
  unscopedProbeTerm,
} from '../../../helpers/verification-profile.js';

const FEATURE = 'feat-kill-probe-profile';
const TASK_BRANCH = 'feature/task';
/** The budget of one case. A case spawns git, and some cases spawn a process for each run of the probe. */
const CASE_TIMEOUT_MS = 120_000;

/** The files of one commit: the path of each file and its text. */
type Files = Readonly<Record<string, string>>;

/** A Node manifest that holds the `test:files` script. */
const NODE_MANIFEST = JSON.stringify({ name: 'fixture', private: true, scripts: { 'test:files': 'node --test' } });

/** The text of a source file at the base. The revert brings it back. */
const BASE = 'base\n';

/** The text of a changed file on the task branch. */
const TASK = 'task\n';

/** A config with a `dotnet test` probe and test globs that name only C# tests. */
const DOTNET_PROBE_WITH_GLOBS = "verification:\n  tests:\n    globs:\n      - '**/*Tests.cs'\n    probe:\n      command: dotnet test\n";

/** A config with a `dotnet test` probe and no test globs. */
const DOTNET_PROBE_ALONE = 'verification:\n  tests:\n    probe:\n      command: dotnet test\n';

/** A config whose test globs are the co-located globs. */
const CO_LOCATED_GLOBS = "verification:\n  tests:\n    globs:\n      - '**/*.test.*'\n      - '**/*.spec.*'\n      - '**/__tests__/**'\n";

/** Each stamp of a direct call: no tier, then each tier. */
const EVERY_TIER: readonly (RiskTier | undefined)[] = [undefined, 'low', 'medium', 'high'];

/** The fields of the gate carrier that the cases read. The parse checks them, so no case trusts the shape of the data. */
const CarrierSchema = z.object({
  passed: z.boolean(),
  disposition: z.string(),
  verdict: z.string(),
  completeness: z.string(),
  redObserved: z.boolean(),
  restoredClean: z.boolean(),
  probedTests: z.array(z.string()),
  skipped: z.boolean().optional(),
  discriminant: z.string().optional(),
  report: z.string().optional(),
  advisorySkips: z.array(z.object({ name: z.string(), cause: z.string() })).optional(),
});

type Carrier = z.infer<typeof CarrierSchema>;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

/** Writes each file under the root, and makes its directory first. */
function writeFiles(repoRoot: string, files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
    writeFileSync(path.join(repoRoot, file), text);
  }
}

/** A repository with `base` committed on `main`, and a task branch that writes `task` and deletes `deleted`. The branch is checked out. */
async function taskRepo(base: Files, task: Files, deleted: readonly string[] = []): Promise<string> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'kill-probe-profile-'));
  cleanups.push(() => rmrf(repoRoot));
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  writeFiles(repoRoot, base);
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  await git(repoRoot, ['checkout', '-q', '-b', TASK_BRANCH]);
  writeFiles(repoRoot, task);
  if (deleted.length > 0) await git(repoRoot, ['rm', '-q', '--', ...deleted]);
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-q', '-m', 'the work of the task']);
  return repoRoot;
}

/** The carrier of one direct gate call, in a new store. */
async function runGate(repoRoot: string, extra: Partial<TestAdequacyArgs> = {}): Promise<Carrier> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'kill-probe-profile-state-'));
  const eventStore = new EventStore(stateDir);
  cleanups.push(() => {
    eventStore.close();
    rmrf(stateDir);
  });
  await eventStore.initialize();
  await seedActivePhaseAttempt(eventStore, FEATURE);
  const result = await runAsTrustedCaller(stateDir, () =>
    handleTestAdequacy(
      { featureId: FEATURE, taskId: 'T-1', branch: TASK_BRANCH, baseBranch: 'main', repoRoot, ...extra },
      stateDir,
      eventStore,
    ),
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  return CarrierSchema.parse(result.data);
}

/** One run of a recording runner: the test files, and the text of each watched file during the run. */
interface RecordedCall {
  readonly testFiles: readonly string[];
  readonly watched: readonly (string | null)[];
}

/**
 * A runner that records each run. It is green while `source` holds the task text and red on the reverted source.
 * It reads each file of `watched` during the run, so a case can tell which files the revert changed.
 */
function recordingRunner(
  repoRoot: string,
  source: string,
  watched: readonly string[] = [],
): { readonly runTests: TestRunFn; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const read = (file: string): string | null =>
    existsSync(path.join(repoRoot, file)) ? readFileSync(path.join(repoRoot, file), 'utf-8') : null;
  const runTests: TestRunFn = async ({ testFiles }): Promise<RunOutcome> => {
    calls.push({ testFiles, watched: watched.map(read) });
    return { kind: 'ran', result: read(source) === TASK ? 'green' : 'red' };
  };
  return { runTests, calls };
}

/** The name of the recorder script of a fixture. It is at the base, so the revert never touches it. */
const RECORDER = 'probe-run.mjs';

/** A recorder script: it appends its arguments to `marker`, then exits 0 on the task source of `src/a.ts`, else `redCode`. */
function recorderScript(marker: string, redCode: number): string {
  return [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `process.exit(readFileSync('src/a.ts', 'utf-8') === ${JSON.stringify(TASK)} ? 0 : ${redCode});`,
    '',
  ].join('\n');
}

/** A new path for the runs of a recorder script, outside the repository. The file exists after the first run. */
function newMarker(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kill-probe-profile-marker-'));
  cleanups.push(() => rmrf(dir));
  return path.join(dir, 'runs.jsonl');
}

/** The argument list of each run that the recorder script wrote into `marker`. */
function recordedArgv(marker: string): unknown[] {
  return readFileSync(marker, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
}

/** Asserts a blocked probe that ran no test: its cause, its verdict, and each text that its report holds. */
function expectBlockedWith(carrier: Carrier, cause: string, texts: readonly string[]): void {
  expect(carrier.discriminant).toBe(cause);
  expect(carrier.passed).toBe(false);
  expect(carrier.disposition).toBe('blocked');
  expect(carrier.verdict).toBe('indeterminate');
  expect(carrier.skipped).toBeUndefined();
  expect(carrier.probedTests).toEqual([]);
  for (const text of texts) expect(carrier.report, text).toContain(text);
}

describe('the kill probe in a root where a test of another toolchain can change', () => {
  /** The root sets a `dotnet test` probe and globs that name only C# tests. So the probe runs the C# test. */
  it('KillProbe_ACSharpTestInANodeRootWithAConfiguredDotnetProbe_IsProbed', async () => {
    const repoRoot = await taskRepo(
      { 'package.json': NODE_MANIFEST, 'App.sln': '', 'src/Foo.cs': BASE, '.exarchos.yml': DOTNET_PROBE_WITH_GLOBS },
      { 'src/Foo.cs': TASK, 'Tests/FooTests.cs': TASK },
    );
    const { runTests, calls } = recordingRunner(repoRoot, 'src/Foo.cs');

    const carrier = await runGate(repoRoot, { runTests });

    expect(carrier.discriminant).toBeUndefined();
    expect(carrier.passed).toBe(true);
    expect(carrier.redObserved).toBe(true);
    expect(carrier.probedTests).toEqual(['Tests/FooTests.cs']);
    expect(calls.map((call) => call.testFiles)).toEqual([['Tests/FooTests.cs'], ['Tests/FooTests.cs']]);
  }, CASE_TIMEOUT_MS);

  /**
   * The configured globs name only C# tests, so a replaced seed claims the TypeScript test. The configured probe cannot run it.
   * The killing assertion: with the task reverted, no `unprobed-test-paths` cause exists, and the old handler runs its own command.
   */
  it('KillProbe_ATypeScriptTestInAPolyglotRootWithAConfiguredDotnetProbe_BlocksAsUnprobedTestPaths', async () => {
    const repoRoot = await taskRepo(
      { 'package.json': NODE_MANIFEST, 'App.sln': '', 'src/a.ts': BASE, '.exarchos.yml': DOTNET_PROBE_WITH_GLOBS },
      { 'src/a.ts': TASK, 'src/a.test.ts': TASK },
    );
    const { runTests, calls } = recordingRunner(repoRoot, 'src/a.ts');

    const carrier = await runGate(repoRoot, { runTests });

    expectBlockedWith(carrier, 'unprobed-test-paths', [
      'src/a.test.ts',
      'verification.tests.globs',
      'verification.tests.probe',
      '#1629',
    ]);
    expect(calls).toEqual([]);
  }, CASE_TIMEOUT_MS);

  /**
   * A directory glob of a second toolchain claims no file, seeded or as a replaced seed. So the helper is test support, and the probe keeps it.
   * This is the twin of the TypeScript case above. The old handler takes the co-located globs here, so this case passes on revert.
   */
  it('KillProbe_AHelperUnderADirectoryGlobOfASecondToolchain_StaysTestSupport', async () => {
    const arms: readonly Files[] = [{}, { '.exarchos.yml': CO_LOCATED_GLOBS }];
    for (const config of arms) {
      const repoRoot = await taskRepo(
        { 'package.json': NODE_MANIFEST, 'requirements.txt': '', 'src/a.ts': BASE, 'tests/helpers/x.ts': BASE, ...config },
        { 'src/a.ts': TASK, 'tests/helpers/x.ts': TASK, 'src/a.test.ts': TASK },
      );
      const { runTests, calls } = recordingRunner(repoRoot, 'src/a.ts', ['tests/helpers/x.ts']);

      const carrier = await runGate(repoRoot, { runTests });

      expect(carrier.discriminant).toBeUndefined();
      expect(carrier.passed).toBe(true);
      expect(carrier.probedTests).toEqual(['src/a.test.ts']);
      expect(calls).toEqual([
        { testFiles: ['src/a.test.ts'], watched: [TASK] },
        { testFiles: ['src/a.test.ts'], watched: [TASK] },
      ]);
    }
  }, CASE_TIMEOUT_MS);

  /** The dotnet test-name glob names the C# test, and the seeded Node probe cannot run it. Unprobed, it never reads as source. */
  it('KillProbe_ACSharpTestInANodeRootWithTheSeededNodeProbe_BlocksAsUnprobedTestPaths', async () => {
    const repoRoot = await taskRepo(
      { 'package.json': NODE_MANIFEST, 'App.sln': '', 'src/Foo.cs': BASE },
      { 'src/Foo.cs': TASK, 'Tests/FooTests.cs': TASK },
    );
    const { runTests, calls } = recordingRunner(repoRoot, 'src/Foo.cs');

    const carrier = await runGate(repoRoot, { runTests });

    expectBlockedWith(carrier, 'unprobed-test-paths', [
      'Tests/FooTests.cs',
      'verification.tests.probe',
      'verification.tests.globs',
      '#1629',
    ]);
    expect(calls).toEqual([]);
  }, CASE_TIMEOUT_MS);

  /**
   * Only dotnet matches at the root, so the seeded `dotnet test` probe takes the dotnet globs, and the co-located test does not fit it.
   * The killing assertion: the injected runner gets no call. With the task reverted, it gets two green runs.
   */
  it('KillProbe_ACoLocatedTestInASolutionRoot_BlocksAsUnprobedTestPaths', async () => {
    const repoRoot = await taskRepo(
      { 'App.sln': '', 'ClientApp/package.json': NODE_MANIFEST, 'ClientApp/src/app.ts': BASE },
      { 'ClientApp/src/app.ts': TASK, 'ClientApp/src/app.test.ts': TASK },
    );
    const calls: (readonly string[])[] = [];
    const runTests: TestRunFn = async ({ testFiles }) => {
      calls.push(testFiles);
      return { kind: 'ran', result: 'green' };
    };

    const carrier = await runGate(repoRoot, { runTests });

    expectBlockedWith(carrier, 'unprobed-test-paths', [
      'ClientApp/src/app.test.ts',
      'verification.tests.probe',
      'verification.tests.globs',
      '#1629',
    ]);
    expect(calls).toEqual([]);
  }, CASE_TIMEOUT_MS);

  /**
   * A configured `npm` probe takes the node row, though node does not match at the root. Its globs are the co-located globs, so the C# test does not fit it.
   * The killing assertion: the injected runner gets no call. With the task reverted, the handler does not read the key, and the runner gets two green runs.
   */
  it('KillProbe_ACSharpTestInASolutionRootWithAConfiguredNpmProbe_BlocksAsUnprobedTestPaths', async () => {
    const repoRoot = await taskRepo(
      {
        'App.sln': '',
        'ClientApp/package.json': NODE_MANIFEST,
        'src/Foo.cs': BASE,
        '.exarchos.yml': 'verification:\n  tests:\n    probe:\n      command: npm --prefix ClientApp run test:files\n',
      },
      { 'src/Foo.cs': TASK, 'Tests/FooTests.cs': TASK },
    );
    const calls: (readonly string[])[] = [];
    const runTests: TestRunFn = async ({ testFiles }) => {
      calls.push(testFiles);
      return { kind: 'ran', result: 'green' };
    };

    const carrier = await runGate(repoRoot, { runTests });

    expectBlockedWith(carrier, 'unprobed-test-paths', [
      'Tests/FooTests.cs',
      'verification.tests.probe',
      'verification.tests.globs',
      '#1629',
    ]);
    expect(calls).toEqual([]);
  }, CASE_TIMEOUT_MS);

  /**
   * A configured probe in a polyglot root needs configured globs, so its command is unresolved. The default runner reports the term at its first run, and no command runs.
   * With the task reverted, the old handler runs its own command and gives another cause.
   */
  it('KillProbe_AConfiguredProbeInAPolyglotRootWithNoGlobs_BlocksWithProfileUnresolved', async () => {
    const repoRoot = await taskRepo(
      { 'package.json': NODE_MANIFEST, 'App.sln': '', 'src/a.ts': BASE, '.exarchos.yml': DOTNET_PROBE_ALONE },
      { 'src/a.ts': TASK, 'src/a.test.ts': TASK },
    );

    const carrier = await runGate(repoRoot);

    expectBlockedWith(carrier, 'profile-unresolved', ['verification.tests.globs', 'verification.tests.probe', '#1629']);
    expect(carrier.restoredClean).toBe(true);
    expect(await git(repoRoot, ['status', '--porcelain'])).toBe('');
  }, CASE_TIMEOUT_MS);

  /** A replaced seed claims the C# test before the test-support check. So it blocks, though its directory marks test support. */
  it('KillProbe_ATestOfAnotherToolchainUnderASupportDirectory_BlocksAsUnprobedTestPaths', async () => {
    const repoRoot = await taskRepo(
      { 'src/a.ts': BASE },
      { 'src/a.ts': TASK, 'src/a.test.ts': TASK, 'tests/FooTests.cs': TASK },
    );
    const { runTests, calls } = recordingRunner(repoRoot, 'src/a.ts');

    const carrier = await runGate(repoRoot, {
      runTests,
      verificationProfile: pinnedTestProfile(2, { globs: polyglotGlobTerm() }),
    });

    expectBlockedWith(carrier, 'unprobed-test-paths', ['tests/FooTests.cs', 'verification.tests.globs', '#1629']);
    expect(calls).toEqual([]);
  }, CASE_TIMEOUT_MS);

  /**
   * A deleted test is not at the head, so no probe can run it, and it does not block the tests that are left.
   * It is a test of another toolchain, so it does not read as source. The revert leaves it deleted.
   */
  it('KillProbe_ADeletedTestOfAnotherToolchain_IsNotRevertedAndDoesNotBlock', async () => {
    const repoRoot = await taskRepo(
      { 'src/a.ts': BASE, 'Tests/OldTests.cs': BASE },
      { 'src/a.ts': TASK, 'src/a.test.ts': TASK },
      ['Tests/OldTests.cs'],
    );
    const { runTests, calls } = recordingRunner(repoRoot, 'src/a.ts', ['Tests/OldTests.cs']);

    const carrier = await runGate(repoRoot, {
      runTests,
      verificationProfile: pinnedTestProfile(2, { globs: polyglotGlobTerm() }),
    });

    expect(carrier.discriminant).toBeUndefined();
    expect(carrier.passed).toBe(true);
    expect(calls).toEqual([
      { testFiles: ['src/a.test.ts'], watched: [null] },
      { testFiles: ['src/a.test.ts'], watched: [null] },
    ]);
  }, CASE_TIMEOUT_MS);
});

describe('a diff that touches a test path never passes with nothing probed', () => {
  /** No glob matches the C# file, and its directory marks test support. So the diff touches a test path, and no test file is left. */
  it('KillProbe_ACSharpTestThatNoGlobMatches_BlocksAsUnprobedTestPaths', async () => {
    const repoRoot = await taskRepo(
      { 'package.json': NODE_MANIFEST, 'src/a.ts': BASE },
      { 'src/a.ts': TASK, 'tests/Foo.cs': TASK },
    );

    const carrier = await runGate(repoRoot);

    expectBlockedWith(carrier, 'unprobed-test-paths', ['tests/Foo.cs', 'verification.tests.globs']);
  }, CASE_TIMEOUT_MS);

  it('KillProbe_ADiffThatOnlyDeletesTests_BlocksAtEveryTier', async () => {
    const repoRoot = await taskRepo(
      { 'package.json': NODE_MANIFEST, 'src/a.ts': BASE, 'src/a.test.ts': BASE },
      {},
      ['src/a.test.ts'],
    );

    for (const riskTier of EVERY_TIER) {
      const carrier = await runGate(repoRoot, riskTier === undefined ? {} : { riskTier });

      expectBlockedWith(carrier, 'unprobed-test-paths', ['src/a.test.ts']);
    }
  }, CASE_TIMEOUT_MS);
});

describe('a term that the profile does not resolve blocks the probe', () => {
  it('KillProbe_AnUnresolvedGlobSet_BlocksAtEveryTierWithProfileUnresolved', async () => {
    const repoRoot = await taskRepo(
      { 'package.json': NODE_MANIFEST, 'src/a.ts': BASE, '.exarchos.yml': 'verification:\n  tests:\n    globs: []\n' },
      { 'src/a.ts': TASK, 'src/a.test.ts': TASK },
    );
    const { runTests, calls } = recordingRunner(repoRoot, 'src/a.ts');

    for (const riskTier of EVERY_TIER) {
      const carrier = await runGate(repoRoot, { runTests, ...(riskTier === undefined ? {} : { riskTier }) });

      expectBlockedWith(carrier, 'profile-unresolved', ['tests.globs', 'Then run the gate again.']);
    }
    expect(calls).toEqual([]);
  }, CASE_TIMEOUT_MS);

  /** The root gives no test command. The default runner gets the unresolved term, and the first run reports it with no process. */
  it('KillProbe_AnUnresolvedProbeCommand_BlocksWithProfileUnresolvedAtTheFirstRun', async () => {
    const repoRoot = await taskRepo({ 'src/a.ts': BASE }, { 'src/a.ts': TASK, 'src/a.test.ts': TASK });

    const carrier = await runGate(repoRoot);

    expectBlockedWith(carrier, 'profile-unresolved', ['tests.probe.command', 'verification.tests.probe.command']);
    expect(carrier.restoredClean).toBe(true);
    expect(await git(repoRoot, ['status', '--porcelain'])).toBe('');
  }, CASE_TIMEOUT_MS);

  /** Under a pin a change in the worktree changes nothing, so the reason names the route through the checkout. On revert the gate reads no pin. */
  it('KillProbe_APinnedUnresolvedTerm_NamesTheCheckoutANewPrepareAndANewBatch', async () => {
    const repoRoot = await taskRepo(
      { 'package.json': NODE_MANIFEST, 'src/a.ts': BASE },
      { 'src/a.ts': TASK, 'src/a.test.ts': TASK },
    );
    const { runTests, calls } = recordingRunner(repoRoot, 'src/a.ts');

    const carrier = await runGate(repoRoot, { runTests, verificationProfile: pinnedUnresolvedGlobProfile(3) });

    expectBlockedWith(carrier, 'profile-unresolved', [
      UNRESOLVED_GLOBS_REASON,
      'at the checkout',
      'a new prepare',
      'a new batch',
      'A rerun under capsule v3 gives the same verdict.',
    ]);
    expect(carrier.report?.startsWith('pinned by capsule v3.')).toBe(true);
    expect(calls).toEqual([]);
  }, CASE_TIMEOUT_MS);
});

describe('the probe runs the command of its term', () => {
  it('KillProbe_AConfiguredFailureExitCode_ReadsAsRed', async () => {
    const marker = newMarker();
    const repoRoot = await taskRepo(
      {
        'src/a.ts': BASE,
        [RECORDER]: recorderScript(marker, 3),
        '.exarchos.yml': `verification:\n  tests:\n    probe:\n      command: node ${RECORDER}\n      failureExitCodes: [3]\n`,
      },
      { 'src/a.ts': TASK, 'src/a.test.ts': TASK },
    );

    const carrier = await runGate(repoRoot);

    expect(carrier.discriminant).toBeUndefined();
    expect(carrier.passed).toBe(true);
    expect(carrier.redObserved).toBe(true);
    expect(recordedArgv(marker)).toHaveLength(2);
  }, CASE_TIMEOUT_MS);

  it('KillProbe_TheAsArgumentsForm_PassesTheFilesWithNoSeparator', async () => {
    const marker = newMarker();
    const repoRoot = await taskRepo(
      {
        'src/a.ts': BASE,
        [RECORDER]: recorderScript(marker, 1),
        '.exarchos.yml': `verification:\n  tests:\n    probe:\n      command: node ${RECORDER}\n      files: as-arguments\n`,
      },
      { 'src/a.ts': TASK, 'src/a.test.ts': TASK },
    );

    const carrier = await runGate(repoRoot);

    expect(carrier.passed).toBe(true);
    expect(recordedArgv(marker)).toEqual([['src/a.test.ts'], ['src/a.test.ts']]);
  }, CASE_TIMEOUT_MS);

  /** A configured segment replaces the seed. So the file under it stays out of the revert, and the seeded segments no longer apply. */
  it('KillProbe_ConfiguredSupportSegments_KeepTheirFilesOutOfTheRevert', async () => {
    const repoRoot = await taskRepo(
      {
        'package.json': NODE_MANIFEST,
        'src/a.ts': BASE,
        'harness/x.ts': BASE,
        '.exarchos.yml': 'verification:\n  tests:\n    support:\n      - harness\n',
      },
      { 'src/a.ts': TASK, 'harness/x.ts': TASK, 'src/a.test.ts': TASK },
    );
    const { runTests, calls } = recordingRunner(repoRoot, 'src/a.ts', ['harness/x.ts']);

    const carrier = await runGate(repoRoot, { runTests });

    expect(carrier.passed).toBe(true);
    expect(calls.map((call) => call.watched)).toEqual([[TASK], [TASK]]);
  }, CASE_TIMEOUT_MS);

  /** The `none` form runs the whole command on the task source and on the reverted source. The verdict stands, with the visible degraded mark. */
  it('KillProbe_TheNoneForm_RunsTheWholeCommandAndMarksUnscopedRun', async () => {
    const marker = newMarker();
    const repoRoot = await taskRepo(
      { 'src/a.ts': BASE, [RECORDER]: recorderScript(marker, 1) },
      { 'src/a.ts': TASK, 'src/a.test.ts': TASK },
    );

    const carrier = await runGate(repoRoot, {
      verificationProfile: pinnedTestProfile(2, { probe: unscopedProbeTerm(['node', RECORDER]) }),
    });

    expect(recordedArgv(marker)).toEqual([[], []]);
    expect(carrier.passed).toBe(true);
    expect(carrier.verdict).toBe('pass');
    expect(carrier.completeness).toBe('degraded');
    expect(carrier.advisorySkips).toEqual([{ name: 'Scoped run', cause: 'unscoped-run' }]);
  }, CASE_TIMEOUT_MS);

  /**
   * Each given limit wins, else the default of the form applies. A real run shows that the runner takes these limits.
   * The output of the run is past the scoped limit and within the limit of a whole suite.
   */
  it('KillProbe_AnUnscopedRun_GetsTheLimitOfAWholeSuiteRun', async () => {
    expect(runLimitsOf('none')).toEqual({ timeoutMs: 600_000, maxOutputBytes: 64 * 1024 * 1024 });
    expect(runLimitsOf('after-separator')).toEqual({ timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
    expect(runLimitsOf('as-arguments')).toEqual({ timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
    expect(runLimitsOf('none', { timeoutMs: 5 })).toEqual({ timeoutMs: 5, maxOutputBytes: 64 * 1024 * 1024 });
    expect(runLimitsOf('as-arguments', { maxOutputBytes: 7 })).toEqual({ timeoutMs: 120_000, maxOutputBytes: 7 });

    const argv = [process.execPath, '-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"];
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'kill-probe-profile-limits-'));
    cleanups.push(() => rmrf(workDir));
    const unscoped = unscopedProbeTerm(argv);
    const run = async (form: 'none' | 'as-arguments'): Promise<RunOutcome> =>
      await isolatedSync(() => buildScopedTestRunner({ ...unscoped, files: form }, workDir)({ repoRoot: workDir, testFiles: [] }));

    expect(await run('none')).toMatchObject({ kind: 'ran', result: 'green' });
    expect(await run('as-arguments')).toMatchObject({ kind: 'no-verdict', cause: 'overflow' });
  }, CASE_TIMEOUT_MS);

  /** A direct call pins no profile, so the gate resolves the terms at its root, and the report says so. */
  it('KillProbe_ADirectCall_ResolvesTheProfileAtItsRepoRootAndSaysSo', async () => {
    const repoRoot = await taskRepo(
      {
        'src/a.ts': BASE,
        '.exarchos.yml': "verification:\n  tests:\n    globs:\n      - 'checks/**/*.check.ts'\n",
      },
      { 'src/a.ts': TASK, 'checks/a.check.ts': TASK },
    );
    const { runTests } = recordingRunner(repoRoot, 'src/a.ts');

    const carrier = await runGate(repoRoot, { runTests });

    expect(carrier.passed).toBe(true);
    expect(carrier.probedTests).toEqual(['checks/a.check.ts']);
    expect(carrier.report).toContain(`resolved at ${repoRoot}`);
  }, CASE_TIMEOUT_MS);
});
