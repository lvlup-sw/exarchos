import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');

describe('CLAUDE.md validation', () => {
  const content = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8');

  it('claudeMd_essentialSections_present', () => {
    const requiredPatterns = [
      /##.*build.*test/i,
      /##.*architecture/i,
      /##.*safety/i,
      /##.*key\s+conventions/i,
    ];
    for (const pattern of requiredPatterns) {
      expect(content, `Missing section matching ${pattern}`).toMatch(pattern);
    }
  });

  it('claudeMd_underLineLimit', () => {
    const lines = content.split('\n').length;
    expect(lines, `CLAUDE.md is ${lines} lines, should be under 200`).toBeLessThanOrEqual(200);
  });

  it('claudeMd_hasExistingSections', () => {
    expect(content).toContain('## Build & Test');
    expect(content).toContain('## Key Conventions');
  });
});
