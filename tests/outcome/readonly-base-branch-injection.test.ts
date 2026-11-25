/**
 * These tests call dispatch with the read-only MCP session grant.
 * Git writes a file when the base branch is an output option.
 * The polish scope check, the schema sync check and the review diff share that path.
 * A safe branch name still returns the changed file.
 * An output option must not create or change a file outside the repository.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../src/format.js';
import {
  deriveMcpCallerIdentity,
  resolveMcpSessionResolver,
} from '../../src/dispatch/caller-identity.js';
import { EventStore } from '../../src/events/store.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const MARKER = 'KEEP\n';

function git(repo: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function initRepo(repo: string): void {
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'tester@example.com']);
  git(repo, ['config', 'user.name', 'Tester']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'tracked.txt'), 'one\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'init']);
}

function commitEdit(repo: string): void {
  git(repo, ['checkout', '-b', 'topic']);
  writeFileSync(join(repo, 'tracked.txt'), 'two\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'edit']);
}

function outputOption(prefix: string): string {
  return `--output=${prefix}`;
}

function readonlyContext(stateDir: string, eventStore: EventStore): DispatchContext {
  const capabilityResolver = resolveMcpSessionResolver('read-only', undefined);
  if (capabilityResolver === undefined) {
    throw new Error('read-only session resolver is missing');
  }
  return {
    stateDir,
    eventStore,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'readonly-reviewer' }),
    capabilityResolver,
  };
}

async function callAction(
  ctx: DispatchContext,
  action: string,
  repo: string,
  baseBranch: string,
): Promise<ToolResult> {
  const args = action === 'review_diff'
    ? { action, worktreePath: repo, baseBranch }
    : { action, repoRoot: repo, baseBranch };
  return dispatch('exarchos_orchestrate', args, ctx);
}

function expectNoWrite(result: ToolResult, files: readonly { path: string; text?: string }[]): void {
  for (const file of files) {
    if (file.text === undefined) {
      expect(existsSync(file.path)).toBe(false);
    } else {
      expect(readFileSync(file.path, 'utf8')).toBe(file.text);
    }
  }
  expect(result.success).toBe(false);
  expect(result.error?.code).not.toBe('CAPABILITY_DENIED');
  expect(result.error?.code).not.toBe('ADMISSION_DENIED');
  expect(result.error?.code).not.toBe('TRUSTED_CALLER_REQUIRED');
}

describe('read-only base branch passed to git diff', () => {
  const dirs: string[] = [];
  let stateDir = '';
  let repo = '';
  let outside = '';
  let eventStore: EventStore | undefined;

  afterEach(async () => {
    eventStore?.close();
    eventStore = undefined;
    for (const dir of dirs.splice(0)) {
      await rmrfAsync(dir);
    }
  });

  function fresh(): { ctx: DispatchContext; repo: string; outside: string } {
    stateDir = makeTempDir('exarchos-state-');
    repo = makeTempDir('exarchos-repo-');
    outside = makeTempDir('exarchos-outside-');
    dirs.push(stateDir, repo, outside);
    eventStore = new EventStore(stateDir);
    initRepo(repo);
    return { ctx: readonlyContext(stateDir, eventStore), repo, outside };
  }

  /**
   * A branch name returns the changed file.
   * The call uses the same read-only session as the output-option cases.
   */
  it('returns the changed file for a branch name', async () => {
    const world = fresh();
    await world.ctx.eventStore.initialize();
    commitEdit(world.repo);
    const polish = await callAction(world.ctx, 'check_polish_scope', world.repo, 'main');
    const schema = await callAction(world.ctx, 'needs_schema_sync', world.repo, 'main');
    const review = await callAction(world.ctx, 'review_diff', world.repo, 'main');

    expect(polish.success).toBe(true);
    expect((polish.data as { fileCount: number }).fileCount).toBe(1);
    expect(schema.success).toBe(true);
    expect(review.success).toBe(true);
    expect((review.data as { filesChanged: number }).filesChanged).toBe(1);
  });

  /**
   * An output option must not create a file and must not replace an existing file.
   * The read-only gate admits the action, and the call still fails.
   */
  it('rejects an output option on the polish scope check', async () => {
    const world = fresh();
    await world.ctx.eventStore.initialize();
    const created = join(world.outside, 'created...HEAD');
    const kept = join(world.outside, 'kept...HEAD');
    writeFileSync(kept, MARKER);

    const createdResult = await callAction(
      world.ctx,
      'check_polish_scope',
      world.repo,
      outputOption(join(world.outside, 'created')),
    );
    const keptResult = await callAction(
      world.ctx,
      'check_polish_scope',
      world.repo,
      outputOption(join(world.outside, 'kept')),
    );

    expectNoWrite(createdResult, [{ path: created }]);
    expectNoWrite(keptResult, [{ path: kept, text: MARKER }]);
  });

  /**
   * The second git diff must not write the prefix when the suffixed path is a directory.
   */
  it('does not write the prefix after the suffixed polish diff fails', async () => {
    const world = fresh();
    await world.ctx.eventStore.initialize();
    const prefix = join(world.outside, 'prefix');
    mkdirSync(`${prefix}...HEAD`);
    writeFileSync(prefix, MARKER);

    const result = await callAction(
      world.ctx,
      'check_polish_scope',
      world.repo,
      outputOption(prefix),
    );

    expectNoWrite(result, [{ path: prefix, text: MARKER }]);
    expect(existsSync(`${prefix}...HEAD`)).toBe(true);
  });

  /**
   * The schema sync check must reject the same output option.
   */
  it('rejects an output option on the schema sync check', async () => {
    const world = fresh();
    await world.ctx.eventStore.initialize();
    const kept = join(world.outside, 'schema...HEAD');
    writeFileSync(kept, MARKER);

    const result = await callAction(
      world.ctx,
      'needs_schema_sync',
      world.repo,
      outputOption(join(world.outside, 'schema')),
    );

    expectNoWrite(result, [{ path: kept, text: MARKER }]);
  });

  /**
   * A space in the base value must not become a git option that writes a file.
   */
  it('rejects a spaced output option on the schema sync check', async () => {
    const world = fresh();
    await world.ctx.eventStore.initialize();
    const created = join(world.outside, 'spaced...HEAD');

    const result = await callAction(
      world.ctx,
      'needs_schema_sync',
      world.repo,
      `main ${outputOption(join(world.outside, 'spaced'))}`,
    );

    expectNoWrite(result, [{ path: created }]);
  });

  /**
   * The second schema sync diff must not write the prefix when the suffixed path is a directory.
   */
  it('does not write the prefix after the suffixed schema diff fails', async () => {
    const world = fresh();
    await world.ctx.eventStore.initialize();
    const prefix = join(world.outside, 'schema-prefix');
    mkdirSync(`${prefix}...HEAD`);
    writeFileSync(prefix, MARKER);

    const result = await callAction(
      world.ctx,
      'needs_schema_sync',
      world.repo,
      outputOption(prefix),
    );

    expectNoWrite(result, [{ path: prefix, text: MARKER }]);
  });

  /**
   * The review diff must reject the same output option.
   */
  it('rejects an output option on the review diff', async () => {
    const world = fresh();
    await world.ctx.eventStore.initialize();
    const kept = join(world.outside, 'review...HEAD');
    writeFileSync(kept, MARKER);

    const result = await callAction(
      world.ctx,
      'review_diff',
      world.repo,
      outputOption(join(world.outside, 'review')),
    );

    expectNoWrite(result, [{ path: kept, text: MARKER }]);
  });

  /**
   * The two-dot review diff must not write a file when the three-dot path is a directory.
   */
  it('does not write the two-dot path after the review diff fails', async () => {
    const world = fresh();
    await world.ctx.eventStore.initialize();
    const prefix = join(world.outside, 'review-prefix');
    mkdirSync(`${prefix}...HEAD`);
    writeFileSync(`${prefix}..HEAD`, MARKER);

    const result = await callAction(
      world.ctx,
      'review_diff',
      world.repo,
      outputOption(prefix),
    );

    expectNoWrite(result, [{ path: `${prefix}..HEAD`, text: MARKER }]);
  });
});
