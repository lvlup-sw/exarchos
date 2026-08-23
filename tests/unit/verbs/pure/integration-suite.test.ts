// ─── Integration suite: command resolution, carriers and wall clock ──────────
//
// The gate resolves the two halves of its invocation from two authorities — the
// COMMAND from the layered test-runtime resolver, and how to READ its result
// from the registry's carrier table. These cases pin the seams between them:
// which argv is composed, which outcome each carrier can honestly produce, and
// what happens when the runner never reaches a conclusion.
//
// The per-toolchain property ("no toolchain receives another toolchain's
// reporter flag", quantified over the live registry) lives in the acceptance
// tier beside the end-to-end gate cases.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const runCommandSyncSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/utils/process.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/utils/process.js')>();
  return { ...actual, runCommandSync: runCommandSyncSpy };
});

import type { Toolchain } from '../../../../src/config/toolchains.js';
import {
  execCommandRunner,
  isTimeoutFailure,
  INTEGRATION_SUITE_TIMEOUT_MS,
} from '../../../../src/verbs/gates/check-integration-suite.js';
import {
  resolveIntegrationCommand,
  resolveIntegrationRuntime,
  runIntegrationSuite,
  type IntegrationCommandResult,
  type IntegrationRuntime,
} from '../../../../src/verbs/pure/integration-suite.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A toolchain double: `id` decides which carrier row the registry offers. */
function toolchain(id: string, test: string | null): Toolchain {
  return {
    id,
    projectType: id,
    markers: [],
    commands: { test, typecheck: null, install: null, mutation: null, lint: null, contract: null },
  };
}

/**
 * A resolved runtime double. ONE value carries both halves, mirroring the seam,
 * so a case cannot accidentally describe a repository whose command and identity
 * disagree — a shape the shipped composition never produces.
 */
function runtime(id: string | null, test: string | null): IntegrationRuntime {
  return { test, toolchain: id === null ? undefined : toolchain(id, test) };
}

/** Scratch repositories for the cases that exercise the REAL layered resolver. */
const scratchRoots: string[] = [];

function scratchRepo(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'integration-suite-resolver-'));
  scratchRoots.push(root);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, name), body, 'utf-8');
  }
  return root;
}

afterAll(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const GREEN_JSON = JSON.stringify({
  numFailedTestSuites: 0,
  numFailedTests: 0,
  numTotalTests: 7,
  testResults: [],
});

function returning(result: Partial<IntegrationCommandResult>) {
  return () => ({ exitCode: 0, stdout: '', stderr: '', ...result });
}

// ─── Command resolution ──────────────────────────────────────────────────────

describe('resolveIntegrationCommand', () => {
  it('ExplicitScript_TakesPrecedenceAndKeepsTheReporterFlag', () => {
    const resolution = resolveIntegrationCommand('/repo', 'my:test', () =>
      runtime('rust', 'cargo test'),
    );
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect(resolution.cmd).toBe('npm');
    expect(resolution.args).toEqual(['run', 'my:test', '--', '--reporter=json']);
  });

  it('ScriptRunner_PutsTheReporterFlagAfterThePassthrough', () => {
    const resolution = resolveIntegrationCommand('/repo', undefined, () =>
      runtime('node', 'npm run ws:test'),
    );
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual([
      'npm',
      'run',
      'ws:test',
      '--',
      '--reporter=json',
    ]);
  });

  it('NonPackageManagerCommand_AtANodeRepo_IsSpawnedUnaltered', () => {
    // Contract CHANGED with the layered resolver. The reporter flag used to be
    // appended to any command a vitest-JSON toolchain produced, on the reasoning
    // that a `node` row means a vitest runner. That reasoning holds only while
    // the registry is the sole source of the command; now that an `.exarchos.yml`
    // entry or a task runner outranks it, the head token is the only evidence of
    // WHICH runner is being launched. Anything that is not a Node package
    // manager is spawned exactly as resolved and read by its exit code — the
    // sound floor, never an unknown flag.
    const resolution = resolveIntegrationCommand('/repo', undefined, () =>
      runtime('node', 'vitest run'),
    );
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual(['vitest', 'run']);
    expect(resolution.format.kind).toBe('exit-code-only');
  });

  it('ExitCodeToolchain_IsSpawnedExactlyAsDeclared', () => {
    const resolution = resolveIntegrationCommand('/repo', undefined, () =>
      runtime('go', 'go test ./...'),
    );
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual(['go', 'test', './...']);
    expect(resolution.format.kind).toBe('exit-code-only');
  });

  it('NoToolchain_IsUnrunnable_NotAnNpmFallback', () => {
    const resolution = resolveIntegrationCommand('/repo', undefined, () => runtime(null, null));
    expect(resolution.kind).toBe('unrunnable');
    if (resolution.kind !== 'unrunnable') return;
    expect(resolution.skipReason).toBe('no-toolchain');
    // The old fallback spawned THIS repository's script name at any repository
    // that failed detection. Nothing may name it here.
    expect(JSON.stringify(resolution)).not.toContain('test:run');
  });

  it('ProjectWithNoResolvedTestCommand_IsUnrunnable', () => {
    // Fixture RE-POINTED, behaviour unchanged: the null now sits on the resolved
    // runtime rather than on a registry row, because the resolver — not the
    // registry — is what can fail to produce a command in the shipped path.
    const resolution = resolveIntegrationCommand('/repo', undefined, () => runtime('go', null));
    expect(resolution.kind).toBe('unrunnable');
    if (resolution.kind !== 'unrunnable') return;
    expect(resolution.skipReason).toBe('no-test-command');
  });

  it('ResolverRemediation_IsTheReason_NotARestatementOfTheId', () => {
    const resolution = resolveIntegrationCommand('/repo', undefined, () => ({
      test: null,
      toolchain: toolchain('node', 'npm run test:run'),
      remediation: 'package.json is missing a "test:run" script.',
    }));
    expect(resolution.kind).toBe('unrunnable');
    if (resolution.kind !== 'unrunnable') return;
    expect(resolution.reason).toBe('package.json is missing a "test:run" script.');
  });

  it('AThrowingResolver_IsUnrunnable_NotACrash', () => {
    // An unreadable or schema-invalid `.exarchos.yml` throws inside the layered
    // resolver. A gate that dies takes its whole runbook step with it and says
    // less than one that reports it could not resolve a command.
    const resolution = resolveIntegrationCommand('/repo', undefined, () => {
      throw new Error('.exarchos.yml: unexpected token');
    });
    expect(resolution.kind).toBe('unrunnable');
    if (resolution.kind !== 'unrunnable') return;
    expect(resolution.skipReason).toBe('no-test-command');
    expect(resolution.reason).toContain('unexpected token');
  });

  it('UnknownToolchainId_IsRunnable_OnTheExitCodeCarrier', () => {
    // Contract CHANGED. A project declaring its own toolchain in `.exarchos.yml`
    // used to be `unrunnable`, which withheld a blocking rung from every such
    // project on the grounds that its carrier is unknown. Unknown carrier means
    // "ask for nothing and read the exit code", which is sound for any
    // executable — not "refuse to run".
    const resolution = resolveIntegrationCommand('/repo', undefined, () =>
      runtime('acme-runner', 'acme verify'),
    );
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual(['acme', 'verify']);
    expect(resolution.format.kind).toBe('exit-code-only');
  });
});

// ─── The command really does come from the LAYERED resolver ──────────────────
//
// The seam above is a double; these cases run the shipped `resolveIntegrationRuntime`
// against real directories, because "routes through the layered resolver" is a
// claim about the default composition and a double cannot witness it.

describe('resolveIntegrationRuntime (the shipped seam)', () => {
  it('PnpmRepo_ResolvesPnpm_NotTheRegistrySNpmBaseline', () => {
    // The false red this lane exists to close: the registry's node row declares
    // `npm run test:run`, so every pnpm/yarn/bun repository was handed a command
    // it does not have. The package-manager tier lives in the resolver, and the
    // gate can only see it by asking the resolver.
    const repo = scratchRepo({
      'package.json': JSON.stringify({ name: 'governed', scripts: { test: 'vitest run' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    });
    expect(resolveIntegrationRuntime(repo).test).toBe('pnpm test');

    const resolution = resolveIntegrationCommand(repo, undefined);
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual([
      'pnpm',
      'test',
      '--',
      '--reporter=json',
    ]);
  });

  it('ConfigDeclaredCommand_OutranksTheRegistryRow', () => {
    // `.exarchos.yml` sits above the built-in registry in the layered order. A
    // gate reading `commands.test` off the detected toolchain never saw it.
    const repo = scratchRepo({
      'Cargo.toml': '[package]\nname = "governed"\n',
      '.exarchos.yml': 'test: cargo nextest run\n',
    });
    expect(resolveIntegrationRuntime(repo).test).toBe('cargo nextest run');

    const resolution = resolveIntegrationCommand(repo, undefined);
    expect(resolution.kind).toBe('runnable');
    if (resolution.kind !== 'runnable') return;
    expect([resolution.cmd, ...resolution.args]).toEqual(['cargo', 'nextest', 'run']);
  });

  it('NodeRepoWithNoTestScript_ProducesTheNoTestCommandArm', () => {
    // The arm exists because the SHIPPED composition reaches it, not because a
    // double can be pointed at it: the layered resolver refuses a Node package
    // with no test script, where reading `commands.test` off the registry row
    // would have handed back `npm run test:run` and spawned a script the
    // repository does not have.
    const repo = scratchRepo({
      'package.json': JSON.stringify({ name: 'governed', scripts: { build: 'tsc' } }),
      'package-lock.json': JSON.stringify({ name: 'governed', lockfileVersion: 3 }),
    });
    const resolution = resolveIntegrationCommand(repo, undefined);
    expect(resolution.kind).toBe('unrunnable');
    if (resolution.kind !== 'unrunnable') return;
    expect(resolution.skipReason).toBe('no-test-command');
    expect(resolution.reason).toContain('test:run');
  });

  it('UnrecognizedDirectory_ResolvesNothing_AndNamesNoCommand', () => {
    const repo = scratchRepo({ 'README.md': '# nothing here\n' });
    const resolved = resolveIntegrationRuntime(repo);
    expect(resolved.test).toBeNull();
    expect(resolved.toolchain).toBeUndefined();

    const resolution = resolveIntegrationCommand(repo, undefined);
    expect(resolution.kind).toBe('unrunnable');
    if (resolution.kind !== 'unrunnable') return;
    expect(resolution.skipReason).toBe('no-toolchain');
  });
});

// ─── What each carrier can honestly conclude ─────────────────────────────────

describe('runIntegrationSuite carriers', () => {
  it('UnrunnableCommand_NeverSpawnsAnything', () => {
    const runCommand = vi.fn(returning({}));
    const run = runIntegrationSuite({
      repoRoot: '/repo',
      runCommand,
      resolveRuntime: () => runtime(null, null),
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(run.kind).toBe('indeterminate');
  });

  it('ExitCodeCarrier_SpawnFailure_IsIndeterminate_NotAFailedSuite', () => {
    // The exit code of a process that never started is not a verdict about a
    // suite that never ran.
    const run = runIntegrationSuite({
      repoRoot: '/repo',
      resolveRuntime: () => runtime('rust', 'cargo test'),
      runCommand: returning({ exitCode: 127, spawnError: 'ENOENT' }),
    });
    expect(run.kind).toBe('indeterminate');
    if (run.kind !== 'indeterminate') return;
    expect(run.skipReason).toBe('runner-unavailable');
  });

  it('VitestCarrier_SpawnFailure_IsIndeterminateToo_NotAFailedSuite', () => {
    // Contract CHANGED. This carrier used to fail CLOSED on a spawn failure and
    // mint `passed: false` — a red naming a failure nobody observed, for the
    // very same event the exit-code carrier already refused to name. Failing
    // closed is right for a runner that RAN and garbled its report; it is not a
    // reading of a process that never started.
    const run = runIntegrationSuite({
      repoRoot: '/repo',
      resolveRuntime: () => runtime('node', 'npm run test:run'),
      runCommand: returning({ exitCode: 127, spawnError: 'ENOENT' }),
    });
    expect(run.kind).toBe('indeterminate');
    if (run.kind !== 'indeterminate') return;
    expect(run.skipReason).toBe('runner-unavailable');
    expect(run.reason).toContain('ENOENT');
    expect(run).not.toHaveProperty('passed');
  });

  it('VitestCarrier_RanButGarbled_StillFailsClosed', () => {
    // The other half of the split above, kept explicit so the change is a
    // NARROWING of the fail-closed rule rather than its removal: a runner that
    // ran and returned zero with unreadable output is still a finding, because a
    // clean exit is compatible with a crashed reporter.
    const run = runIntegrationSuite({
      repoRoot: '/repo',
      resolveRuntime: () => runtime('node', 'npm run test:run'),
      runCommand: returning({ exitCode: 0, stdout: 'certainly not json' }),
    });
    expect(run.kind).toBe('vitest-counts');
    if (run.kind !== 'vitest-counts') return;
    expect(run.passed).toBe(false);
    expect(run.parseError).toBe(true);
    expect(run.failCount).toBeGreaterThanOrEqual(1);
  });

  it('VitestCarrier_GreenJson_ParsesTheCounts', () => {
    const run = runIntegrationSuite({
      repoRoot: '/repo',
      resolveRuntime: () => runtime('node', 'npm run test:run'),
      runCommand: returning({ stdout: GREEN_JSON }),
    });
    expect(run.kind).toBe('vitest-counts');
    if (run.kind !== 'vitest-counts') return;
    expect(run.passed).toBe(true);
    expect(run.totalTests).toBe(7);
  });

  it('ExitCodeCarrier_DoesNotParseStdout', () => {
    // Whatever a non-vitest runner prints, the exit code is the verdict — the
    // gate must not try to read counts out of it and must not fail closed for
    // failing to.
    const run = runIntegrationSuite({
      repoRoot: '/repo',
      resolveRuntime: () => runtime('python', 'pytest'),
      runCommand: returning({ exitCode: 0, stdout: '===== 12 passed in 0.4s =====' }),
    });
    expect(run.kind).toBe('exit-code');
    if (run.kind !== 'exit-code') return;
    expect(run.passed).toBe(true);
  });
});

// ─── The wall clock ──────────────────────────────────────────────────────────

describe('a runner that never finishes', () => {
  it('TimedOutRunner_IsIndeterminate_OnTheExitCodeCarrier', () => {
    const run = runIntegrationSuite({
      repoRoot: '/repo',
      resolveRuntime: () => runtime('rust', 'cargo test'),
      runCommand: returning({ exitCode: 124, timedOut: true }),
    });
    expect(run.kind).toBe('indeterminate');
    if (run.kind !== 'indeterminate') return;
    expect(run.skipReason).toBe('runner-timeout');
  });

  it('TimedOutRunner_IsIndeterminate_OnTheVitestCarrier', () => {
    // Truncated stdout would otherwise be read as a garbled reporter and fail
    // closed, naming a failure nobody observed.
    const run = runIntegrationSuite({
      repoRoot: '/repo',
      resolveRuntime: () => runtime('node', 'npm run test:run'),
      runCommand: returning({ exitCode: 124, stdout: '{"numFailedTests"', timedOut: true }),
    });
    expect(run.kind).toBe('indeterminate');
    if (run.kind !== 'indeterminate') return;
    expect(run.skipReason).toBe('runner-timeout');
  });

  it('TimeoutIsDeclared_NotDefaulted', () => {
    runCommandSyncSpy.mockReset();
    runCommandSyncSpy.mockReturnValue('');
    execCommandRunner('cargo', ['test'], { cwd: '/repo' });

    expect(runCommandSyncSpy).toHaveBeenCalledTimes(1);
    const options = runCommandSyncSpy.mock.calls[0]?.[2] as { timeout?: number } | undefined;
    // `execFileSync` has no default timeout: unstated means unbounded.
    expect(options?.timeout).toBe(INTEGRATION_SUITE_TIMEOUT_MS);
    expect(INTEGRATION_SUITE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('TimeoutClassification_SeparatesAKillFromAnExitAndFromAMissingCommand', () => {
    expect(isTimeoutFailure({ code: 'ETIMEDOUT' })).toBe(true);
    // A process that exited carries a numeric status — it decided something.
    expect(isTimeoutFailure({ code: 'ETIMEDOUT', status: 1 })).toBe(false);
    // A command that does not exist is unavailable, not slow.
    expect(isTimeoutFailure({ code: 'ENOENT' })).toBe(false);
    expect(isTimeoutFailure({})).toBe(false);
  });
});
