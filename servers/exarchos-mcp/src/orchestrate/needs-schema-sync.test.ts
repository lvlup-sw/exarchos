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

import { handleNeedsSchemaSync } from './needs-schema-sync.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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
    it('returns error when repoRoot is empty', () => {
      const result = handleNeedsSchemaSync({ repoRoot: '' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('repoRoot');
    });
  });

  // ─── No API Files Changed ──────────────────────────────────────────────

  describe('no API files changed', () => {
    it('returns syncNeeded: false when no files match API patterns', () => {
      mockExecFileSync.mockReturnValue(
        'src/Utils/Helper.cs\nsrc/Services/FooService.cs\n',
      );

      const result = handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(false);
      expect(data.apiFiles).toEqual([]);
      expect(data.report).toContain('No sync needed');
    });
  });

  // ─── Endpoints.cs Changed ─────────────────────────────────────────────

  describe('Endpoints.cs changed', () => {
    it('returns syncNeeded: true when Endpoints.cs is modified', () => {
      mockExecFileSync.mockReturnValue(
        'src/Api/UsersEndpoints.cs\nsrc/Startup.cs\n',
      );

      const result = handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toEqual(['src/Api/UsersEndpoints.cs']);
      expect(data.report).toContain('Sync needed');
    });
  });

  // ─── Models/*.cs Changed ──────────────────────────────────────────────

  describe('Models/*.cs changed', () => {
    it('returns syncNeeded: true when Models/*.cs is modified', () => {
      mockExecFileSync.mockReturnValue(
        'src/Models/User.cs\nsrc/README.md\n',
      );

      const result = handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(true);
      expect(data.apiFiles).toEqual(['src/Models/User.cs']);
    });
  });

  // ─── Multiple API Patterns Matched ────────────────────────────────────

  describe('multiple API patterns matched', () => {
    it('returns all matched API files', () => {
      mockExecFileSync.mockReturnValue(
        [
          'src/Api/OrdersEndpoints.cs',
          'src/Models/Order.cs',
          'src/Requests/CreateOrderRequest.cs',
          'src/Responses/OrderResponse.cs',
          'src/Dtos/OrderDto.cs',
          'src/Services/OrderService.cs',
        ].join('\n') + '\n',
      );

      const result = handleNeedsSchemaSync({ repoRoot: '/repo' });

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
    it('returns syncNeeded: false for non-API .cs files', () => {
      mockExecFileSync.mockReturnValue(
        'src/Services/AuthService.cs\nsrc/Helpers/StringHelper.cs\nsrc/Program.cs\n',
      );

      const result = handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(false);
      expect(data.apiFiles).toEqual([]);
    });
  });

  // ─── diffFile Mode ────────────────────────────────────────────────────

  describe('diffFile mode', () => {
    it('parses pre-computed diff to extract file paths', () => {
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

      const result = handleNeedsSchemaSync({
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

    it('returns error when diffFile does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = handleNeedsSchemaSync({
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
    it('returns syncNeeded: false when diff is empty', () => {
      mockExecFileSync.mockReturnValue('');

      const result = handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(true);
      const data = getData(result);
      expect(data.syncNeeded).toBe(false);
      expect(data.apiFiles).toEqual([]);
    });
  });

  // ─── Default baseBranch ───────────────────────────────────────────────

  describe('default baseBranch', () => {
    it('defaults baseBranch to "main"', () => {
      mockExecFileSync.mockReturnValue('');

      handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['diff', '--name-only', 'main...HEAD'],
        expect.objectContaining({ cwd: '/repo' }),
      );
    });

    it('uses custom baseBranch when provided', () => {
      mockExecFileSync.mockReturnValue('');

      handleNeedsSchemaSync({ repoRoot: '/repo', baseBranch: 'develop' });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['diff', '--name-only', 'develop...HEAD'],
        expect.objectContaining({ cwd: '/repo' }),
      );
    });
  });

  // ─── Git Error Handling ───────────────────────────────────────────────

  describe('git error handling', () => {
    it('returns GIT_ERROR when all git diff attempts fail', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('git diff failed');
      });

      const result = handleNeedsSchemaSync({ repoRoot: '/repo' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GIT_ERROR');
    });
  });
});
