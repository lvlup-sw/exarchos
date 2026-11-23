// Tests for the `check_test_adequacy` handler. The tests dispatch through the composite
// `handleOrchestrate` router. A registered action without a dispatch branch returns UNKNOWN_ACTION,
// and a direct handler test cannot see that.
// The pure `runProbe` is a mock, so the probe runs no real test command. The durable gate producer is
// a stub that calls only the provider. The diff cases read real Git repositories through the constrained reader.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockRunProbe = vi.fn();
vi.mock('../../../../src/verbs/gates/test-adequacy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/test-adequacy.js')>();
  return { ...actual, runProbe: (...args: unknown[]) => mockRunProbe(...args) };
});

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/durable-gate-producer.js')>();
  return {
    ...actual,
    runDurableGateProducer: (_scope: unknown, executeProvider: () => Promise<unknown>) => executeProvider(),
  };
});

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { DEFAULTS } from '../../../../src/config/resolve.js';
import { normalizeGateVerdict, SKIPPED_BY_POLICY } from '../../../../src/verbs/gates/gate-utils.js';
import {
  ADEQUACY_DISCRIMINANTS,
  probeNotRun,
  type AdequacyDiscriminant,
} from '../../../../src/verbs/gates/test-adequacy.js';
import { handleTestAdequacy, readTaskDiff } from '../../../../src/verbs/gates/test-adequacy-handler.js';
import { probeTestEnvironment } from '../../../../src/verbs/verification/check-executor.js';
import { STORE_LOCATION_ENV_KEYS } from '../../../../src/utils/paths.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { fakeExecutor } from '../../../helpers/verification/check-executor.js';

/** Run one Git command in a repository and return its trimmed output. */
async function git(repoRoot: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 })).trim();
}

/** Write each file under the root and commit them on the current branch. */
async function commitFiles(repoRoot: string, files: Readonly<Record<string, string>>, message: string): Promise<string> {
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
    writeFileSync(path.join(repoRoot, file), body);
  }
  await git(repoRoot, 'add', '-A');
  await git(repoRoot, 'commit', '-q', '-m', message);
  return git(repoRoot, 'rev-parse', 'HEAD');
}

/** A new repository with one base commit on `main`. */
async function baseRepository(): Promise<string> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'test-adequacy-handler-repo-'));
  await git(repoRoot, 'init', '-q', '--initial-branch=main');
  await git(repoRoot, 'config', 'user.email', 'test@example.com');
  await git(repoRoot, 'config', 'user.name', 'Test');
  await git(repoRoot, 'config', 'commit.gpgsign', 'false');
  await commitFiles(repoRoot, { 'src/b.js': 'export const b = 1;\n', 'test/old.test.js': '// old\n' }, 'base');
  return repoRoot;
}

function passResult() {
  return {
    passed: true,
    probedTests: ['src/calc.test.js'],
    redObserved: true,
    restoredClean: true,
  };
}

describe('check_test_adequacy routing + idempotency (task 014)', () => {
  const stateDirs: string[] = [];

  beforeEach(() => {
    mockRunProbe.mockReset();
    mockRunProbe.mockResolvedValue(passResult());
  });

  afterEach(() => {
    for (const d of stateDirs.splice(0)) {
      try {
        rmrf(d);
      } catch {
      }
    }
  });

  async function makeCtx(): Promise<DispatchContext> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'test-adequacy-handler-'));
    stateDirs.push(stateDir);
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return { stateDir, eventStore, enableTelemetry: false } as DispatchContext;
  }

  it('HandleOrchestrate_CheckTestAdequacy_RoutesToHandler', async () => {
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-x',
        taskId: 'T-01',
        branch: 'feature/x',
        repoRoot: '/fake/repo',
        baseBranch: 'main',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
    expect(mockRunProbe).toHaveBeenCalledOnce();
  });

  /**
   * The orchestrate registration must not throw at MCP startup. A field collision, the same name with a
   * different base type, makes `buildRegistrationSchema` throw.
   */
  it('CheckTestAdequacy_Registration_DoesNotThrow', async () => {
    const { TOOL_REGISTRY, buildRegistrationSchema } = await import('../../../../src/registry.js');
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();
    expect(orchestrate!.actions.some((a) => a.name === 'check_test_adequacy')).toBe(true);
    expect(() => buildRegistrationSchema(orchestrate!.actions)).not.toThrow();
  });

  /**
   * When the probe finds no new or changed tests, it returns an advisory pass with the no-new-tests
   * discriminant. The handler must show that verdict and its report, not a blocking `passed: false`.
   */
  it('CheckTestAdequacy_NoNewTests_SkippedAdvisory_PassedTrue', async () => {
    const ctx = await makeCtx();
    mockRunProbe.mockResolvedValue({
      passed: true,
      probedTests: [],
      redObserved: false,
      restoredClean: true,
      discriminant: 'no-new-tests',
      report: 'nothing to probe — task adds no tests',
    });

    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-nonew',
        taskId: 'T-nonew',
        repoRoot: '/fake/repo',
        baseBranch: 'main',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; discriminant?: string; report?: string };
    expect(data.passed).toBe(true);
    expect(data.discriminant).toBe('no-new-tests');
    expect(data.report).toContain('nothing to probe');
  });

  /**
   * A failing ladder gate in a oneshot workflow resolves to a warning that does not block. Dispatch reads
   * `workflowType` from the event store, and `projectConfig` turns on the config-aware severity.
   * The test checks the gate name and success, not the reason text, which depends on severity and mode.
   */
  it('HandleOrchestrate_OneshotTestAdequacyFailure_ResolvesAdvisory', async () => {
    const ctx = await makeCtx();

    await ctx.eventStore.append('feat-oneshot', {
      type: 'workflow.started',
      data: { featureId: 'feat-oneshot', workflowType: 'oneshot' },
    });

    mockRunProbe.mockResolvedValue({
      passed: false,
      probedTests: ['src/calc.test.js'],
      redObserved: false,
      restoredClean: true,
      report: 'vacuous test survived mutation',
    });

    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-oneshot',
        taskId: 'T-oneshot',
        repoRoot: '/fake/repo',
        baseBranch: 'main',
      },
      { ...ctx, projectConfig: DEFAULTS } as DispatchContext,
    );

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Gate 'check_test_adequacy' failed"),
      ]),
    );
  });

  /** The durable runner owns idempotency, so the provider path appends no `gate.executed` row of its own. */
  it('GateEvent_MigratedPath_DoesNotEmitLegacyGateEvent', async () => {
    const ctx = await makeCtx();

    const args = {
      action: 'check_test_adequacy',
      featureId: 'feat-idem',
      taskId: 'T-02',
      branch: 'feature/idem',
      repoRoot: '/fake/repo',
      baseBranch: 'main',
      operationId: 'op-fixed-123',
    };

    await handleOrchestrate({ ...args }, ctx);
    await handleOrchestrate({ ...args }, ctx);

    const events = await ctx.eventStore.query('feat-idem');
    const gateEvents = events.filter(
      (e) =>
        e.type === 'gate.executed' &&
        (e.data as { gateName?: string }).gateName === 'test-adequacy',
    );
    expect(gateEvents).toHaveLength(0);
  });

  it('CheckTestAdequacy_NoBase_IsBaseMissingAndBlocksAtEveryTier', async () => {
    const ctx = await makeCtx();
    for (const riskTier of [undefined, 'low', 'medium', 'high'] as const) {
      const result = await handleOrchestrate(
        {
          action: 'check_test_adequacy',
          featureId: 'feat-nobase',
          taskId: 'T-nobase',
          repoRoot: '/fake/repo',
          ...(riskTier !== undefined ? { riskTier } : {}),
        },
        ctx,
      );
      expect(result.success, String(riskTier)).toBe(true);
      const data = result.data as { passed: boolean; discriminant?: string; report?: string; skipped?: boolean };
      expect(data.passed, String(riskTier)).toBe(false);
      expect(data.discriminant, String(riskTier)).toBe('base-missing');
      expect(data.skipped, String(riskTier)).toBeUndefined();
      expect(data.report, String(riskTier)).toContain('baseBranch');
    }
    expect(mockRunProbe).not.toHaveBeenCalled();
  });

  it('CheckTestAdequacy_APolicySkippedGate_StillSkipsWithNoBase', async () => {
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-skip-nobase',
        taskId: 'T-skip',
        repoRoot: '/fake/repo',
        riskTier: 'low',
        boundaryTouching: false,
      },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; discriminant?: string; skipped?: boolean };
    expect(data.discriminant).toBe(SKIPPED_BY_POLICY);
    expect(data.skipped).toBe(true);
    expect(data.passed).toBe(true);
    expect(mockRunProbe).not.toHaveBeenCalled();
  });

  /** The merge base of the caller base and the task head gives the diff and the base of the reverted image. A later commit on the base changes neither. */
  it('CheckTestAdequacy_TheMergeBase_IsResolvedOnceAndMeasuresBothTheDiffAndTheRevert', async () => {
    const ctx = await makeCtx();
    const repoRoot = await baseRepository();
    stateDirs.push(repoRoot);
    await git(repoRoot, 'checkout', '-q', '-b', 'feature/x');
    const fork = await commitFiles(repoRoot, { 'docs/x.md': 'x\n' }, 'feature x');
    await git(repoRoot, 'checkout', '-q', '-b', 'task-2');
    await git(repoRoot, 'rm', '-q', 'test/old.test.js');
    await commitFiles(repoRoot, { 'src/b.js': 'export const b = 2;\n', 'test/b.test.js': '// pins b\n' }, 'task');
    await git(repoRoot, 'checkout', '-q', 'feature/x');
    await commitFiles(repoRoot, { 'docs/later.md': 'later\n' }, 'later base commit');
    await git(repoRoot, 'checkout', '-q', 'task-2');

    const diff = await readTaskDiff(repoRoot, { kind: 'base', baseRef: 'feature/x', branch: 'task-2' });
    expect(diff).toMatchObject({ ok: true, base: fork });
    const fake = fakeExecutor(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    await handleTestAdequacy(
      {
        featureId: 'feat-mergebase',
        taskId: 'T-mb',
        branch: 'task-2',
        baseBranch: 'feature/x',
        repoRoot,
        riskTier: 'medium',
      },
      ctx.stateDir,
      ctx.eventStore,
      fake.executor,
    );
    expect(mockRunProbe).toHaveBeenCalledOnce();
    expect(mockRunProbe.mock.calls[0]?.[0]).toMatchObject({
      changedFiles: ['src/b.js', 'test/b.test.js', 'test/old.test.js'],
      deletedFiles: ['test/old.test.js'],
    });
    for (const request of fake.requests) expect(request.revert).toEqual({ base: fork, sources: ['src/b.js'] });
  });

  /** A diff that cannot be read is a diff failure, not an empty list of changed files. */
  it('CheckTestAdequacy_ADiffThatCannotBeRead_IsADiffFailure', async () => {
    const ctx = await makeCtx();
    const notARepository = mkdtempSync(path.join(os.tmpdir(), 'test-adequacy-handler-none-'));
    stateDirs.push(notARepository);
    await handleTestAdequacy(
      {
        featureId: 'feat-unparsed-diff',
        taskId: 'T-unparsed',
        baseBranch: 'feature/x',
        repoRoot: notARepository,
        riskTier: 'medium',
      },
      ctx.stateDir,
      ctx.eventStore,
    );
    expect(mockRunProbe).toHaveBeenCalledOnce();
    expect(mockRunProbe.mock.calls[0]?.[0]).toMatchObject({ diffFailed: true, changedFiles: [] });
  });

  /** A base that Git reads as an option refuses before any Git read of it. A branch that is not the checkout branch refuses too. */
  it('CheckTestAdequacy_ARefGitWouldReadAsAnOption_NeverReachesGit', async () => {
    const ctx = await makeCtx();
    const repoRoot = await baseRepository();
    stateDirs.push(repoRoot);
    for (const [baseBranch, branch] of [['--output=/tmp/x', 'main'], ['main', '--all']]) {
      await handleTestAdequacy(
        {
          featureId: 'feat-unsafe-ref',
          taskId: 'T-unsafe',
          branch,
          baseBranch,
          repoRoot,
          riskTier: 'medium',
        },
        ctx.stateDir,
        ctx.eventStore,
      );
    }
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    for (const [args] of mockRunProbe.mock.calls) expect(args).toMatchObject({ diffFailed: true });
    expect(await readTaskDiff(repoRoot, { kind: 'base', baseRef: '--output=/tmp/x' })).toMatchObject({ ok: false,
      detail: expect.stringContaining('is not a safe ref') });
  });

  it('CheckTestAdequacy_ABaseWithNoMergeBase_IsADiffFailure', async () => {
    const ctx = await makeCtx();
    const repoRoot = await baseRepository();
    stateDirs.push(repoRoot);
    await git(repoRoot, 'checkout', '-q', '--orphan', 'feature/gone');
    await git(repoRoot, 'rm', '-q', '-r', '--cached', '.');
    await commitFiles(repoRoot, { 'other.txt': 'unrelated\n' }, 'unrelated history');
    await git(repoRoot, 'checkout', '-q', '-f', 'main');
    await handleTestAdequacy(
      {
        featureId: 'feat-nomergebase',
        taskId: 'T-nmb',
        baseBranch: 'feature/gone',
        repoRoot,
        riskTier: 'medium',
      },
      ctx.stateDir,
      ctx.eventStore,
    );
    expect(mockRunProbe).toHaveBeenCalledOnce();
    expect(mockRunProbe.mock.calls[0]?.[0]).toMatchObject({ diffFailed: true, changedFiles: [] });
  });

  /**
   * The carrier verdict of each cause at each tier. A blocked probe states the verdict of its cause. A red run on the task
   * source, a run with no verdict and a probe that ran no test give `indeterminate`. The other causes give `fail`.
   * An advisory skip gives `indeterminate`. A cause that is not in the table fails the test, so a new cause gets a verdict here.
   */
  it('CheckTestAdequacy_EachIndeterminateCause_StatesTheVerdictOfItsCause', async () => {
    const ctx = await makeCtx();
    const blockedVerdict: Readonly<Record<AdequacyDiscriminant, 'fail' | 'indeterminate'>> = {
      'no-new-tests': 'fail',
      'diff-failed': 'fail',
      'revert-conflict': 'fail',
      'restore-failed': 'fail',
      'base-missing': 'fail',
      'baseline-red': 'indeterminate',
      'run-no-verdict': 'indeterminate',
      'unprobed-test-paths': 'indeterminate',
      'profile-unresolved': 'indeterminate',
    };
    expect(Object.keys(blockedVerdict)).toHaveLength(ADEQUACY_DISCRIMINANTS.length);
    for (const cause of ADEQUACY_DISCRIMINANTS) expect(Object.keys(blockedVerdict)).toContain(cause);
    let blockedRuns = 0;
    for (const cause of ADEQUACY_DISCRIMINANTS) {
      for (const riskTier of [undefined, 'low', 'medium', 'high'] as const) {
        const label = `${cause} at ${String(riskTier)}`;
        mockRunProbe.mockResolvedValueOnce(probeNotRun(cause, `injected ${cause}`, riskTier));
        const result = await handleTestAdequacy(
          {
            featureId: 'feat-cause-verdict',
            taskId: 'T-cause',
            baseBranch: 'main',
            repoRoot: '/fake/repo',
            ...(riskTier === undefined ? {} : { riskTier }),
          },
          ctx.stateDir,
          ctx.eventStore,
        );
        expect(result.success, label).toBe(true);
        const data = result.data as { passed: boolean; skipped?: boolean; verdict?: string; completeness?: string };
        expect(data.completeness, label).toBe('complete');
        expect(data.verdict, label).not.toBe('pass');
        if (data.skipped === true) {
          expect(data.verdict, label).toBe('indeterminate');
        } else {
          blockedRuns += 1;
          expect(data.passed, label).toBe(false);
          expect(data.verdict, label).toBe(blockedVerdict[cause]);
        }
        expect(normalizeGateVerdict(result), label).toBe(data.verdict);
      }
    }
    expect(blockedRuns).toBeGreaterThanOrEqual((ADEQUACY_DISCRIMINANTS.length - 1) * 4);
  });
});

/** Each store key with its directory under `scratchDir`, as the probe environment sets it. */
function scratchStoreKeys(scratchDir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(STORE_LOCATION_ENV_KEYS).map(([location, key]) => [key, path.join(scratchDir, location)]));
}

/** The environment of one probe test run, read without a process. */
describe('probeTestEnvironment', () => {
  /** On POSIX a key of another case is another variable, so it stays. Each store key gets a directory under the scratch directory. */
  it('ProbeTestEnvironment_OnPosix_SetsEachStoreKeyAndDropsEachPluginKey', () => {
    const parent = {
      PATH: '/usr/bin',
      CLAUDE_PLUGIN_ROOT: '/plugin',
      EXARCHOS_PLUGIN_ROOT: '/plugin',
      WORKFLOW_STATE_DIR: '/live/state',
      EXARCHOS_INSTALL_STATE_DIR: '/live/install',
      workflow_state_dir: '/other',
    };

    expect(probeTestEnvironment(parent, '/scratch', 'linux')).toEqual({
      PATH: '/usr/bin',
      workflow_state_dir: '/other',
      ...scratchStoreKeys('/scratch'),
    });
  });

  /** Windows reads environment keys without case, so a store key or a plugin-mode key of any case goes. */
  it('ProbeTestEnvironment_OnWindows_DropsAStoreOrPluginKeyOfAnyCase', () => {
    const parent = {
      Path: 'C:\\bin',
      Claude_Plugin_Root: 'C:\\plugin',
      exarchos_plugin_root: 'C:\\plugin',
      workflow_state_dir: 'C:\\live',
      Exarchos_Cache_Dir: 'C:\\cache',
    };

    expect(probeTestEnvironment(parent, 'C:\\scratch', 'win32')).toEqual({ Path: 'C:\\bin', ...scratchStoreKeys('C:\\scratch') });
  });
});
