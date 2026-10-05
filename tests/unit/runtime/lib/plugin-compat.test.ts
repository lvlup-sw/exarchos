import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkPluginRootCompatibility, compareSemver } from '../../../../src/runtime/lib/plugin-compat.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The helper `writePluginJson` writes `.claude-plugin/plugin.json` below the given root. */
describe('plugin-compat library', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-compat-test-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  async function writePluginJson(root: string, body: unknown): Promise<void> {
    const dir = path.join(root, '.claude-plugin');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(body), 'utf-8');
  }

  /** A non-fatal result has `compatible: true` and `minRequired: null`. */
  describe('checkPluginRootCompatibility', () => {
    it('CheckCompat_PluginRootMissing_ReturnsNonFatal', () => {
      const missingRoot = path.join(tmpDir, 'does-not-exist');

      const result = checkPluginRootCompatibility(missingRoot, '2.9.0');

      expect(result.compatible).toBe(true);
      expect(result.minRequired).toBeNull();
      expect(result.actual).toBe('2.9.0');
      expect(result.message).toContain('plugin.json');
    });

    it('CheckCompat_MinVersionSatisfied_ReturnsCompatible', async () => {
      await writePluginJson(tmpDir, {
        name: 'exarchos',
        version: '2.9.0',
        metadata: { compat: { minBinaryVersion: '2.8.0' } },
      });

      const result = checkPluginRootCompatibility(tmpDir, '2.9.0');

      expect(result.compatible).toBe(true);
      expect(result.minRequired).toBe('2.8.0');
      expect(result.actual).toBe('2.9.0');
    });

    it('CheckCompat_MinVersionUnsatisfied_ReturnsIncompatible', async () => {
      await writePluginJson(tmpDir, {
        name: 'exarchos',
        metadata: { compat: { minBinaryVersion: '3.0.0' } },
      });

      const result = checkPluginRootCompatibility(tmpDir, '2.9.0');

      expect(result.compatible).toBe(false);
      expect(result.minRequired).toBe('3.0.0');
      expect(result.actual).toBe('2.9.0');
      expect(result.message).toContain('3.0.0');
    });

    it('CheckCompat_NoCompatMetadata_ReturnsNonFatal', async () => {
      await writePluginJson(tmpDir, {
        name: 'exarchos',
        version: '2.8.3',
      });

      const result = checkPluginRootCompatibility(tmpDir, '2.9.0');

      expect(result.compatible).toBe(true);
      expect(result.minRequired).toBeNull();
      expect(result.message).toContain('compat');
    });

    it('CheckCompat_MalformedPluginJson_ReturnsNonFatal', async () => {
      const dir = path.join(tmpDir, '.claude-plugin');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'plugin.json'), '{ not json }', 'utf-8');

      const result = checkPluginRootCompatibility(tmpDir, '2.9.0');

      expect(result.compatible).toBe(true);
      expect(result.minRequired).toBeNull();
    });
  });

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
      expect(compareSemver('2.9.0-beta.1', '2.9.0')).toBeLessThan(0);
    });

    it('orders prereleases lexicographically within the same release', () => {
      expect(compareSemver('2.9.0-alpha', '2.9.0-beta')).toBeLessThan(0);
      expect(compareSemver('2.9.0-rc.1', '2.9.0-beta')).toBeGreaterThan(0);
    });

    it('tolerates missing patch segments as 0', () => {
      expect(compareSemver('2.9', '2.9.0')).toBe(0);
      expect(compareSemver('2.10', '2.9.9')).toBeGreaterThan(0);
    });

    it('tolerates a leading v prefix', () => {
      expect(compareSemver('v2.9.0', '2.9.0')).toBe(0);
      expect(compareSemver('v3.0.0', 'v2.9.0')).toBeGreaterThan(0);
    });
  });
});
