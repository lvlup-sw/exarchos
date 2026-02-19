import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');

describe('CLAUDE.md rules consolidation', () => {
  const content = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8');

  it('claudeMd_essentialRuleSections_present', () => {
    // Check for essential sections (case-insensitive header matching)
    const requiredPatterns = [
      /##.*coding\s+standards/i,
      /##.*tdd/i,
      /##.*orchestrator/i,
      /##.*workflow/i,
      /##.*mcp.*tool/i,
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
    // Existing sections that should be preserved
    expect(content).toContain('## Build & Test');
    expect(content).toContain('## Key Conventions');
  });
});
