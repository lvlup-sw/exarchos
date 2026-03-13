// ─── Verify Doc Links Tests ──────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock node:fs ────────────────────────────────────────────────────────────

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

import { handleVerifyDocLinks } from './verify-doc-links.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStat(opts: { isFile?: boolean; isDirectory?: boolean }) {
  return {
    isFile: () => opts.isFile ?? false,
    isDirectory: () => opts.isDirectory ?? false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleVerifyDocLinks', () => {
  it('returns error when both docFile and docsDir are missing', () => {
    const result = handleVerifyDocLinks({});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('Either docFile or docsDir is required');
  });

  it('returns passed: true when all links are valid', () => {
    const filePath = '/docs/README.md';
    const content = '[Guide](./guide.md)\n[API](./api.md)\n';

    mockExistsSync.mockImplementation((p: string) => {
      // File exists check, link target checks
      return true;
    });
    mockStatSync.mockReturnValue(makeStat({ isFile: true }));
    mockReadFileSync.mockReturnValue(content);

    const result = handleVerifyDocLinks({ docFile: filePath });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; linksChecked: number; brokenCount: number };
    expect(data.passed).toBe(true);
    expect(data.linksChecked).toBe(2);
    expect(data.brokenCount).toBe(0);
  });

  it('returns passed: false when a broken internal link is found', () => {
    const filePath = '/docs/README.md';
    const content = '[Missing](./missing.md)\n';

    mockExistsSync.mockImplementation((p: string) => {
      if (p === filePath) return true;
      if (p === '/docs/missing.md') return false;
      return true;
    });
    mockStatSync.mockReturnValue(makeStat({ isFile: true }));
    mockReadFileSync.mockReturnValue(content);

    const result = handleVerifyDocLinks({ docFile: filePath });

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      brokenCount: number;
      brokenLinks: readonly { file: string; line: number; target: string; resolved: string }[];
    };
    expect(data.passed).toBe(false);
    expect(data.brokenCount).toBe(1);
    expect(data.brokenLinks[0].file).toBe(filePath);
    expect(data.brokenLinks[0].line).toBe(1);
    expect(data.brokenLinks[0].target).toBe('./missing.md');
  });

  it('skips external URLs (http:// and https://)', () => {
    const filePath = '/docs/README.md';
    const content = '[Google](https://google.com)\n[HTTP](http://example.com)\n';

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(makeStat({ isFile: true }));
    mockReadFileSync.mockReturnValue(content);

    const result = handleVerifyDocLinks({ docFile: filePath });

    expect(result.success).toBe(true);
    const data = result.data as { linksChecked: number; linksSkipped: number };
    expect(data.linksChecked).toBe(0);
    expect(data.linksSkipped).toBe(2);
  });

  it('skips anchor-only links (#section)', () => {
    const filePath = '/docs/README.md';
    const content = '[Section](#overview)\n[Another](#details)\n';

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(makeStat({ isFile: true }));
    mockReadFileSync.mockReturnValue(content);

    const result = handleVerifyDocLinks({ docFile: filePath });

    expect(result.success).toBe(true);
    const data = result.data as { linksChecked: number; linksSkipped: number };
    expect(data.linksChecked).toBe(0);
    expect(data.linksSkipped).toBe(2);
  });

  it('strips anchors from file links and checks the file part', () => {
    const filePath = '/docs/README.md';
    const content = '[Guide Section](./guide.md#installation)\n';

    mockExistsSync.mockImplementation((p: string) => {
      if (p === filePath) return true;
      if (p === '/docs/guide.md') return true;
      return false;
    });
    mockStatSync.mockReturnValue(makeStat({ isFile: true }));
    mockReadFileSync.mockReturnValue(content);

    const result = handleVerifyDocLinks({ docFile: filePath });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; linksChecked: number };
    expect(data.passed).toBe(true);
    expect(data.linksChecked).toBe(1);
    // Should have checked /docs/guide.md, not /docs/guide.md#installation
    expect(mockExistsSync).toHaveBeenCalledWith('/docs/guide.md');
  });

  it('finds .md files recursively in directory mode', () => {
    const docsDir = '/project/docs';

    // Setup directory structure: docs/ has sub/ dir and root.md; sub/ has nested.md
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockImplementation((p: string) => {
      if (p === docsDir) return makeStat({ isDirectory: true });
      if (p === '/project/docs/sub') return makeStat({ isDirectory: true });
      return makeStat({ isFile: true });
    });
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === docsDir) return ['root.md', 'sub'];
      if (dir === '/project/docs/sub') return ['nested.md'];
      return [];
    });
    mockReadFileSync.mockReturnValue('No links here.\n');

    const result = handleVerifyDocLinks({ docsDir });

    expect(result.success).toBe(true);
    const data = result.data as { filesChecked: number; passed: boolean };
    expect(data.filesChecked).toBe(2);
    expect(data.passed).toBe(true);
  });

  it('returns passed: true for an empty file with no links', () => {
    const filePath = '/docs/empty.md';
    const content = 'Just some text, no links at all.\n';

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue(makeStat({ isFile: true }));
    mockReadFileSync.mockReturnValue(content);

    const result = handleVerifyDocLinks({ docFile: filePath });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; linksChecked: number; brokenCount: number };
    expect(data.passed).toBe(true);
    expect(data.linksChecked).toBe(0);
    expect(data.brokenCount).toBe(0);
  });

  it('returns error when docFile does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = handleVerifyDocLinks({ docFile: '/nonexistent.md' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('File not found');
  });

  it('returns error when docsDir does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = handleVerifyDocLinks({ docsDir: '/nonexistent-dir' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('Directory not found');
  });
});
