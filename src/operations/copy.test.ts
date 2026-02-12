import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  computeFileHash,
  computeDirectoryHashes,
  copyFile,
  copyDirectory,
  smartCopy,
  smartCopyDirectory,
  type CopyResult,
  type CopyDirectoryResult,
  type SmartCopyResult,
  type SmartCopyDirectoryResult,
} from './copy.js';

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

describe('copyFile (B1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-copyfile-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copyFile_SourceExists_CopiesAndReturnsHash', () => {
    const source = path.join(tmpDir, 'source.txt');
    const target = path.join(tmpDir, 'target.txt');
    const content = 'hello copy world';
    fs.writeFileSync(source, content, 'utf-8');

    const result: CopyResult = copyFile(source, target);

    // Target file should exist with same content
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe(content);
    // Hash should match the source file hash
    expect(result.hash).toBe(computeFileHash(source));
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    // Bytes written should match content length
    expect(result.bytesWritten).toBe(Buffer.byteLength(content, 'utf-8'));
  });

  it('copyFile_SourceMissing_ThrowsError', () => {
    const source = path.join(tmpDir, 'nonexistent.txt');
    const target = path.join(tmpDir, 'target.txt');

    expect(() => copyFile(source, target)).toThrow(/not found|ENOENT/i);
  });

  it('copyFile_TargetDirMissing_CreatesParentDirs', () => {
    const source = path.join(tmpDir, 'source.txt');
    const target = path.join(tmpDir, 'deep', 'nested', 'dir', 'target.txt');
    fs.writeFileSync(source, 'nested content', 'utf-8');

    const result = copyFile(source, target);

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('nested content');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('copyFile_TargetExists_OverwritesAndReturnsNewHash', () => {
    const source = path.join(tmpDir, 'source.txt');
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(target, 'old content', 'utf-8');
    fs.writeFileSync(source, 'new content', 'utf-8');

    const result = copyFile(source, target);

    expect(fs.readFileSync(target, 'utf-8')).toBe('new content');
    expect(result.hash).toBe(computeFileHash(source));
    expect(result.bytesWritten).toBe(Buffer.byteLength('new content', 'utf-8'));
  });
});

describe('copyDirectory (B2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-copydir-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copyDirectory_FlatDir_CopiesAllFiles', () => {
    const srcDir = path.join(tmpDir, 'src');
    const tgtDir = path.join(tmpDir, 'tgt');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'alpha', 'utf-8');
    fs.writeFileSync(path.join(srcDir, 'b.txt'), 'beta', 'utf-8');

    const result: CopyDirectoryResult = copyDirectory(srcDir, tgtDir);

    expect(fs.readFileSync(path.join(tgtDir, 'a.txt'), 'utf-8')).toBe('alpha');
    expect(fs.readFileSync(path.join(tgtDir, 'b.txt'), 'utf-8')).toBe('beta');
    expect(result.fileCount).toBe(2);
    expect(result.totalBytes).toBe(
      Buffer.byteLength('alpha') + Buffer.byteLength('beta'),
    );
  });

  it('copyDirectory_NestedDir_CopiesRecursively', () => {
    const srcDir = path.join(tmpDir, 'src');
    const tgtDir = path.join(tmpDir, 'tgt');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(path.join(srcDir, 'sub'));
    fs.writeFileSync(path.join(srcDir, 'root.txt'), 'root', 'utf-8');
    fs.writeFileSync(path.join(srcDir, 'sub', 'nested.txt'), 'nested', 'utf-8');

    const result = copyDirectory(srcDir, tgtDir);

    expect(fs.readFileSync(path.join(tgtDir, 'root.txt'), 'utf-8')).toBe('root');
    expect(fs.readFileSync(path.join(tgtDir, 'sub', 'nested.txt'), 'utf-8')).toBe('nested');
    expect(result.fileCount).toBe(2);
    expect(Object.keys(result.hashes)).toHaveLength(2);
  });

  it('copyDirectory_EmptyDir_CreatesEmptyTarget', () => {
    const srcDir = path.join(tmpDir, 'src');
    const tgtDir = path.join(tmpDir, 'tgt');
    fs.mkdirSync(srcDir);

    const result = copyDirectory(srcDir, tgtDir);

    expect(fs.existsSync(tgtDir)).toBe(true);
    expect(fs.readdirSync(tgtDir)).toHaveLength(0);
    expect(result.fileCount).toBe(0);
    expect(result.totalBytes).toBe(0);
    expect(Object.keys(result.hashes)).toHaveLength(0);
  });

  it('copyDirectory_WithFilter_CopiesOnlyMatchingFiles', () => {
    const srcDir = path.join(tmpDir, 'src');
    const tgtDir = path.join(tmpDir, 'tgt');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'keep.md'), 'keep me', 'utf-8');
    fs.writeFileSync(path.join(srcDir, 'skip.txt'), 'skip me', 'utf-8');
    fs.writeFileSync(path.join(srcDir, 'also-keep.md'), 'keep too', 'utf-8');

    const result = copyDirectory(srcDir, tgtDir, (name) => name.endsWith('.md'));

    expect(fs.existsSync(path.join(tgtDir, 'keep.md'))).toBe(true);
    expect(fs.existsSync(path.join(tgtDir, 'also-keep.md'))).toBe(true);
    expect(fs.existsSync(path.join(tgtDir, 'skip.txt'))).toBe(false);
    expect(result.fileCount).toBe(2);
  });

  it('copyDirectory_ReturnsHashMap_AllFileHashes', () => {
    const srcDir = path.join(tmpDir, 'src');
    const tgtDir = path.join(tmpDir, 'tgt');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(path.join(srcDir, 'sub'));
    fs.writeFileSync(path.join(srcDir, 'file1.txt'), 'content1', 'utf-8');
    fs.writeFileSync(path.join(srcDir, 'sub', 'file2.txt'), 'content2', 'utf-8');

    const result = copyDirectory(srcDir, tgtDir);

    expect(result.hashes['file1.txt']).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hashes[path.join('sub', 'file2.txt')]).toMatch(/^[0-9a-f]{64}$/);
    // Hashes should match the source files
    expect(result.hashes['file1.txt']).toBe(computeFileHash(path.join(srcDir, 'file1.txt')));
    expect(result.hashes[path.join('sub', 'file2.txt')]).toBe(
      computeFileHash(path.join(srcDir, 'sub', 'file2.txt')),
    );
  });
});

describe('smartCopy (B3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-smartcopy-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('smartCopy_NewFile_CopiesFile', () => {
    const source = path.join(tmpDir, 'source.txt');
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(source, 'new file content', 'utf-8');

    // No existing hash — file is new
    const result: SmartCopyResult = smartCopy(source, target);

    expect(result.action).toBe('created');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(target, 'utf-8')).toBe('new file content');
  });

  it('smartCopy_UnchangedFile_SkipsFile', () => {
    const source = path.join(tmpDir, 'source.txt');
    const target = path.join(tmpDir, 'target.txt');
    const content = 'unchanged content';
    fs.writeFileSync(source, content, 'utf-8');
    fs.writeFileSync(target, content, 'utf-8');
    const existingHash = computeFileHash(source);

    const result = smartCopy(source, target, existingHash);

    expect(result.action).toBe('skipped');
    expect(result.hash).toBe(existingHash);
  });

  it('smartCopy_ChangedFile_UpdatesFile', () => {
    const source = path.join(tmpDir, 'source.txt');
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(source, 'updated content', 'utf-8');
    fs.writeFileSync(target, 'old content', 'utf-8');
    const oldHash = computeFileHash(target);

    const result = smartCopy(source, target, oldHash);

    expect(result.action).toBe('updated');
    expect(result.hash).toBe(computeFileHash(source));
    expect(fs.readFileSync(target, 'utf-8')).toBe('updated content');
  });

  it('smartCopy_DeletedSource_ReportsRemoval', () => {
    const source = path.join(tmpDir, 'deleted-source.txt');
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(target, 'will be removed', 'utf-8');
    const existingHash = computeFileHash(target);
    // Source does not exist — it was deleted

    const result = smartCopy(source, target, existingHash);

    expect(result.action).toBe('removed');
    expect(result.hash).toBe('');
  });
});

describe('smartCopyDirectory (B3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-smartcopydir-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('smartCopyDirectory_MixedChanges_ReturnsUpdateSummary', () => {
    const srcDir = path.join(tmpDir, 'src');
    const tgtDir = path.join(tmpDir, 'tgt');

    // Set up source with 3 files: new, unchanged, changed
    fs.mkdirSync(srcDir);
    fs.mkdirSync(tgtDir);
    fs.writeFileSync(path.join(srcDir, 'new.txt'), 'brand new', 'utf-8');
    fs.writeFileSync(path.join(srcDir, 'same.txt'), 'same content', 'utf-8');
    fs.writeFileSync(path.join(srcDir, 'changed.txt'), 'updated content', 'utf-8');

    // Set up target with existing files
    fs.writeFileSync(path.join(tgtDir, 'same.txt'), 'same content', 'utf-8');
    fs.writeFileSync(path.join(tgtDir, 'changed.txt'), 'original content', 'utf-8');
    fs.writeFileSync(path.join(tgtDir, 'removed.txt'), 'to be removed', 'utf-8');

    // Existing hashes reflect what was previously installed
    const existingHashes: Record<string, string> = {
      'same.txt': computeFileHash(path.join(tgtDir, 'same.txt')),
      'changed.txt': computeFileHash(path.join(tgtDir, 'changed.txt')),
      'removed.txt': computeFileHash(path.join(tgtDir, 'removed.txt')),
    };

    const result: SmartCopyDirectoryResult = smartCopyDirectory(
      srcDir,
      tgtDir,
      existingHashes,
    );

    expect(result.created).toBe(1);   // new.txt
    expect(result.updated).toBe(1);   // changed.txt
    expect(result.skipped).toBe(1);   // same.txt
    expect(result.removed).toBe(1);   // removed.txt

    // Hashes should include all current files (not removed ones)
    expect(Object.keys(result.hashes)).toHaveLength(3);
    expect(result.hashes['new.txt']).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hashes['same.txt']).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hashes['changed.txt']).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hashes['removed.txt']).toBeUndefined();
  });
});
