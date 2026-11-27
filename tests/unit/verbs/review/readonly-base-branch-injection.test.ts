/**
 * Spec for the read-only review diff argument injection.
 *
 * A read-only MCP session can call `review_diff`, `check_polish_scope`, and
 * `needs_schema_sync`. Each one places the caller-supplied base branch into
 * `git diff` arguments. These tests dispatch that session against a real git
 * repository and a directory outside it. A base branch that git can read as an
 * output option must be refused, and the outside directory must stay empty.
 * A real ref name must still produce a diff.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createMcpDispatchContext } from '../../../../src/adapters/mcp/mcp.js';
import { dispatch, type DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { resolveMcpSessionResolver } from '../../../../src/dispatch/caller-identity.js';
import { EventStore } from '../../../../src/events/store.js';
import { buildDefaultProcessResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

/**
 * A repository on `main` with one commit and one unstaged edit. The unstaged
 * edit is what `git diff` writes when a base branch is consumed as an option
 * and no revision range remains.
 */
async function initRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'exarchos-range-repo-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'reviewer@example.com']);
  await git(repo, ['config', 'user.name', 'Reviewer Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  await writeFile(path.join(repo, 'a.txt'), 'one\nleaked\n');
  return repo;
}

/**
 * The dispatch context of an MCP server started without `--operator`.
 * The session holds `fs:read` and `mcp:exarchos:readonly`, and nothing that
 * writes files or runs a shell.
 */
function readOnlySession(stateDir: string, eventStore: EventStore): DispatchContext {
  const sessionResolver = resolveMcpSessionResolver('read-only', buildDefaultProcessResolver());
  if (sessionResolver === undefined) {
    throw new Error('read-only MCP session resolver was not created');
  }
  if (sessionResolver.has('fs:write') || sessionResolver.has('shell:exec') || sessionResolver.has('mcp:exarchos')) {
    throw new Error('read-only MCP session holds a write capability');
  }
  if (!sessionResolver.has('fs:read') || !sessionResolver.has('mcp:exarchos:readonly')) {
    throw new Error('read-only MCP session is missing the read grant');
  }
  return createMcpDispatchContext(
    {
      stateDir,
      eventStore,
      enableTelemetry: false,
      capabilityResolver: sessionResolver,
    },
    { sessionId: 'readonly-reviewer-session' },
  );
}

/**
 * The outside directory is empty, and the refusal is an input error.
 * A file created by git and left behind fails the test, including when the
 * handler reports an error after the write.
 */
async function expectNoWrite(
  ctx: DispatchContext,
  sink: string,
  action: string,
  args: Record<string, unknown>,
): Promise<void> {
  const result = await dispatch('exarchos_orchestrate', { action, ...args }, ctx);
  const written = await readdir(sink);
  expect(written, JSON.stringify(result)).toEqual([]);
  expect(result.success).toBe(false);
  expect(result.error?.code).toBe('INVALID_INPUT');
}

describe('read-only git range arguments', () => {
  let stateDir: string;
  let repo: string;
  let sink: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'exarchos-range-state-'));
    sink = await mkdtemp(path.join(tmpdir(), 'exarchos-range-sink-'));
    repo = await initRepo();
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    ctx = readOnlySession(stateDir, eventStore);
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(stateDir);
    await rmrfAsync(repo);
    await rmrfAsync(sink);
  });

  /**
   * `review_diff` is on the read-only allowlist and declares only a file read.
   * A base branch that is a git output option must not create the suffixed file.
   */
  it('review_diff refuses an output-option base branch and writes nothing', async () => {
    await expectNoWrite(ctx, sink, 'review_diff', {
      worktreePath: repo,
      baseBranch: `--output=${path.join(sink, 'review')}`,
    });
  });

  /** A normal ref still returns a diff for the same read-only session. */
  it('review_diff still diffs a real base branch', async () => {
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'review_diff', worktreePath: repo, baseBranch: 'main' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(await readdir(sink)).toEqual([]);
  });

  /**
   * `check_polish_scope` builds the same three-dot range from the caller base
   * branch and is admitted for the read-only session.
   */
  it('check_polish_scope refuses an output-option base branch and writes nothing', async () => {
    await expectNoWrite(ctx, sink, 'check_polish_scope', {
      repoRoot: repo,
      baseBranch: `--output=${path.join(sink, 'polish')}`,
    });
  });

  /** A normal ref still returns a scope verdict. */
  it('check_polish_scope still diffs a real base branch', async () => {
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'check_polish_scope', repoRoot: repo, baseBranch: 'main' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(await readdir(sink)).toEqual([]);
  });

  /**
   * `needs_schema_sync` passes the base branch to `git diff` and splits that
   * argument on spaces, so a ref followed by an option is a second write path.
   */
  it('needs_schema_sync refuses an output-option base branch and writes nothing', async () => {
    await expectNoWrite(ctx, sink, 'needs_schema_sync', {
      repoRoot: repo,
      baseBranch: `--output=${path.join(sink, 'schema')}`,
    });
  });

  /**
   * The base branch does not start with a dash. Splitting it on spaces still
   * yields a git output option. Refusing only a leading dash leaves the write.
   */
  it('needs_schema_sync refuses a base branch that hides an output option after a space', async () => {
    await expectNoWrite(ctx, sink, 'needs_schema_sync', {
      repoRoot: repo,
      baseBranch: `main --output=${path.join(sink, 'schema-split')}`,
    });
  });

  /**
   * The same range string is built for other gates. A read-only session does
   * not hold `mcp:exarchos`, so admission stops `check_context_economy` before
   * git. `debug_review_gate` is not on the read-only allowlist.
   */
  it('check_context_economy and debug_review_gate write nothing for a read-only session', async () => {
    const economy = await dispatch(
      'exarchos_orchestrate',
      {
        action: 'check_context_economy',
        featureId: 'feat-readonly',
        repoRoot: repo,
        baseBranch: `--output=${path.join(sink, 'economy')}`,
      },
      ctx,
    );
    const debugGate = await dispatch(
      'exarchos_orchestrate',
      {
        action: 'debug_review_gate',
        featureId: 'feat-readonly',
        repoRoot: repo,
        baseBranch: `--output=${path.join(sink, 'debug')}`,
      },
      ctx,
    );
    expect(await readdir(sink)).toEqual([]);
    expect(economy.success).toBe(false);
    expect(economy.error?.code).toBe('ADMISSION_DENIED');
    expect(debugGate.success).toBe(false);
    expect(debugGate.error?.code).toBe('CAPABILITY_DENIED');
  });

  /** A normal ref still returns a schema-sync verdict. */
  it('needs_schema_sync still diffs a real base branch', async () => {
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'needs_schema_sync', repoRoot: repo, baseBranch: 'main' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(await readdir(sink)).toEqual([]);
  });
});
