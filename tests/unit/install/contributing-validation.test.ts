import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '../../..');
const contributingPath = join(repoRoot, 'CONTRIBUTING.md');

function readContributing(): string {
  expect(
    existsSync(contributingPath),
    'CONTRIBUTING.md must exist at repo root',
  ).toBe(true);
  return readFileSync(contributingPath, 'utf-8');
}

describe('CONTRIBUTING.md validation', () => {
  /**
   * `build:binary` must sit within 300 characters of prose about the bootstrap
   * script, the compiled output or the install path. The test removes the token
   * from that window before it scans for the context words.
   */
  it('Contributing_MentionsBuildBinary', () => {
    const content = readContributing();

    expect(
      content,
      'CONTRIBUTING.md must mention the `npm run build:binary` command literally',
    ).toContain('npm run build:binary');

    const idx = content.indexOf('build:binary');
    expect(idx, 'build:binary must appear in content').toBeGreaterThanOrEqual(0);
    const windowStart = Math.max(0, idx - 300);
    const windowEnd = Math.min(content.length, idx + 300);
    const windowText = content.slice(windowStart, windowEnd).toLowerCase();
    const contextWithoutToken = windowText.replace(/build:binary/gi, '');
    expect(
      contextWithoutToken.includes('bootstrap') ||
        contextWithoutToken.includes('compiled') ||
        contextWithoutToken.includes('install path') ||
        contextWithoutToken.includes('install location'),
      'build:binary must appear within 300 chars of bootstrap/compiled/install-path context',
    ).toBe(true);
  });

  it('Contributing_LinksToBuildBinaryScript', () => {
    const content = readContributing();
    expect(
      /tools\/release\/build-binary(\.ts)?/.test(content),
      'CONTRIBUTING.md must reference tools/release/build-binary(.ts)',
    ).toBe(true);
  });
});
