/**
 * Tests that the base-ref guard of `prepare_delegation` reads the settings of the repository of the caller.
 *
 * Under native isolation, the guard reads `worktree.baseRef` from the project settings. The project is `repoRoot`.
 * Each case sets the process directory to a temporary repository, which acts as the server directory.
 * The home directory is an empty temporary directory, so the user settings pin nothing.
 * The other guards run on real git, in temporary repositories.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { resetMaterializerCache } from '../../../../src/projections/views/tools.js';
import { handlePrepareDelegation } from '../../../../src/verbs/team/prepare-delegation.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The budget of each case. Each case spawns a few git commands in temporary repositories. */
const CASE_TIMEOUT_MS = 30_000;

/** The branch of a feature tree. It is not protected, and it descends from `main`. */
const FEATURE = 'feature/baseref';

/** The project settings that pin the base of a native worktree to the local HEAD. */
const HEAD_SETTINGS = `${JSON.stringify({ worktree: { baseRef: 'head' } })}\n`;

/** Each directory that a case made. The teardown deletes each one. */
let made: string[] = [];

/** The state directory and the store of the case. */
let stateDir: string;
let store: EventStore;

beforeEach(() => {
  resetMaterializerCache();
  stateDir = makeTempDir('prep-deleg-baseref-state-');
  made = [stateDir];
  store = new EventStore(stateDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetMaterializerCache();
  for (const dir of made) await rmrfAsync(dir);
});

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args])).trim();
}

/** Writes one file under the root of a tree, and makes its directory first. */
async function writeTreeFile(root: string, file: string, text: string): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf-8');
}

/** Makes a repository with one commit on `main`, then a feature branch at that commit. The teardown deletes it. */
async function repository(label: string): Promise<string> {
  const dir = makeTempDir(`prep-deleg-baseref-${label}-`);
  made.push(dir);
  await git(dir, ['init', '-q', '--initial-branch=main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeTreeFile(dir, 'README.md', `the ${label} repository\n`);
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-q', '-m', 'the first commit']);
  await git(dir, ['switch', '-q', '-c', FEATURE]);
  return dir;
}

/** Points the home directory at a new empty directory, so the user settings pin nothing. */
function emptyHome(): void {
  const home = makeTempDir('prep-deleg-baseref-home-');
  made.push(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
}

/** Runs `fn` with the process directory set to the server directory, then puts the prior directory back. */
async function inServerDirectory<T>(serverDirectory: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.cwd();
  process.chdir(serverDirectory);
  try {
    return await fn();
  } finally {
    process.chdir(prior);
  }
}

/** The dispatch context of the case, over its real store. */
function context(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

/** The data of a result as a record. A result with no data gives an empty record. */
function dataOf(result: ToolResult): Record<string, unknown> {
  const data: unknown = result.data;
  return typeof data === 'object' && data !== null ? { ...data } : {};
}

/** The base-ref outcome of the one `dispatch.preflight` row of a stream. Only a call with native isolation records it. */
async function baseRefPassed(streamId: string): Promise<unknown> {
  const rows = await store.query(streamId, { type: 'dispatch.preflight' });
  expect(rows).toHaveLength(1);
  const data: unknown = rows[0]?.data;
  if (typeof data !== 'object' || data === null || !('guards' in data)) return undefined;
  const guards: unknown = data.guards;
  if (typeof guards !== 'object' || guards === null || !('baseRef' in guards)) return undefined;
  const outcome: unknown = guards.baseRef;
  return typeof outcome === 'object' && outcome !== null && 'passed' in outcome ? outcome.passed : undefined;
}

describe('the base-ref guard of prepare_delegation', () => {
  /** Only the settings of `repoRoot` pin `worktree.baseRef`. The server directory and the home directory pin nothing. */
  it('PrepareDelegation_TheBaseRefGuard_ReadsTheSettingsOfRepoRoot', async () => {
    const server = await repository('server');
    const caller = await repository('caller');
    await writeTreeFile(caller, '.claude/settings.json', HEAD_SETTINGS);
    emptyHome();
    expect(existsSync(path.join(server, '.claude'))).toBe(false);
    const streamId = 'baseref-repo-root';

    const result = await inServerDirectory(server, () =>
      handlePrepareDelegation({ featureId: streamId, repoRoot: caller, nativeIsolation: true }, stateDir, context()),
    );

    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);
    const data = dataOf(result);
    expect(data.blocked).not.toBe(true);
    expect(data.reason).not.toBe('worktree-baseref-unset');
    expect(await baseRefPassed(streamId)).toBe(true);
    expect(await store.query(streamId, { type: 'preflight.blocked' })).toEqual([]);
  }, CASE_TIMEOUT_MS);
});
