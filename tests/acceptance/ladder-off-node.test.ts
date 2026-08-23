/**
 * The top rung of the verification ladder is satisfiable off Node.
 *
 * `check_integration_suite` is a BLOCKING, high-tier ladder gate. It used to
 * resolve its command from the toolchain registry and then append vitest's
 * `--reporter=json` to whatever came back — `cargo test --reporter=json`,
 * `dotnet test --reporter=json`, `pytest --reporter=json` — an unknown flag that
 * makes the runner exit before running anything, read back as a hard failure. On
 * eleven of the twelve declared toolchains the rung could not be cleared at all.
 *
 * The property under test is stated over the LIVE registry rather than a list
 * written here: a hand-written denominator cannot notice a toolchain being
 * added, which is the failure mode this file exists to make impossible. Every
 * case below is generated from `BUILTIN_TOOLCHAINS`, and the flag set the
 * property quantifies over is generated from the carrier table.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The durable producer needs an event store, a phase attempt and a trusted
// dispatch context — all of which belong to the recording path, not to the
// verdict this file is about. Passing the provider through keeps the subject to
// what the gate concludes and how it says so.
vi.mock('../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (_scope: unknown, executeProvider: () => Promise<unknown>) =>
    executeProvider(),
}));

import {
  BUILTIN_TOOLCHAINS,
  resolveTestReportFormat,
  type Toolchain,
} from '../../src/config/toolchains.js';
import type { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import {
  execCommandRunner,
  handleCheckIntegrationSuite,
} from '../../src/verbs/gates/check-integration-suite.js';
import { normalizeGateVerdict } from '../../src/verbs/gates/gate-utils.js';
import {
  resolveIntegrationCommand,
  runIntegrationSuite,
  type IntegrationCommandResult,
  type IntegrationRuntime,
} from '../../src/verbs/pure/integration-suite.js';

// ─── Denominators, all derived ───────────────────────────────────────────────

/**
 * Every reporter flag any toolchain's carrier asks for. The "no toolchain gets
 * another toolchain's flag" property quantifies over THIS set, so a carrier arm
 * that starts asking for a new flag is covered the day it lands.
 */
const REPORTER_FLAGS: ReadonlySet<string> = new Set(
  BUILTIN_TOOLCHAINS.flatMap((toolchain) => {
    const format = resolveTestReportFormat(toolchain.id);
    return format.kind === 'vitest-json' ? [format.reporterFlag] : [];
  }),
);

/** The toolchain the registry declares under `id`, or a failure to find it. */
function builtin(id: string): Toolchain {
  const found = BUILTIN_TOOLCHAINS.find((toolchain) => toolchain.id === id);
  if (!found) throw new Error(`the registry no longer declares a '${id}' toolchain`);
  return found;
}

/** The tokens the registry declares as this toolchain's test command. */
function declaredCommand(toolchain: Toolchain): readonly string[] {
  return (toolchain.commands.test ?? '').trim().split(/\s+/);
}

/**
 * The runtime a repository of this toolchain resolves to when no higher layer
 * contributes: the registry supplies both the command and the identity.
 *
 * Derived from the toolchain rather than written out, so a registry row that
 * changes its command is followed here instead of being shadowed by a literal.
 */
function registryRuntime(toolchain: Toolchain): IntegrationRuntime {
  return { test: toolchain.commands.test, toolchain };
}

// ─── Gate harness ────────────────────────────────────────────────────────────

/** Roots this file creates, removed together in the file's own teardown. */
const scratchRoots: string[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

/** A path with no project markers at all. */
let emptyRepo = '';
/** A real Rust repository — the toolchain is read off the tree, not passed in. */
let rustRepo = '';
/** Where the gate is told to keep state. Unique per run, and removed after. */
let stateDir = '';

beforeAll(() => {
  emptyRepo = scratch('ladder-off-node-empty-');
  rustRepo = scratch('ladder-off-node-rust-');
  stateDir = scratch('ladder-off-node-state-');
  writeFileSync(join(rustRepo, 'Cargo.toml'), '[package]\nname = "governed"\n', 'utf-8');
});

afterAll(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
} as unknown as EventStore;

/**
 * Drive the REAL gate against a real directory, with only the spawn replaced.
 *
 * The toolchain is not an argument of the gate — it is read off the repository —
 * so a case about a non-Node repository has to hand it a non-Node repository.
 */
async function runGateAt(
  repoRoot: string,
  result: IntegrationCommandResult,
): Promise<{ readonly tool: ToolResult; readonly argv: readonly string[][] }> {
  const argv: string[][] = [];
  const tool = await handleCheckIntegrationSuite(
    { featureId: 'feat-off-node', repoRoot },
    stateDir,
    mockStore,
    (cmd, args) => {
      argv.push([cmd, ...args]);
      return result;
    },
  );
  return { tool, argv };
}

// ─── The property, over the live registry ────────────────────────────────────

describe('every declared toolchain composes only its own reporter flag', () => {
  it('TheRegistryIsANonEmptyDenominator', () => {
    // A property quantified over an empty set is not a proof of anything. The
    // floor is the measured registry size; growing the registry is fine, and
    // emptying it must not read as a clean run.
    expect(BUILTIN_TOOLCHAINS.length).toBeGreaterThanOrEqual(12);
    expect(REPORTER_FLAGS.size).toBeGreaterThanOrEqual(1);
  });

  it.each(BUILTIN_TOOLCHAINS.map((toolchain) => [toolchain.id, toolchain] as const))(
    'BuiltinToolchain_ReceivesNoForeignReporterFlag [%s]',
    (_id, toolchain) => {
      const resolution = resolveIntegrationCommand('/governed', undefined, () =>
        registryRuntime(toolchain),
      );
      expect(resolution.kind).toBe('runnable');
      if (resolution.kind !== 'runnable') return;

      const format = resolveTestReportFormat(toolchain.id);
      const ownFlag = format.kind === 'vitest-json' ? format.reporterFlag : null;
      const foreign = [...REPORTER_FLAGS].filter((flag) => flag !== ownFlag);
      for (const flag of foreign) {
        expect(resolution.args).not.toContain(flag);
      }

      // …and what IS spawned is the registry's own command, unaltered up to the
      // point where the carrier's flag may be appended.
      const declared = declaredCommand(toolchain);
      const composed = [resolution.cmd, ...resolution.args];
      expect(composed.slice(0, declared.length)).toEqual(declared);
    },
  );

  it('CargoTest_DoesNotReceiveReporterJson', () => {
    const resolution = resolveIntegrationCommand('/governed', undefined, () =>
      registryRuntime(builtin('rust')),
    );
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual(['cargo', 'test']);
    expect(resolution.format.kind).toBe('exit-code-only');
  });

  it('DotnetTest_DoesNotReceiveReporterJson', () => {
    const resolution = resolveIntegrationCommand('/governed', undefined, () =>
      registryRuntime(builtin('dotnet')),
    );
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual(['dotnet', 'test']);
  });
});

// ─── …and no LAYER may smuggle one in either ─────────────────────────────────
//
// The registry is no longer the only thing that can name the command: the
// layered resolver puts an `.exarchos.yml` entry, a user-declared toolchain and
// a committed task runner ahead of it. Quantifying the property over registry
// rows alone would therefore stop covering the composition the gate actually
// runs, so these cases pin the OTHER direction — a foreign runner arriving from
// a higher layer at a repository the registry still identifies as Node.

describe('a command from a higher resolver layer keeps its own carrier', () => {
  it('ConfigDeclaredPytest_AtANodeRepo_GetsNoReporterFlag', () => {
    // `.exarchos.yml` may say `test: pytest` in a tree that also has a
    // package.json. Keying the reporter flag on the DETECTED identity alone
    // would spawn `pytest --reporter=json` — the same unknown-flag failure,
    // re-entered through the resolver rather than the registry.
    const resolution = resolveIntegrationCommand('/governed', undefined, () => ({
      test: 'pytest -q',
      toolchain: builtin('node'),
    }));
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual(['pytest', '-q']);
    expect(resolution.format.kind).toBe('exit-code-only');
    for (const flag of REPORTER_FLAGS) {
      expect(resolution.args).not.toContain(flag);
    }
  });

  it('TaskRunnerCommand_GetsNoReporterFlag', () => {
    const resolution = resolveIntegrationCommand('/governed', undefined, () => ({
      test: 'task test',
      toolchain: builtin('node'),
    }));
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual(['task', 'test']);
    expect(resolution.format.kind).toBe('exit-code-only');
  });

  it.each(['pnpm test', 'yarn test', 'bun run test:run'])(
    'NonNpmNodeCommand_IsSpawnedAsResolved_AndStillRead [%s]',
    (command) => {
      // The false-red this lane closes: a pnpm/yarn/bun repository used to be
      // handed the registry's `npm run test:run` and fail a rung it had no way
      // to clear. The resolved command is spawned as-is, and because it is still
      // a Node script indirection the counted carrier survives.
      const resolution = resolveIntegrationCommand('/governed', undefined, () => ({
        test: command,
        toolchain: builtin('node'),
      }));
      const declared = command.split(' ');
      expect(resolution.kind).toBe('runnable');
      if (resolution.kind !== 'runnable') return;
      const composed = [resolution.cmd, ...resolution.args];
      expect(composed.slice(0, declared.length)).toEqual(declared);
      expect(resolution.format.kind).toBe('vitest-json');
      expect(composed.slice(declared.length)).toEqual(['--', '--reporter=json']);
    },
  );
});

// ─── The rung is clearable on an exit-code runner ────────────────────────────

describe('an exit-code runner produces a complete verdict', () => {
  it('ExitCodeToolchain_ZeroExit_ClearsTheRung', () => {
    const run = runIntegrationSuite({
      repoRoot: '/governed',
      resolveRuntime: () => registryRuntime(builtin('rust')),
      runCommand: () => ({ exitCode: 0, stdout: 'test result: ok. 41 passed', stderr: '' }),
    });
    expect(run.kind).toBe('exit-code');
    if (run.kind !== 'exit-code') return;
    expect(run.passed).toBe(true);
    expect(run.report).toContain('**Result: PASS**');
  });

  it('ExitCodeToolchain_NonZeroExit_FailsTheRung', () => {
    const run = runIntegrationSuite({
      repoRoot: '/governed',
      resolveRuntime: () => registryRuntime(builtin('python')),
      runCommand: () => ({ exitCode: 1, stdout: '1 failed, 40 passed', stderr: '' }),
    });
    expect(run.kind).toBe('exit-code');
    if (run.kind !== 'exit-code') return;
    expect(run.passed).toBe(false);
  });

  it('ExitCodeToolchain_ReportsNoCountsItCouldNotMeasure', () => {
    const run = runIntegrationSuite({
      repoRoot: '/governed',
      resolveRuntime: () => registryRuntime(builtin('go')),
      runCommand: () => ({ exitCode: 0, stdout: 'ok  	example/pkg	0.01s', stderr: '' }),
    });
    expect(run.kind).toBe('exit-code');
    if (run.kind !== 'exit-code') return;
    // A zero here would be a claim, not a measurement: from outside the runner a
    // file that failed to load is indistinguishable from a failed assertion.
    expect(run).not.toHaveProperty('loadFailures');
    expect(run).not.toHaveProperty('failCount');
    expect(run.report).toContain('not reportable on this carrier');
  });
});

// ─── The rung is clearable on a real non-Node repository ─────────────────────

describe('the blocking ladder gate clears on a Rust repository', () => {
  it('RustRepo_GreenSuite_MintsProof', async () => {
    const { tool, argv } = await runGateAt(rustRepo, {
      exitCode: 0,
      stdout: 'test result: ok. 41 passed; 0 failed',
      stderr: '',
    });

    // The spawn is the registry's command, with nothing appended.
    expect(argv).toEqual([['cargo', 'test']]);
    const data = tool.data as Record<string, unknown>;
    expect(data.passed).toBe(true);
    expect(normalizeGateVerdict(tool)).toBe('pass');
  });

  it('RustRepo_RedSuite_ReportsTheFailure', async () => {
    const { tool } = await runGateAt(rustRepo, {
      exitCode: 101,
      stdout: 'test result: FAILED. 3 failed',
      stderr: '',
    });

    const data = tool.data as Record<string, unknown>;
    expect(data.passed).toBe(false);
    expect(normalizeGateVerdict(tool)).toBe('fail');
  });
});

// ─── Indeterminate, in the existing vocabulary ───────────────────────────────

describe('a gate that cannot run says so', () => {
  it('NoToolchain_IsIndeterminate_NotNpmFallback', async () => {
    const { tool, argv } = await runGateAt(emptyRepo, {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    // Nothing was spawned, and in particular not this repository's own script
    // name against a repository that never declared it.
    expect(argv).toEqual([]);
    expect(JSON.stringify(tool.data)).not.toContain('test:run');

    const data = tool.data as Record<string, unknown>;
    expect(data.skipped).toBe(true);
    expect(data.skipReason).toBe('no-toolchain');
    // Neither a failure that was never observed nor proof that was never produced.
    expect(data).not.toHaveProperty('passed');
    expect(normalizeGateVerdict(tool)).toBe('indeterminate');
  });

  it('NoTestCommand_IsIndeterminate_AndCarriesTheResolverSGuidance', () => {
    // A project the registry recognizes for which no layer produced a test
    // command — a Node package with no test script is the everyday case. The
    // gate cannot conclude, and the resolver's own remediation is what a reader
    // can act on, so it is the reason rather than a restatement of the id.
    const run = runIntegrationSuite({
      repoRoot: '/governed',
      resolveRuntime: () => ({
        test: null,
        toolchain: builtin('node'),
        remediation: 'package.json is missing a "test:run" script.',
      }),
      runCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    expect(run.kind).toBe('indeterminate');
    if (run.kind !== 'indeterminate') return;
    expect(run.skipReason).toBe('no-test-command');
    expect(run.reason).toContain('test:run');
    expect(run).not.toHaveProperty('passed');
  });

  it('IndeterminateReport_SaysTheRungIsNotCleared', () => {
    // `passed` is absent, and nothing downstream converts an indeterminate gate
    // verdict into a stop for this gate class — the projection folds the
    // evidence row for visibility only. The report is therefore where the
    // non-clearance has to be stated, or an honest unknown reads as a pass.
    const run = runIntegrationSuite({
      repoRoot: '/governed',
      resolveRuntime: () => ({ test: null, toolchain: undefined }),
      runCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    expect(run.kind).toBe('indeterminate');
    if (run.kind !== 'indeterminate') return;
    expect(run.report).toContain('NOT cleared');
  });

  it('ProjectDeclaredRunner_IsRunAndReadByItsExitCode_NotShutOut', () => {
    // A project that declares its own toolchain in `.exarchos.yml` names a
    // runner the carrier table does not know. That used to be indeterminate,
    // which withheld the rung from every such project; the exit code of the
    // command they declared is a complete verdict, so the gate takes it. What it
    // must NOT do is guess a reporter flag for a runner it cannot identify.
    const custom: Toolchain = {
      id: 'acme-runner',
      projectType: 'Acme',
      markers: [],
      commands: {
        test: 'acme verify',
        typecheck: null,
        install: null,
        mutation: null,
        lint: null,
        contract: null,
      },
    };
    const spawned: string[][] = [];
    const run = runIntegrationSuite({
      repoRoot: '/governed',
      resolveRuntime: () => registryRuntime(custom),
      runCommand: (cmd, args) => {
        spawned.push([cmd, ...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(spawned).toEqual([['acme', 'verify']]);
    for (const flag of REPORTER_FLAGS) {
      expect(spawned[0]).not.toContain(flag);
    }
    expect(run.kind).toBe('exit-code');
    if (run.kind !== 'exit-code') return;
    expect(run.passed).toBe(true);
  });

  it('SpawnFailure_IsIndeterminate_OnBothCarriers', () => {
    // A process that never started produced no evidence about the suite, so
    // neither carrier may read one out of it. The counted carrier used to mint
    // `passed: false` here — a red naming a failure nobody observed, and one the
    // exit-code carrier already refused to name for the same event.
    for (const toolchain of [builtin('node'), builtin('rust')]) {
      const run = runIntegrationSuite({
        repoRoot: '/governed',
        resolveRuntime: () => registryRuntime(toolchain),
        runCommand: () => ({ exitCode: 127, stdout: '', stderr: '', spawnError: 'EINVAL' }),
      });
      expect(run.kind).toBe('indeterminate');
      if (run.kind !== 'indeterminate') continue;
      expect(run.skipReason).toBe('runner-unavailable');
      expect(run).not.toHaveProperty('passed');
    }
  });

  it('MissingBinary_ThroughTheProductionRunner_IsIndeterminate', () => {
    // End to end through the REAL spawn, so the chain is proven rather than
    // assumed link by link: a launch that fails → the errno classifier → the
    // `spawnError` field → an indeterminate verdict. A stub can only assert the
    // last link, and the one that broke was the first — an errno the classifier
    // did not recognize, read as a suite that failed.
    const run = runIntegrationSuite({
      repoRoot: process.cwd(),
      testScript: 'test:run',
      runCommand: (_cmd, _args, options) =>
        execCommandRunner('exarchos-no-such-binary-6f2a91', [], options),
    });
    expect(run.kind).toBe('indeterminate');
    if (run.kind !== 'indeterminate') return;
    expect(run.skipReason).toBe('runner-unavailable');
    expect(run).not.toHaveProperty('passed');
    expect(run.report).toContain('NOT cleared');
  });

  it('HungRunner_YieldsIndeterminate', () => {
    // The PRODUCTION runner against a real child process that never exits: the
    // kill path is proven, not stubbed. The bound is overridden so the case
    // costs half a second instead of the production wall clock.
    const run = runIntegrationSuite({
      repoRoot: process.cwd(),
      testScript: 'test:run',
      runCommand: (_cmd, _args, options) =>
        execCommandRunner(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
          ...options,
          timeoutMs: 500,
        }),
    });
    expect(run.kind).toBe('indeterminate');
    if (run.kind !== 'indeterminate') return;
    expect(run.skipReason).toBe('runner-timeout');
    expect(run.report).toContain('INDETERMINATE');
  });
});

// ─── The Node path is untouched ──────────────────────────────────────────────

describe('VitestRepo_BehaviourUnchanged', () => {
  const GREEN = JSON.stringify({
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numTotalTests: 42,
    testResults: [],
  });

  /** The #1329 shape: one suite failed, zero tests failed. */
  const LOAD_CASCADE = JSON.stringify({
    numFailedTestSuites: 1,
    numFailedTests: 0,
    numTotalTests: 50,
    testResults: [{ name: '/repo/src/broken.test.ts', status: 'failed', assertionResults: [] }],
  });

  it('ThisRepo_StillResolvesTheVitestJsonCommand', () => {
    const resolution = resolveIntegrationCommand(process.cwd(), undefined);
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect(resolution.cmd).toBe('npm');
    expect(resolution.args).toEqual(['run', 'test:run', '--', '--reporter=json']);
  });

  it('ThisRepo_GreenRun_StillParsesToPass', () => {
    const run = runIntegrationSuite({
      repoRoot: process.cwd(),
      runCommand: () => ({ exitCode: 0, stdout: GREEN, stderr: '' }),
    });
    expect(run.kind).toBe('vitest-counts');
    if (run.kind !== 'vitest-counts') return;
    expect(run.passed).toBe(true);
    expect(run.totalTests).toBe(42);
    expect(run.parseError).toBe(false);
  });

  it('ThisRepo_LoadCascade_StillFoldsIntoTheFailureCount', () => {
    const run = runIntegrationSuite({
      repoRoot: process.cwd(),
      runCommand: () => ({ exitCode: 1, stdout: LOAD_CASCADE, stderr: '' }),
    });
    expect(run.kind).toBe('vitest-counts');
    if (run.kind !== 'vitest-counts') return;
    expect(run.passed).toBe(false);
    expect(run.loadFailures).toBe(1);
    expect(run.failCount).toBe(1);
  });

  it('ThisRepo_UnparseableOutput_StillFailsClosed', () => {
    const run = runIntegrationSuite({
      repoRoot: process.cwd(),
      runCommand: () => ({ exitCode: 0, stdout: 'not vitest json', stderr: '' }),
    });
    expect(run.kind).toBe('vitest-counts');
    if (run.kind !== 'vitest-counts') return;
    expect(run.passed).toBe(false);
    expect(run.parseError).toBe(true);
  });
});
