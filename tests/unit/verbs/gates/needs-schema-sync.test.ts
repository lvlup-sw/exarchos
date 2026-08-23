// ─── Schema Sync Detection Tests ──────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock child_process and fs ──────────────────────────────────────────────

const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

import { handleNeedsSchemaSync } from '../../../../src/verbs/gates/needs-schema-sync.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Route the two git calls the handler now makes.
 *
 * The base branch is DETECTED (`git symbolic-ref refs/remotes/origin/HEAD`)
 * rather than assumed, so a single `mockReturnValue` would hand the diff output
 * back to the detector as well — and a file list is not a ref, so every test
 * would take the unresolved path. Each test says what the repository's default
 * branch is and what the diff returned.
 */
function mockGit(diffOutput: string, defaultBranch: string | null = 'main'): void {
  mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
    const argv = args as readonly string[];
    if (argv[0] === 'symbolic-ref') {
      if (defaultBranch === null) throw new Error('no origin/HEAD');
      return `refs/remotes/origin/${defaultBranch}\n`;
    }
    // Below `symbolic-ref` the resolver walks a LADDER of further git reads. A
    // stub that answered every one of them with the diff would hand a file path
    // to the rung that reads `init.defaultBranch` and see it resolved as a
    // branch — so the stub answers the subcommand this handler actually issues
    // and refuses the rest, which is what a repository with no detectable
    // default branch does.
    if (argv[0] !== 'diff') throw new Error(`git ${String(argv[0])}: no answer`);
    return diffOutput;
  });
}

type ResultData = {
  syncNeeded: boolean;
  report: string;
  apiFiles: readonly string[];
};

function getData(result: { data?: unknown }): ResultData {
  return result.data as ResultData;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleNeedsSchemaSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Input Validation ───────────────────────────────────────────────────

  describe('input validation', () => {
    it('returns error when repoRoot is empty', async () => {
      const result = await handleNeedsSchemaSync({ repoRoot: '' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('repoRoot');
    });
  });

  // ─── No API Files Changed ──────────────────────────────────────────────

  describe('no API files changed', () => {
    it('returns syncNeeded: false when no files match API patterns', async () => {
      mockGit('src/Utils/Helper.cs\nsrc/Services/FooService.cs\n',
      );

      const result = await handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(false);
      expect(data.apiFiles).toEqual([]);
      expect(data.report).toContain('No sync needed');
    });
  });

  // ─── Endpoints.cs Changed ─────────────────────────────────────────────

  describe('Endpoints.cs changed', () => {
    it('returns syncNeeded: true when Endpoints.cs is modified', async () => {
      mockGit('src/Api/UsersEndpoints.cs\nsrc/Startup.cs\n',
      );

      const result = await handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toEqual(['src/Api/UsersEndpoints.cs']);
      expect(data.report).toContain('Sync needed');
    });
  });

  // ─── Models/*.cs Changed ──────────────────────────────────────────────

  describe('Models/*.cs changed', () => {
    it('returns syncNeeded: true when Models/*.cs is modified', async () => {
      mockGit('src/Models/User.cs\nsrc/README.md\n',
      );

      const result = await handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toEqual(['src/Models/User.cs']);
    });
  });

  // ─── Multiple API Patterns Matched ────────────────────────────────────

  describe('multiple API patterns matched', () => {
    it('returns all matched API files', async () => {
      mockGit([
          'src/Api/OrdersEndpoints.cs',
          'src/Models/Order.cs',
          'src/Requests/CreateOrderRequest.cs',
          'src/Responses/OrderResponse.cs',
          'src/Dtos/OrderDto.cs',
          'src/Services/OrderService.cs',
        ].join('\n') + '\n',
      );

      const result = await handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toEqual([
        'src/Api/OrdersEndpoints.cs',
        'src/Models/Order.cs',
        'src/Requests/CreateOrderRequest.cs',
        'src/Responses/OrderResponse.cs',
        'src/Dtos/OrderDto.cs',
      ]);
      expect(data.report).toContain('5 API file(s) modified');
    });
  });

  // ─── Non-API .cs Files ────────────────────────────────────────────────

  describe('non-API .cs files', () => {
    it('returns syncNeeded: false for non-API .cs files', async () => {
      mockGit('src/Services/AuthService.cs\nsrc/Helpers/StringHelper.cs\nsrc/Program.cs\n',
      );

      const result = await handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(false);
      expect(data.apiFiles).toEqual([]);
    });
  });

  // ─── diffFile Mode ────────────────────────────────────────────────────

  describe('diffFile mode', () => {
    it('parses pre-computed diff to extract file paths', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        [
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
        ].join('\n'),
      );

      const result = await handleNeedsSchemaSync({
        repoRoot: '/repo',
        diffFile: '/tmp/changes.diff',
      });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toContain('src/Api/UsersEndpoints.cs');
      expect(data.apiFiles).toContain('src/Models/User.cs');
      // Non-API file should not be in apiFiles
      expect(data.apiFiles).not.toContain('src/Services/Foo.cs');
      // git should not have been called
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns error when diffFile does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await handleNeedsSchemaSync({
        repoRoot: '/repo',
        diffFile: '/tmp/missing.diff',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('Diff file not found');
    });
  });

  // ─── Empty Diff ───────────────────────────────────────────────────────

  describe('empty diff', () => {
    it('returns syncNeeded: false when diff is empty', async () => {
      mockGit('');

      const result = await handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(false);
      expect(data.apiFiles).toEqual([]);
    });
  });

  // ─── Base-branch resolution ───────────────────────────────────────────

  describe('base branch', () => {
    it('DetectsTheDefaultBranch_RatherThanAssumingMain', async () => {
      mockGit('', 'trunk');

      await handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['diff', '--name-only', 'trunk...HEAD'],
        expect.objectContaining({ cwd: '/repo' }),
      );
    });

    it('uses custom baseBranch when provided', async () => {
      mockGit('');

      await handleNeedsSchemaSync({ repoRoot: '/repo', baseBranch: 'develop' });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['diff', '--name-only', 'develop...HEAD'],
        expect.objectContaining({ cwd: '/repo' }),
      );
      // An explicit base short-circuits detection entirely.
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        ['symbolic-ref', 'refs/remotes/origin/HEAD'],
        expect.anything(),
      );
    });

    it('UnresolvedBase_ReportsIt_AndNeverDiffsAgainstMain', async () => {
      mockGit('src/Api/Endpoints.cs\n', null);

      const result = await handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GIT_ERROR');
      // The point of the check: no diff was attempted against an invented base,
      // so the API file above is neither reported nor silently missed.
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        ['diff', '--name-only', 'main...HEAD'],
        expect.anything(),
      );
    });

    it('SuppliedDiffFile_NeedsNoBaseAtAll', async () => {
      // The comparison already happened; nothing here has to detect a branch.
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('+++ b/src/Api/Endpoints.cs\n');
      mockGit('', null);

      const result = await handleNeedsSchemaSync({
        repoRoot: '/repo',
        diffFile: '/tmp/changes.diff',
      });

      expect(result.success).toBe(true);
      expect(getData(result).syncNeeded).toBe(true);
    });
  });

  // ─── Git Error Handling ───────────────────────────────────────────────

  describe('git error handling', () => {
    it('returns GIT_ERROR when all git diff attempts fail', async () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
        // The base resolves; only the diff itself fails.
        if ((args as readonly string[])[0] === 'symbolic-ref') {
          return 'refs/remotes/origin/main\n';
        }
        throw new Error('git diff failed');
      });

      const result = await handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GIT_ERROR');
    });
  });
});
