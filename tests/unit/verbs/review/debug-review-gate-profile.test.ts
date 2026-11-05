/**
 * debug_review_gate under the verification profile. A changed file counts as a new test only when a test-name glob of `tests.globs` matches it.
 *
 * Each case builds a real git repository, and the resolver reads its real marker files. Each case sets `skipRun`, so the gate starts no test command.
 * The evidence runner is a stub that calls only the provider.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: (request: { readonly executeProvider: () => Promise<ToolResult> }) => request.executeProvider(),
}));

import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { handleDebugReviewGate } from '../../../../src/verbs/review/debug-review-gate.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/** The files of one commit: the path of each file and its text. */
type Files = Readonly<Record<string, string>>;

/** The fields of the gate data that the cases read. The parse checks them, so no case trusts the shape of the data. */
const GateDataSchema = z.object({
  passed: z.boolean(),
  report: z.string(),
  discriminant: z.string().optional(),
  reason: z.string().optional(),
});

type GateData = z.infer<typeof GateDataSchema>;

/** A config that empties the test globs. */
const EMPTY_TEST_GLOBS = 'verification:\n  tests:\n    globs: []\n';

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
    mkdirSync(dirname(join(repoRoot, file)), { recursive: true });
    writeFileSync(join(repoRoot, file), text);
  }
}

/** A repository with `base` committed on `main`, and a checked-out fix branch whose commit writes `fix`. */
async function fixRepo(base: Files, fix: Files): Promise<string> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'debug-review-gate-profile-'));
  cleanups.push(() => rmrf(repoRoot));
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  writeFiles(repoRoot, base);
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  await git(repoRoot, ['checkout', '-q', '-b', 'fix']);
  writeFiles(repoRoot, fix);
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-q', '-m', 'the fix']);
  return repoRoot;
}

/** Calls the gate against `main`, with `skipRun`. */
async function runGate(repoRoot: string): Promise<GateData> {
  const result = await handleDebugReviewGate(
    { featureId: 'feat-debug-review-profile', repoRoot, baseBranch: 'main', skipRun: true },
    repoRoot,
    new EventStore(repoRoot),
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  return GateDataSchema.parse(result.data);
}

describe('handleDebugReviewGate — the test globs of the profile', () => {
  /** The killing assertion: the check passes. The old regex refuses a Go test path, so the check fails. */
  it('DebugReviewGate_AGoTestFile_CountsAsANewTest', async () => {
    const repoRoot = await fixRepo({ 'go.mod': 'module example.com/fixture\n' }, { 'pkg/a.go': 'package pkg\n', 'pkg/a_test.go': 'package pkg\n' });

    const data = await runGate(repoRoot);

    expect(data.passed).toBe(true);
    expect(data.report).toContain('New test files added (1 test file(s): pkg/a_test.go)');
  });

  /** A snapshot of a test matches a classification glob and no test-name glob. So a fix that changes only a snapshot adds no new test. */
  it('DebugReviewGate_ASnapshotOnlyFix_AddsNoNewTest', async () => {
    const repoRoot = await fixRepo(
      { 'package.json': '{}', 'src/a.ts': 'base\n' },
      { 'src/a.ts': 'fix\n', 'src/__snapshots__/a.test.ts.snap': 'snapshot\n' },
    );

    const data = await runGate(repoRoot);

    expect(data.passed).toBe(false);
    expect(data.report).toContain('New test files added — No test files found in changed files');
    expect(data.discriminant).toBeUndefined();
  });

  /** A second toolchain gives its test-name globs. The killing assertion: the check passes. The old regex refuses a C# path, so the check fails. */
  it('DebugReviewGate_ACSharpTestInANodeRootBesideASolution_CountsAsANewTest', async () => {
    const repoRoot = await fixRepo(
      { 'package.json': '{}', 'App.sln': '' },
      { 'src/a.ts': 'fix\n', 'Tests/FooTests.cs': 'class FooTests {}\n' },
    );

    const data = await runGate(repoRoot);

    expect(data.passed).toBe(true);
    expect(data.report).toContain('New test files added (1 test file(s): Tests/FooTests.cs)');
  });

  /** The killing assertion: the check fails and names the discriminant. The old regex matches `src/a.test.ts`, so the check passes with no discriminant. */
  it('DebugReviewGate_AnUnresolvedGlobSet_FailsWithProfileUnresolved', async () => {
    const repoRoot = await fixRepo(
      { 'package.json': '{}', '.exarchos.yml': EMPTY_TEST_GLOBS },
      { 'src/a.ts': 'fix\n', 'src/a.test.ts': 'test\n' },
    );

    const data = await runGate(repoRoot);

    expect(data.passed).toBe(false);
    expect(data.discriminant).toBe('profile-unresolved');
    expect(data.reason).toContain('tests.globs');
    expect(data.report).toContain('New test files added — profile-unresolved: tests.globs');
  });

  /** A config that does not load gives an unresolved glob term. The killing assertion: the old regex matches the test, so the check passes with no discriminant. */
  it('DebugReviewGate_AConfigThatDoesNotLoad_FailsWithProfileUnresolved', async () => {
    const repoRoot = await fixRepo(
      { 'package.json': '{}', '.exarchos.yml': 'verification: [\n' },
      { 'src/a.ts': 'fix\n', 'src/a.test.ts': 'test\n' },
    );

    const data = await runGate(repoRoot);

    expect(data.passed).toBe(false);
    expect(data.discriminant).toBe('profile-unresolved');
    expect(data.reason).toContain('.exarchos.yml does not load');
  });
});
