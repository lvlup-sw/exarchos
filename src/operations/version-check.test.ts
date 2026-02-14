/**
 * Tests for the remote version check module.
 */

import { describe, it, expect, vi } from 'vitest';
import { checkVersion, formatVersionWarning } from './version-check.js';
import type { VersionCheckResult } from './version-check.js';

/** Helper to create a mock fetch that returns a JSON body. */
function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

/** Helper to create a mock fetch that rejects. */
function mockFetchError(message: string): typeof fetch {
  return vi.fn().mockRejectedValue(new Error(message));
}

describe('checkVersion', () => {
  describe('when remote version matches local', () => {
    it('should return status current', async () => {
      const fetchFn = mockFetch({ version: '2.0.0' });

      const result = await checkVersion('2.0.0', { fetchFn });

      expect(result.status).toBe('current');
      expect(result.localVersion).toBe('2.0.0');
      expect(result.remoteVersion).toBe('2.0.0');
    });
  });

  describe('when remote version differs from local', () => {
    it('should return status outdated when local is behind remote', async () => {
      const fetchFn = mockFetch({ version: '3.0.0' });

      const result = await checkVersion('2.0.0', { fetchFn });

      expect(result.status).toBe('outdated');
      expect(result.localVersion).toBe('2.0.0');
      expect(result.remoteVersion).toBe('3.0.0');
    });

    it('should return status outdated when local is ahead of remote', async () => {
      const fetchFn = mockFetch({ version: '1.0.0' });

      const result = await checkVersion('2.0.0', { fetchFn });

      expect(result.status).toBe('outdated');
      expect(result.localVersion).toBe('2.0.0');
      expect(result.remoteVersion).toBe('1.0.0');
    });
  });

  describe('when network request fails', () => {
    it('should return status error on fetch rejection', async () => {
      const fetchFn = mockFetchError('network error');

      const result = await checkVersion('2.0.0', { fetchFn });

      expect(result.status).toBe('error');
      expect(result.localVersion).toBe('2.0.0');
      expect(result.error).toContain('network error');
    });

    it('should return status error on non-200 response', async () => {
      const fetchFn = mockFetch({}, 404);

      const result = await checkVersion('2.0.0', { fetchFn });

      expect(result.status).toBe('error');
      expect(result.error).toContain('404');
    });

    it('should return status error on invalid JSON response', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      } as unknown as Response);

      const result = await checkVersion('2.0.0', { fetchFn });

      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
    });

    it('should return status error when response lacks version field', async () => {
      const fetchFn = mockFetch({ name: 'exarchos' });

      const result = await checkVersion('2.0.0', { fetchFn });

      expect(result.status).toBe('error');
      expect(result.error).toContain('version');
    });

    it('should return status error when version is not a string', async () => {
      const fetchFn = mockFetch({ version: 123 });

      const result = await checkVersion('2.0.0', { fetchFn });

      expect(result.status).toBe('error');
      expect(result.error).toContain('version');
    });
  });

  describe('options', () => {
    it('should use custom URL when provided', async () => {
      const fetchFn = mockFetch({ version: '2.0.0' });
      const url = 'https://example.com/package.json';

      await checkVersion('2.0.0', { fetchFn, url });

      expect(fetchFn).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('should use default GitHub URL when not provided', async () => {
      const fetchFn = mockFetch({ version: '2.0.0' });

      await checkVersion('2.0.0', { fetchFn });

      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('raw.githubusercontent.com'),
        expect.any(Object),
      );
    });
  });
});

describe('formatVersionWarning', () => {
  it('should include both local and remote versions', () => {
    const result: VersionCheckResult = {
      status: 'outdated',
      localVersion: '1.0.0',
      remoteVersion: '2.0.0',
    };

    const warning = formatVersionWarning(result);

    expect(warning).toContain('1.0.0');
    expect(warning).toContain('2.0.0');
  });

  it('should include the cache-busting npx command', () => {
    const result: VersionCheckResult = {
      status: 'outdated',
      localVersion: '1.0.0',
      remoteVersion: '2.0.0',
    };

    const warning = formatVersionWarning(result);

    expect(warning).toContain('npx -y github:lvlup-sw/exarchos@main');
  });
});
