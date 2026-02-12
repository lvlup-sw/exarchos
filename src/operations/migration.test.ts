import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { detectV1Install, migrateV1, getV1RepoPath } from './migration.js';

describe('V1 Migration', () => {
  let tmpDir: string;
  let claudeHome: string;
  let fakeRepoRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
    claudeHome = path.join(tmpDir, '.claude');
    fakeRepoRoot = path.join(tmpDir, 'exarchos-repo');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(fakeRepoRoot, { recursive: true });
    // Create fake repo content directories
    fs.mkdirSync(path.join(fakeRepoRoot, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(fakeRepoRoot, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(fakeRepoRoot, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(fakeRepoRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(fakeRepoRoot, 'settings.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectV1Install', () => {
    it('detectV1Install_SymlinkedSkills_ReturnsTrue', () => {
      // Create symlink from claudeHome/skills -> fakeRepoRoot/skills (v1 pattern)
      fs.symlinkSync(
        path.join(fakeRepoRoot, 'skills'),
        path.join(claudeHome, 'skills'),
      );

      const result = detectV1Install(claudeHome);

      expect(result.isV1).toBe(true);
      expect(result.repoPath).not.toBeNull();
    });

    it('detectV1Install_CopiedSkills_ReturnsFalse', () => {
      // Create a real directory (not a symlink) — v2 standard mode
      fs.mkdirSync(path.join(claudeHome, 'skills'), { recursive: true });
      fs.writeFileSync(
        path.join(claudeHome, 'skills', 'test.md'),
        'content',
      );

      const result = detectV1Install(claudeHome);

      expect(result.isV1).toBe(false);
      expect(result.repoPath).toBeNull();
    });

    it('detectV1Install_NoSkills_ReturnsFalse', () => {
      // No skills directory at all
      const result = detectV1Install(claudeHome);

      expect(result.isV1).toBe(false);
      expect(result.repoPath).toBeNull();
    });
  });

  describe('getV1RepoPath', () => {
    it('getV1RepoPath_FromSymlink_ReturnsRepoRoot', () => {
      // Symlink skills -> fakeRepoRoot/skills
      fs.symlinkSync(
        path.join(fakeRepoRoot, 'skills'),
        path.join(claudeHome, 'skills'),
      );

      const result = getV1RepoPath(claudeHome);

      // Should resolve to fakeRepoRoot (parent of 'skills')
      expect(result).toBe(fakeRepoRoot);
    });

    it('getV1RepoPath_NoSymlink_ReturnsNull', () => {
      const result = getV1RepoPath(claudeHome);
      expect(result).toBeNull();
    });
  });

  describe('migrateV1', () => {
    it('migrateV1_RemovesSymlinks_ReturnsRemovedPaths', () => {
      // Create v1 symlinks
      const symlinkDirs = ['skills', 'commands', 'rules', 'scripts'];
      for (const dir of symlinkDirs) {
        fs.symlinkSync(
          path.join(fakeRepoRoot, dir),
          path.join(claudeHome, dir),
        );
      }
      fs.symlinkSync(
        path.join(fakeRepoRoot, 'settings.json'),
        path.join(claudeHome, 'settings.json'),
      );

      const result = migrateV1(claudeHome);

      expect(result.removedSymlinks.length).toBeGreaterThanOrEqual(5);
      // Verify symlinks are actually gone
      for (const dir of symlinkDirs) {
        const targetPath = path.join(claudeHome, dir);
        expect(fs.existsSync(targetPath)).toBe(false);
      }
      expect(fs.existsSync(path.join(claudeHome, 'settings.json'))).toBe(false);
      expect(result.repoPath).toBe(fakeRepoRoot);
    });

    it('migrateV1_PreservesNonExarchosFiles_InClaudeDir', () => {
      // Create v1 symlinks
      fs.symlinkSync(
        path.join(fakeRepoRoot, 'skills'),
        path.join(claudeHome, 'skills'),
      );

      // Create non-Exarchos files that should be preserved
      fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
      fs.writeFileSync(
        path.join(claudeHome, 'projects', 'user-config.json'),
        '{"user": true}',
      );
      fs.writeFileSync(
        path.join(claudeHome, 'custom-file.txt'),
        'preserve me',
      );

      migrateV1(claudeHome);

      // Verify non-Exarchos files are preserved
      expect(
        fs.existsSync(path.join(claudeHome, 'projects', 'user-config.json')),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(claudeHome, 'custom-file.txt')),
      ).toBe(true);
    });
  });
});
