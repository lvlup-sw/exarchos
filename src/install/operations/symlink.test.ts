import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createSymlink,
  removeSymlink,
  validateSymlinks,
  type SymlinkResult,
  type RemoveResult,
  type SymlinkHealthReport,
} from './symlink.js';

describe('createSymlink (B4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-symlink-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createSymlink_NoExistingTarget_CreatesLink', () => {
    const source = path.join(tmpDir, 'source-dir');
    const target = path.join(tmpDir, 'link');
    fs.mkdirSync(source);

    const result: SymlinkResult = createSymlink(source, target);

    expect(result).toBe('created');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(source);
  });

  it('createSymlink_ExistingCorrectLink_Skips', () => {
    const source = path.join(tmpDir, 'source-dir');
    const target = path.join(tmpDir, 'link');
    fs.mkdirSync(source);
    fs.symlinkSync(source, target);

    const result = createSymlink(source, target);

    expect(result).toBe('skipped');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(source);
  });

  it('createSymlink_ExistingWrongLink_Relinks', () => {
    const source = path.join(tmpDir, 'correct-source');
    const wrongSource = path.join(tmpDir, 'wrong-source');
    const target = path.join(tmpDir, 'link');
    fs.mkdirSync(source);
    fs.mkdirSync(wrongSource);
    fs.symlinkSync(wrongSource, target);

    const result = createSymlink(source, target);

    expect(result).toBe('relinked');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(source);
  });

  it('createSymlink_ExistingDirectory_BacksUpAndLinks', () => {
    const source = path.join(tmpDir, 'source-dir');
    const target = path.join(tmpDir, 'existing-dir');
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'file.txt'), 'preserved', 'utf-8');

    const result = createSymlink(source, target);

    expect(result).toBe('backed_up');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(source);

    // Verify backup directory exists
    const entries = fs.readdirSync(tmpDir);
    const backupEntry = entries.find(
      (e) => e.startsWith('existing-dir.backup.'),
    );
    expect(backupEntry).toBeDefined();

    // Verify backup contents preserved
    const backupPath = path.join(tmpDir, backupEntry!);
    expect(
      fs.readFileSync(path.join(backupPath, 'file.txt'), 'utf-8'),
    ).toBe('preserved');
  });
});

describe('removeSymlink (B4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-rmsymlink-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removeSymlink_ExistingLink_Removes', () => {
    const source = path.join(tmpDir, 'source');
    const target = path.join(tmpDir, 'link');
    fs.mkdirSync(source);
    fs.symlinkSync(source, target);

    const result: RemoveResult = removeSymlink(target);

    expect(result).toBe('removed');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('removeSymlink_NotALink_Skips', () => {
    const target = path.join(tmpDir, 'regular-dir');
    fs.mkdirSync(target);

    const result = removeSymlink(target);

    expect(result).toBe('skipped');
    // Directory should still exist
    expect(fs.existsSync(target)).toBe(true);
  });

  it('removeSymlink_Missing_Skips', () => {
    const target = path.join(tmpDir, 'nonexistent');

    const result = removeSymlink(target);

    expect(result).toBe('skipped');
  });
});

describe('validateSymlinks (B5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-validate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validateSymlinks_AllValid_ReturnsHealthy', () => {
    const src1 = path.join(tmpDir, 'src1');
    const src2 = path.join(tmpDir, 'src2');
    const tgt1 = path.join(tmpDir, 'link1');
    const tgt2 = path.join(tmpDir, 'link2');
    fs.mkdirSync(src1);
    fs.mkdirSync(src2);
    fs.symlinkSync(src1, tgt1);
    fs.symlinkSync(src2, tgt2);

    const report: SymlinkHealthReport = validateSymlinks({
      [tgt1]: src1,
      [tgt2]: src2,
    });

    expect(report.healthy).toHaveLength(2);
    expect(report.healthy).toContain(tgt1);
    expect(report.healthy).toContain(tgt2);
    expect(report.broken).toHaveLength(0);
    expect(report.missing).toHaveLength(0);
  });

  it('validateSymlinks_BrokenLink_ReturnsBroken', () => {
    const src = path.join(tmpDir, 'deleted-source');
    const tgt = path.join(tmpDir, 'link');
    // Create link then remove source
    fs.mkdirSync(src);
    fs.symlinkSync(src, tgt);
    fs.rmSync(src, { recursive: true, force: true });

    const report = validateSymlinks({ [tgt]: src });

    expect(report.healthy).toHaveLength(0);
    expect(report.broken).toHaveLength(1);
    expect(report.broken).toContain(tgt);
    expect(report.missing).toHaveLength(0);
  });

  it('validateSymlinks_MissingLink_ReturnsMissing', () => {
    const src = path.join(tmpDir, 'source');
    const tgt = path.join(tmpDir, 'missing-link');
    fs.mkdirSync(src);
    // Link does not exist at all

    const report = validateSymlinks({ [tgt]: src });

    expect(report.healthy).toHaveLength(0);
    expect(report.broken).toHaveLength(0);
    expect(report.missing).toHaveLength(1);
    expect(report.missing).toContain(tgt);
  });

  it('validateSymlinks_MixedState_ReturnsDetailedReport', () => {
    const healthySrc = path.join(tmpDir, 'healthy-src');
    const healthyTgt = path.join(tmpDir, 'healthy-link');
    const brokenSrc = path.join(tmpDir, 'broken-src');
    const brokenTgt = path.join(tmpDir, 'broken-link');
    const missingSrc = path.join(tmpDir, 'missing-src');
    const missingTgt = path.join(tmpDir, 'missing-link');

    // Healthy: source exists, link correct
    fs.mkdirSync(healthySrc);
    fs.symlinkSync(healthySrc, healthyTgt);

    // Broken: link exists but source was removed
    fs.mkdirSync(brokenSrc);
    fs.symlinkSync(brokenSrc, brokenTgt);
    fs.rmSync(brokenSrc, { recursive: true, force: true });

    // Missing: source exists but link does not
    fs.mkdirSync(missingSrc);

    const report = validateSymlinks({
      [healthyTgt]: healthySrc,
      [brokenTgt]: brokenSrc,
      [missingTgt]: missingSrc,
    });

    expect(report.healthy).toEqual([healthyTgt]);
    expect(report.broken).toEqual([brokenTgt]);
    expect(report.missing).toEqual([missingTgt]);
  });
});
