/**
 * Tests that `prepare_synthesis` gets `repoRoot` through the production path.
 *
 * `team/prepare-synthesis.test.ts` calls `handlePrepareSynthesis` directly, so it cannot see what `dispatch()` does to the args.
 * `dispatch()` gives the handler only the keys that the parsed action schema keeps.
 * Thus the action schema must declare `repoRoot`, or no production call reaches the handler with it.
 *
 * Each case here runs through `dispatch()` with no verifier provisioning. The lifecycle check of the local executor is a stub that records each request.
 * The stack and changed-file legs read a real Git fixture through the constrained reader with the Git executable on PATH.
 * The mock stubs `execSync` and `execFileSync`, so no leg can start a plain process unseen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(() => Buffer.from('Tests: 3 passed, 0 failed')),
    execFileSync: vi.fn(() => Buffer.from('src/touched.ts\n')),
  };
});

vi.mock('../../../src/verbs/verification/lifecycle-check.js', () => {
  const run = { argv: ['leg'], end: 'exited' as const, exitCode: 0, stdout: 'Tests: 3 passed, 0 failed', stderr: '' };
  return {
    admitLifecycleLegs: vi.fn(async () => [{ name: 'test', kind: 'command', run }, { name: 'typecheck', kind: 'typecheck', run }]),
  };
});

import { execSync, execFileSync } from 'node:child_process';

import { EventStore } from '../../../src/events/store.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { dispatch } from '../../../src/dispatch/core/dispatch.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../tools/test-helpers/trusted-context.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import { admitLifecycleLegs } from '../../../src/verbs/verification/lifecycle-check.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';

/** The absolute real path of the Git executable on the test process PATH. */
function gitExecutable(): string {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch {}
  }
  throw new Error('The fixture needs Git on PATH');
}

const GIT = gitExecutable();

/** Fixture Git with a fixed identity and no global or system configuration. */
async function fixtureGit(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(GIT, args, {
    cwd,
    timeout: 30_000,
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
}

describe('prepare_synthesis production path (DR-8 / #1756)', () => {
  const cleanups: Array<() => void> = [];
  let ctx: DispatchContext;
  let repoRoot: string;
  let openStore: EventStore | undefined;

  const FEATURE_ID = 'feat-prepare-synthesis-prodpath';

  /**
   * The repo root is a temporary Git checkout and not `process.cwd()`. The task branch adds one commit after `main`.
   * No tasks are seeded, so the task-completion check passes and the handler runs every leg.
   */
  beforeEach(async () => {
    vi.clearAllMocks();
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ps-prodpath-state-'));
    cleanups.push(() => rmrf(stateDir));
    repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ps-prodpath-repo-')));
    cleanups.push(() => rmrf(repoRoot));
    writeFileSync(path.join(repoRoot, '.exarchos.yml'), "test: 'vitest run'\ntypecheck: 'tsc --noEmit'\n");
    await fixtureGit(repoRoot, 'init', '-q', '-b', 'main');
    await fixtureGit(repoRoot, 'add', '.');
    await fixtureGit(repoRoot, 'commit', '-q', '-m', 'base');
    await fixtureGit(repoRoot, 'checkout', '-q', '-b', 'task');
    mkdirSync(path.join(repoRoot, 'src'));
    writeFileSync(path.join(repoRoot, 'src', 'touched.ts'), 'export {};\n');
    await fixtureGit(repoRoot, 'add', '.');
    await fixtureGit(repoRoot, 'commit', '-q', '-m', 'touch the source');

    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    openStore = eventStore;
    await seedActivePhaseAttempt(eventStore, FEATURE_ID, { phase: 'synthesize' });
    ctx = withTrustedCaller({
      stateDir,
      eventStore,
      enableTelemetry: false,
    } as DispatchContext);
  });

  /**
   * Closes the SQLite handle before the cleanups run, because `cleanups` removes `stateDir` first.
   * On Windows, an open handle makes the removal fail with EBUSY. On Linux, the unlink succeeds with an open handle.
   */
  afterEach(async () => {
    try {
      await openStore?.close();
    } catch {
    }
    openStore = undefined;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
  });

  /**
   * Without the schema field, `repoRoot` does not reach the handler, and no leg runs.
   * The test checks each named leg by its command and the Git legs by their result. So a missing leg cannot pass on the count alone.
   */
  it('ProductionPath_DispatchWithRepoRoot_EveryLegRunsAgainstThatRoot', async () => {
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'prepare_synthesis', featureId: FEATURE_ID, repoRoot },
      ctx,
    );

    expect(result.error?.code, JSON.stringify(result.error)).toBeUndefined();
    expect(result.success).toBe(true);

    const requests = vi.mocked(admitLifecycleLegs).mock.calls.map(([input]) => input);
    expect(requests.map((input) => input.checkout)).toEqual([repoRoot]);
    expect(requests[0]?.legs).toEqual([{ kind: 'command', argv: ['vitest', 'run'] }, { kind: 'typecheck', argv: ['tsc', '--noEmit'] }]);
    expect(repoRoot).not.toBe(process.cwd());

    const data = result.data as { stack: { healthy: boolean; branches: string[] }; tests: { passed: boolean }; typecheck: { passed: boolean } };
    expect(data.tests.passed).toBe(true);
    expect(data.typecheck.passed).toBe(true);
    expect(data.stack.healthy).toBe(true);
    expect(data.stack.branches).toHaveLength(1);
    expect(data.stack.branches[0]).toContain('touch the source');
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  /**
   * The action schema requires `repoRoot`, so `dispatch()` rejects a call without it before the gate runner starts.
   * Thus no leg runs, and no evidence row exists for a gate that did not run.
   */
  it('ProductionPath_DispatchWithoutRepoRoot_RefusedBeforeAnyLegSpawns', async () => {
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'prepare_synthesis', featureId: FEATURE_ID },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/repoRoot/i);
    expect(admitLifecycleLegs).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();

    const evidence = await ctx.eventStore.query(FEATURE_ID, {
      type: 'admission.evidence-recorded',
    });
    expect(evidence).toEqual([]);
  });

  /** The kill-probe target. When `repoRoot` leaves the action schema, this test and the first dispatch test in this file both fail. */
  it('ActionSchema_DeclaresRepoRoot_AsRequiredString', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    const action = orchestrate?.actions.find((a) => a.name === 'prepare_synthesis');
    expect(action, 'prepare_synthesis must exist in the registry').toBeDefined();

    const field = (action!.schema as { shape: Record<string, { isOptional(): boolean }> })
      .shape.repoRoot;
    expect(field, 'prepare_synthesis must declare repoRoot').toBeDefined();
    expect(field.isOptional(), 'repoRoot must be REQUIRED, not optional').toBe(false);
  });
});
