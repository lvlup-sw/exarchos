import { describe, it, expect, afterEach } from 'vitest';
import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { handleNeedsSchemaSync } from '../../../../src/verbs/gates/needs-schema-sync.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

type ResultData = {
  syncNeeded: boolean;
  report: string;
  apiFiles: readonly string[];
};

function getData(result: { data?: unknown }): ResultData {
  return result.data as ResultData;
}

/** The absolute real path of the fixture Git on the test process PATH. */
function fixtureGit(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { continue; }
  }
  throw new Error('The fixture needs Git on PATH');
}

const GIT = fixtureGit();

/** The fixture Git environment: no global or system configuration and a fixed identity. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/** Fixture Git in `cwd` through the absolute executable. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync(GIT, ['-C', cwd, ...args], { env: GIT_ENV, timeout: 30_000 })).trim();
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rmrfAsync(root);
});

/** Write each named file under `dir`, with its directories, and commit them. */
async function commitFiles(dir: string, files: readonly string[], message: string): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), `${message} ${file}\n`);
  }
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}

/** A repository with a `main` base commit and a checked-out `task` branch that commits `changed`. `main` advances after the fork. */
async function syncRepo(changed: readonly string[]): Promise<{ readonly root: string; readonly repo: string }> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'schema-sync-')));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await commitFiles(repo, ['README.md'], 'base');
  await git(repo, 'checkout', '-q', '-b', 'task');
  await commitFiles(repo, changed, 'task');
  await git(repo, 'checkout', '-q', 'main');
  await commitFiles(repo, ['src/Models/AfterTheFork.cs'], 'advance');
  await git(repo, 'checkout', '-q', 'task');
  return { root, repo };
}

describe('handleNeedsSchemaSync', () => {
  describe('input validation', () => {
    it('returns error when repoRoot is empty', async () => {
      const result = await handleNeedsSchemaSync({ repoRoot: '' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('repoRoot');
    });
  });

  describe('no API files changed', () => {
    it('returns syncNeeded: false when no files match API patterns', async () => {
      const { repo } = await syncRepo(['src/Utils/Helper.cs', 'src/Services/FooService.cs']);

      const result = await handleNeedsSchemaSync({ repoRoot: repo });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(false);
      expect(data.apiFiles).toEqual([]);
      expect(data.report).toContain('No sync needed');
    });
  });

  describe('Endpoints.cs changed', () => {
    it('returns syncNeeded: true when Endpoints.cs is modified', async () => {
      const { repo } = await syncRepo(['src/Api/UsersEndpoints.cs', 'src/Startup.cs']);

      const result = await handleNeedsSchemaSync({ repoRoot: repo });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toEqual(['src/Api/UsersEndpoints.cs']);
      expect(data.report).toContain('Sync needed');
    });
  });

  describe('Models/*.cs changed', () => {
    it('returns syncNeeded: true when Models/*.cs is modified', async () => {
      const { repo } = await syncRepo(['src/Models/User.cs', 'src/README.md']);

      const result = await handleNeedsSchemaSync({ repoRoot: repo });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toEqual(['src/Models/User.cs']);
    });
  });

  describe('multiple API patterns matched', () => {
    it('returns all matched API files', async () => {
      const { repo } = await syncRepo([
        'src/Api/OrdersEndpoints.cs',
        'src/Models/Order.cs',
        'src/Requests/CreateOrderRequest.cs',
        'src/Responses/OrderResponse.cs',
        'src/Dtos/OrderDto.cs',
        'src/Services/OrderService.cs',
      ]);

      const result = await handleNeedsSchemaSync({ repoRoot: repo });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toEqual([
        'src/Api/OrdersEndpoints.cs',
        'src/Dtos/OrderDto.cs',
        'src/Models/Order.cs',
        'src/Requests/CreateOrderRequest.cs',
        'src/Responses/OrderResponse.cs',
      ]);
      expect(data.report).toContain('5 API file(s) modified');
    });
  });

  describe('non-API .cs files', () => {
    it('returns syncNeeded: false for non-API .cs files', async () => {
      const { repo } = await syncRepo(['src/Services/AuthService.cs', 'src/Helpers/StringHelper.cs', 'src/Program.cs']);

      const result = await handleNeedsSchemaSync({ repoRoot: repo });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(false);
      expect(data.apiFiles).toEqual([]);
    });
  });

  describe('diffFile mode', () => {
    /** A diff file gives the changed paths, and the handler reads no Git: a path outside any checkout still succeeds. */
    it('parses pre-computed diff to extract file paths', async () => {
      const root = realpathSync(await mkdtemp(join(tmpdir(), 'schema-sync-diff-')));
      roots.push(root);
      const diffFile = join(root, 'changes.diff');
      await writeFile(diffFile, [
        'diff --git a/src/Api/UsersEndpoints.cs b/src/Api/UsersEndpoints.cs',
        '--- a/src/Api/UsersEndpoints.cs',
        '+++ b/src/Api/UsersEndpoints.cs',
        '@@ -1,3 +1,4 @@',
        '+// new line',
        'diff --git a/src/Models/User.cs b/src/Models/User.cs',
        '--- /dev/null',
        '+++ b/src/Models/User.cs',
        '@@ -0,0 +1,5 @@',
        '+public class User {}',
        'diff --git a/src/Services/Foo.cs b/src/Services/Foo.cs',
        '--- a/src/Services/Foo.cs',
        '+++ b/src/Services/Foo.cs',
        '@@ -1,1 +1,2 @@',
        '+// changed',
      ].join('\n'));

      const result = await handleNeedsSchemaSync({ repoRoot: root, diffFile }, join(root, 'no-git'));

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toContain('src/Api/UsersEndpoints.cs');
      expect(data.apiFiles).toContain('src/Models/User.cs');
      expect(data.apiFiles).not.toContain('src/Services/Foo.cs');
    });

    it('returns error when diffFile does not exist', async () => {
      const result = await handleNeedsSchemaSync({
        repoRoot: '/repo',
        diffFile: join(tmpdir(), 'schema-sync-missing.diff'),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('Diff file not found');
    });
  });

  describe('empty diff', () => {
    it('returns syncNeeded: false when diff is empty', async () => {
      const { repo } = await syncRepo([]);

      const result = await handleNeedsSchemaSync({ repoRoot: repo });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(false);
      expect(data.apiFiles).toEqual([]);
    });
  });

  describe('default baseBranch', () => {
    /** With no base name, the read uses the merge base of `main`, so the API change that `main` made after the fork does not count. */
    it('defaults baseBranch to "main"', async () => {
      const { repo } = await syncRepo(['src/Api/UsersEndpoints.cs']);

      const result = await handleNeedsSchemaSync({ repoRoot: repo });

      expect(getData(result).apiFiles).toEqual(['src/Api/UsersEndpoints.cs']);
    });

    /** A custom base at the task head gives an empty diff. */
    it('uses custom baseBranch when provided', async () => {
      const { repo } = await syncRepo(['src/Api/UsersEndpoints.cs']);
      await git(repo, 'branch', 'develop', 'task');

      const result = await handleNeedsSchemaSync({ repoRoot: repo, baseBranch: 'develop' });

      expect(getData(result).apiFiles).toEqual([]);
    });
  });

  describe('git error handling', () => {
    /** An unknown base, a path outside any checkout and an unusable Git path give GIT_ERROR, never syncNeeded false. */
    it('returns GIT_ERROR when all git diff attempts fail', async () => {
      const { root, repo } = await syncRepo(['src/Api/UsersEndpoints.cs']);
      const outside = join(root, 'outside');
      await mkdir(outside);

      for (const result of [
        await handleNeedsSchemaSync({ repoRoot: repo, baseBranch: 'no-such-branch' }),
        await handleNeedsSchemaSync({ repoRoot: outside }),
        await handleNeedsSchemaSync({ repoRoot: repo }, join(root, 'no-git')),
      ]) {
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('GIT_ERROR');
      }
    });
  });

  describe('uncommitted changes', () => {
    /** The read covers exact commits only, so an uncommitted API change is not reported. */
    it('NeedsSchemaSync_UncommittedApiChange_IsNotReported', async () => {
      const { repo } = await syncRepo(['src/Services/AuthService.cs']);
      await mkdir(join(repo, 'src', 'Models'), { recursive: true });
      await writeFile(join(repo, 'src', 'Models', 'Draft.cs'), 'public class Draft {}\n');
      await writeFile(join(repo, 'src', 'Services', 'AuthService.cs'), 'changed\n');
      await git(repo, 'add', 'src/Models/Draft.cs');

      const result = await handleNeedsSchemaSync({ repoRoot: repo });

      expect(result.success).toBe(true);
      expect(getData(result)).toMatchObject({ syncNeeded: false, apiFiles: [] });
    });
  });
});
