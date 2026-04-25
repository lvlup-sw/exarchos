import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkPluginRootCompatibility, compareSemver } from './plugin-compat.js';

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('plugin-compat library', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-compat-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Helper — write a .claude-plugin/plugin.json under the given root.
  async function writePluginJson(root: string, body: unknown): Promise<void> {
    const dir = path.join(root, '.claude-plugin');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(body), 'utf-8');
  }

  describe('checkPluginRootCompatibility', () => {
    it('CheckCompat_PluginRootMissing_ReturnsNonFatal', () => {
      // Arrange — path that does not exist on disk.
      const missingRoot = path.join(tmpDir, 'does-not-exist');

      // Act
      const result = checkPluginRootCompatibility(missingRoot, '2.9.0');

      // Assert — missing plugin.json is a non-fatal warning.
      expect(result.compatible).toBe(true);
      expect(result.minRequired).toBeNull();
      expect(result.actual).toBe('2.9.0');
      expect(result.message).toContain('plugin.json');
    });

    it('CheckCompat_MinVersionSatisfied_ReturnsCompatible', async () => {
      // Arrange — plugin.json with a satisfied min version.
      await writePluginJson(tmpDir, {
        name: 'exarchos',
        version: '2.9.0',
        metadata: { compat: { minBinaryVersion: '2.8.0' } },
      });

      // Act
      const result = checkPluginRootCompatibility(tmpDir, '2.9.0');

      // Assert
      expect(result.compatible).toBe(true);
      expect(result.minRequired).toBe('2.8.0');
      expect(result.actual).toBe('2.9.0');
    });

    it('CheckCompat_MinVersionUnsatisfied_ReturnsIncompatible', async () => {
      // Arrange — plugin.json declares a newer binary than we have.
      await writePluginJson(tmpDir, {
        name: 'exarchos',
        metadata: { compat: { minBinaryVersion: '3.0.0' } },
      });

      // Act
      const result = checkPluginRootCompatibility(tmpDir, '2.9.0');

      // Assert
      expect(result.compatible).toBe(false);
      expect(result.minRequired).toBe('3.0.0');
      expect(result.actual).toBe('2.9.0');
      // Human-readable message should name the required version.
      expect(result.message).toContain('3.0.0');
    });

    it('CheckCompat_NoCompatMetadata_ReturnsNonFatal', async () => {
      // Arrange — plugin.json present but without metadata.compat.
      await writePluginJson(tmpDir, {
        name: 'exarchos',
        version: '2.8.3',
      });

      // Act
      const result = checkPluginRootCompatibility(tmpDir, '2.9.0');

      // Assert — absent metadata is a non-fatal warning, not an error.
      expect(result.compatible).toBe(true);
      expect(result.minRequired).toBeNull();
      expect(result.message).toContain('compat');
    });

    it('CheckCompat_MalformedPluginJson_ReturnsNonFatal', async () => {
      // Arrange — .claude-plugin/plugin.json exists but isn't valid JSON.
      const dir = path.join(tmpDir, '.claude-plugin');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'plugin.json'), '{ not json }', 'utf-8');

      // Act
      const result = checkPluginRootCompatibility(tmpDir, '2.9.0');

      // Assert — never throw; surface a non-fatal warning.
      expect(result.compatible).toBe(true);
      expect(result.minRequired).toBeNull();
    });
  });

  // ─── Semver helper edge cases ─────────────────────────────────────────────

  describe('compareSemver', () => {
    it('returns 0 when versions are exactly equal', () => {
      expect(compareSemver('2.9.0', '2.9.0')).toBe(0);
    });

    it('returns positive when first version is greater by major', () => {
      expect(compareSemver('3.0.0', '2.9.0')).toBeGreaterThan(0);
    });

    it('returns negative when first version is less by minor', () => {
      expect(compareSemver('2.8.0', '2.9.0')).toBeLessThan(0);
    });

    it('returns positive when first version is greater by patch', () => {
      expect(compareSemver('2.9.1', '2.9.0')).toBeGreaterThan(0);
    });

    it('treats a prerelease as less than its release', () => {
      // 2.9.0-beta.1 < 2.9.0 per semver precedence rules.
      expect(compareSemver('2.9.0-beta.1', '2.9.0')).toBeLessThan(0);
    });

    it('orders prereleases lexicographically within the same release', () => {
      // alpha < beta < rc
      expect(compareSemver('2.9.0-alpha', '2.9.0-beta')).toBeLessThan(0);
      expect(compareSemver('2.9.0-rc.1', '2.9.0-beta')).toBeGreaterThan(0);
    });

    it('tolerates missing patch segments as 0', () => {
      // "2.9" is treated as "2.9.0" — non-strict semver normalization.
      expect(compareSemver('2.9', '2.9.0')).toBe(0);
      expect(compareSemver('2.10', '2.9.9')).toBeGreaterThan(0);
    });

    it('tolerates a leading v prefix', () => {
      expect(compareSemver('v2.9.0', '2.9.0')).toBe(0);
      expect(compareSemver('v3.0.0', 'v2.9.0')).toBeGreaterThan(0);
    });
  });
});
