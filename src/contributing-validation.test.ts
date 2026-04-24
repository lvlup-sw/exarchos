import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const contributingPath = join(repoRoot, 'CONTRIBUTING.md');

describe('CONTRIBUTING.md validation', () => {
  it('Contributing_MentionsBuildBinary', () => {
    expect(
      existsSync(contributingPath),
      'CONTRIBUTING.md must exist at repo root',
    ).toBe(true);
    const content = readFileSync(contributingPath, 'utf-8');

    expect(
      content,
      'CONTRIBUTING.md must mention the `npm run build:binary` command literally',
    ).toContain('npm run build:binary');

    // Keyword-proximity check: `build:binary` should appear within 300 chars
    // of either `bootstrap` or `binary` (in contextual, non-command prose).
    const idx = content.indexOf('build:binary');
    expect(idx, 'build:binary must appear in content').toBeGreaterThanOrEqual(0);
    const windowStart = Math.max(0, idx - 300);
    const windowEnd = Math.min(content.length, idx + 300);
    const windowText = content.slice(windowStart, windowEnd).toLowerCase();
    expect(
      windowText.includes('bootstrap') || windowText.includes('binary'),
      'build:binary must appear within 300 chars of `bootstrap` or `binary` context',
    ).toBe(true);
  });

  it('Contributing_LinksToBuildBinaryScript', () => {
    expect(existsSync(contributingPath)).toBe(true);
    const content = readFileSync(contributingPath, 'utf-8');
    // Accept either `scripts/build-binary.ts` or `scripts/build-binary` (no ext).
    expect(
      /scripts\/build-binary(\.ts)?/.test(content),
      'CONTRIBUTING.md must reference scripts/build-binary(.ts)',
    ).toBe(true);
  });
});
