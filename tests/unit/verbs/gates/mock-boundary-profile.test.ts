/**
 * The mock-boundary gate classifies with the terms of the verification profile.
 *
 * Each case calls `handleMockBoundary` directly, in a trusted scope, against a real git fixture and a real event store.
 * A case with a pinned profile passes it in `args.verificationProfile`, because a call through the dispatcher removes it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { DEFAULTS, type ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import { EventStore } from '../../../../src/events/store.js';
import { handleMockBoundary, type MockBoundaryHandlerArgs } from '../../../../src/verbs/gates/mock-boundary-handler.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller, seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import {
  cSharpGlobTerm,
  pinnedTestProfile,
  pinnedUnresolvedFirstPartyProfile,
  pinnedUnresolvedGlobProfile,
  UNRESOLVED_FIRST_PARTY_REASON,
  UNRESOLVED_GLOBS_REASON,
} from '../../../helpers/verification-profile.js';

const FEATURE = 'feat-mock-boundary-profile';
const TASK_BRANCH = 'feature/task';
/** The budget of one case. A case spawns git. */
const CASE_TIMEOUT_MS = 120_000;

/** The files of one commit: the path of each file and its text. */
type Files = Readonly<Record<string, string>>;

/** A test line that mocks a package outside the first-party scope. */
const UNOWNED_MOCK = "vi.mock('axios');\n";

/** The fields of the gate carrier that the cases read. The parse checks them, so no case trusts the shape of the data. */
const CarrierSchema = z.object({
  passed: z.boolean(),
  skipped: z.boolean().optional(),
  findings: z.array(z.object({ file: z.string(), mockedTarget: z.string(), unowned: z.boolean() })),
  severity: z.string().optional(),
  discriminant: z.string().optional(),
  reason: z.string().optional(),
  profilePath: z.string().optional(),
  configLoadError: z.string().optional(),
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

/** A repository with `base` committed on `main`, and a task branch that writes `task`. The branch is checked out. */
async function taskRepo(base: Files, task: Files): Promise<string> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'mock-boundary-profile-'));
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
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-q', '-m', 'the work of the task']);
  return repoRoot;
}

/** The data of one direct gate call, in a new store. */
async function runGate(repoRoot: string, extra: Partial<MockBoundaryHandlerArgs> = {}): Promise<Carrier> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'mock-boundary-profile-state-'));
  const eventStore = new EventStore(stateDir);
  cleanups.push(() => {
    eventStore.close();
    rmrf(stateDir);
  });
  await eventStore.initialize();
  await seedActivePhaseAttempt(eventStore, FEATURE);
  const result = await runAsTrustedCaller(stateDir, () =>
    handleMockBoundary(
      { featureId: FEATURE, taskId: 'T-1', branch: TASK_BRANCH, baseBranch: 'main', repoRoot, ...extra },
      stateDir,
      eventStore,
    ),
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  return CarrierSchema.parse(result.data);
}

/** The config of a checkout that makes the gate blocking. */
const BLOCKING_CHECKOUT_CONFIG: ResolvedProjectConfig = {
  ...DEFAULTS,
  review: {
    ...DEFAULTS.review,
    gates: { ...DEFAULTS.review.gates, 'mock-boundary': { enabled: true, blocking: true, params: {} } },
  },
};

/** A worktree config that keeps the gate advisory. Only a gate that reads the worktree takes it. */
const ADVISORY_WORKTREE_CONFIG = 'review:\n  gates:\n    mock-boundary:\n      enabled: true\n      blocking: false\n';

describe('check_mock_boundary reads the terms of the profile', () => {
  /** The digest of the checkout config is pinned, and the worktree config is not. So the worktree cannot make the gate advisory. */
  it('MockBoundary_InASegment_TakesItsSeverityFromTheCheckoutConfig', async () => {
    const repoRoot = await taskRepo(
      { 'src/a.ts': 'base\n', '.exarchos.yml': ADVISORY_WORKTREE_CONFIG },
      { 'src/a.test.ts': UNOWNED_MOCK },
    );

    const data = await runGate(repoRoot, {
      verificationProfile: pinnedTestProfile(1),
      projectConfig: BLOCKING_CHECKOUT_CONFIG,
    });

    expect(data.severity).toBe('blocking');
    expect(data.passed).toBe(false);
    expect(data.findings.map((finding) => finding.mockedTarget)).toEqual(['axios']);
    expect(data.profilePath).toBe('pinned by capsule v1');
  }, CASE_TIMEOUT_MS);

  /** The co-located globs do not match a C# test, so only the pinned glob term puts its hunks in the scan. */
  it('MockBoundary_APinnedCSharpGlob_ScansTheCSharpTestHunks', async () => {
    const repoRoot = await taskRepo(
      { 'src/Foo.cs': 'base\n' },
      { 'Tests/FooTests.cs': 'var client = new Mock<HttpClient>();\n' },
    );

    const data = await runGate(repoRoot, { verificationProfile: pinnedTestProfile(4, { globs: cSharpGlobTerm() }) });

    expect(data.findings.map((finding) => [finding.file, finding.unowned])).toEqual([['Tests/FooTests.cs', true]]);
    expect(data.profilePath).toBe('pinned by capsule v4');
  }, CASE_TIMEOUT_MS);

  /** The gate is advisory, so an unresolved glob term is a skip that names the term and passes. */
  it('MockBoundary_AnUnresolvedGlobSet_IsAnAdvisorySkipWithProfileUnresolved', async () => {
    const repoRoot = await taskRepo({ 'src/a.ts': 'base\n' }, { 'src/a.test.ts': UNOWNED_MOCK });

    const data = await runGate(repoRoot, { verificationProfile: pinnedUnresolvedGlobProfile(5) });

    expect(data.skipped).toBe(true);
    expect(data.passed).toBe(true);
    expect(data.discriminant).toBe('profile-unresolved');
    expect(data.findings).toEqual([]);
    expect(data.reason).toContain(UNRESOLVED_GLOBS_REASON);
    expect(data.reason?.startsWith('pinned by capsule v5.')).toBe(true);
    expect(data.reason).toContain('a new batch');
  }, CASE_TIMEOUT_MS);

  /**
   * The mock names a module of the repository outside the default scope, and the pinned scope is unresolved.
   * The killing assertion: with the task reverted, the gate reads the worktree globs and reports the mock.
   */
  it('MockBoundary_AnUnresolvedFirstPartyTerm_IsAnAdvisorySkipWithProfileUnresolved', async () => {
    const repoRoot = await taskRepo({ 'src/a.ts': 'base\n' }, { 'src/a.test.ts': "vi.mock('../shared/client.js');\n" });

    const data = await runGate(repoRoot, { verificationProfile: pinnedUnresolvedFirstPartyProfile(6) });

    expect(data.skipped).toBe(true);
    expect(data.passed).toBe(true);
    expect(data.discriminant).toBe('profile-unresolved');
    expect(data.findings).toEqual([]);
    expect(data.reason).toContain(UNRESOLVED_FIRST_PARTY_REASON);
  }, CASE_TIMEOUT_MS);

  /** A direct call resolves the terms at its root, so a configured glob term classifies, and the report says so. */
  it('MockBoundary_ADirectCall_ResolvesTheProfileAtItsRepoRootAndSaysSo', async () => {
    const repoRoot = await taskRepo(
      {
        'src/Foo.cs': 'base\n',
        '.exarchos.yml': "verification:\n  tests:\n    globs:\n      - '**/*Tests.cs'\n",
      },
      { 'Tests/FooTests.cs': UNOWNED_MOCK },
    );

    const data = await runGate(repoRoot);

    expect(data.findings.map((finding) => finding.mockedTarget)).toEqual(['axios']);
    expect(data.profilePath).toBe(`resolved at ${repoRoot}`);
  }, CASE_TIMEOUT_MS);

  /**
   * A config that does not load gives unresolved terms, and the gate reads none of them. It keeps the decided fallback.
   * This is the twin of the unresolved cases above: the verdict is the same under the old code.
   */
  it('MockBoundary_ADirectCallWithAConfigThatDoesNotLoad_ScansWithTheFallbackAndIsNoSkip', async () => {
    const repoRoot = await taskRepo(
      { 'src/a.ts': 'base\n', '.exarchos.yml': 'notARealKey: true\n' },
      { 'src/a.test.ts': UNOWNED_MOCK },
    );

    const data = await runGate(repoRoot);

    expect(data.skipped).toBeUndefined();
    expect(data.passed).toBe(true);
    expect(data.severity).toBe('warning');
    expect(data.findings.map((finding) => finding.mockedTarget)).toEqual(['axios']);
    expect(data.configLoadError).toContain('notARealKey');
  }, CASE_TIMEOUT_MS);
});
