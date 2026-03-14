import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');

const ALL_DIMENSIONS = ['topology', 'observability', 'contracts', 'test-fidelity', 'hygiene', 'architecture', 'resilience'];
const INVOKABLE_SKILLS = ['audit', 'critique', 'harden', 'distill', 'verify', 'scan'];

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  return parseYaml(match[1]) as Record<string, unknown>;
}

describe('Dimension Coverage', () => {
  it('DimensionsTaxonomy_AllSeven_DefinedInDimensionsMd', () => {
    const path = resolve(ROOT, 'skills/backend-quality/references/dimensions.md');
    expect(existsSync(path), 'dimensions.md missing').toBe(true);

    const content = readFileSync(path, 'utf-8');
    const expectedHeaders = ['DIM-1', 'DIM-2', 'DIM-3', 'DIM-4', 'DIM-5', 'DIM-6', 'DIM-7'];
    for (const dim of expectedHeaders) {
      expect(content, `Missing dimension: ${dim}`).toContain(dim);
    }
  });

  it('DimensionCoverage_EachDimension_CoveredByAtLeastOneSkill', () => {
    const coverageMap = new Map<string, string[]>();
    for (const dim of ALL_DIMENSIONS) {
      coverageMap.set(dim, []);
    }

    for (const skill of INVOKABLE_SKILLS) {
      const path = resolve(ROOT, 'skills', skill, 'SKILL.md');
      if (!existsSync(path)) continue;

      const content = readFileSync(path, 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm?.metadata) continue;

      const metadata = fm.metadata as Record<string, unknown>;
      const dimensions = metadata.dimensions;
      if (!Array.isArray(dimensions)) continue;

      for (const dim of dimensions as string[]) {
        const normalized = dim.toLowerCase();
        if (normalized === 'all' || normalized === 'pluggable') {
          // 'all' covers everything, 'pluggable' covers on-demand
          for (const d of ALL_DIMENSIONS) {
            coverageMap.get(d)?.push(skill);
          }
        } else if (coverageMap.has(normalized)) {
          coverageMap.get(normalized)?.push(skill);
        }
      }
    }

    for (const [dim, skills] of coverageMap) {
      expect(skills.length, `Dimension '${dim}' not covered by any skill`).toBeGreaterThan(0);
    }
  });

  it('DimensionCoverage_NoSkillDeclaresUndefinedDimension', () => {
    const validDimensions = new Set([...ALL_DIMENSIONS, 'all', 'pluggable']);

    for (const skill of INVOKABLE_SKILLS) {
      const path = resolve(ROOT, 'skills', skill, 'SKILL.md');
      if (!existsSync(path)) continue;

      const content = readFileSync(path, 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm?.metadata) continue;

      const metadata = fm.metadata as Record<string, unknown>;
      const dimensions = metadata.dimensions;
      if (!Array.isArray(dimensions)) continue;

      for (const dim of dimensions as string[]) {
        expect(
          validDimensions.has(dim.toLowerCase()),
          `Skill '${skill}' declares unknown dimension: ${dim}`
        ).toBe(true);
      }
    }
  });
});
