import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { computeFileHash, computeDirectoryHashes } from './copy.js';

describe('Content Hash Utilities (A4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-hash-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('computeFileHash', () => {
    it('computeFileHash_ExistingFile_ReturnsSha256', () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'hello world', 'utf-8');

      const hash = computeFileHash(filePath);

      // SHA-256 hex digest is always 64 characters
      expect(hash).toHaveLength(64);
      // Must be lowercase hex
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('computeFileHash_SameContent_ReturnsSameHash', () => {
      const file1 = path.join(tmpDir, 'a.txt');
      const file2 = path.join(tmpDir, 'b.txt');
      fs.writeFileSync(file1, 'identical content', 'utf-8');
      fs.writeFileSync(file2, 'identical content', 'utf-8');

      const hash1 = computeFileHash(file1);
      const hash2 = computeFileHash(file2);

      expect(hash1).toBe(hash2);
    });

    it('computeFileHash_DifferentContent_ReturnsDifferentHash', () => {
      const file1 = path.join(tmpDir, 'a.txt');
      const file2 = path.join(tmpDir, 'b.txt');
      fs.writeFileSync(file1, 'content alpha', 'utf-8');
      fs.writeFileSync(file2, 'content beta', 'utf-8');

      const hash1 = computeFileHash(file1);
      const hash2 = computeFileHash(file2);

      expect(hash1).not.toBe(hash2);
    });

    it('computeFileHash_MissingFile_ThrowsError', () => {
      const badPath = path.join(tmpDir, 'nonexistent.txt');

      expect(() => computeFileHash(badPath)).toThrow(/not found|ENOENT/i);
    });
  });

  describe('computeDirectoryHashes', () => {
    it('computeDirectoryHashes_Directory_ReturnsAllFileHashes', () => {
      // Create a directory structure
      fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'content 1', 'utf-8');
      fs.mkdirSync(path.join(tmpDir, 'sub'));
      fs.writeFileSync(path.join(tmpDir, 'sub', 'file2.txt'), 'content 2', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'sub', 'file3.md'), 'content 3', 'utf-8');

      const hashes = computeDirectoryHashes(tmpDir);

      // Should include all three files with relative paths
      expect(Object.keys(hashes)).toHaveLength(3);
      expect(hashes['file1.txt']).toBeDefined();
      expect(hashes[path.join('sub', 'file2.txt')]).toBeDefined();
      expect(hashes[path.join('sub', 'file3.md')]).toBeDefined();

      // Each hash should be a valid SHA-256 hex
      for (const hash of Object.values(hashes)) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('computeDirectoryHashes_SkipsHiddenFiles_ReturnsOnlyVisible', () => {
      // Create visible and hidden files
      fs.writeFileSync(path.join(tmpDir, 'visible.txt'), 'visible', 'utf-8');
      fs.writeFileSync(path.join(tmpDir, '.hidden'), 'hidden', 'utf-8');
      fs.mkdirSync(path.join(tmpDir, '.hidden-dir'));
      fs.writeFileSync(
        path.join(tmpDir, '.hidden-dir', 'nested.txt'),
        'nested in hidden',
        'utf-8',
      );

      const hashes = computeDirectoryHashes(tmpDir);

      // Should only include the visible file
      expect(Object.keys(hashes)).toHaveLength(1);
      expect(hashes['visible.txt']).toBeDefined();
      expect(hashes['.hidden']).toBeUndefined();
      expect(hashes[path.join('.hidden-dir', 'nested.txt')]).toBeUndefined();
    });

    it('computeDirectoryHashes_EmptyDirectory_ReturnsEmptyObject', () => {
      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir);

      const hashes = computeDirectoryHashes(emptyDir);

      expect(Object.keys(hashes)).toHaveLength(0);
    });
  });
});
