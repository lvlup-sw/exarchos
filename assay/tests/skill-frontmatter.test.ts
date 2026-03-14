import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');

const INVOKABLE_SKILLS = ['audit', 'critique', 'harden', 'distill', 'verify', 'scan'];
const ALL_SKILLS = ['backend-quality', ...INVOKABLE_SKILLS];

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function readSkill(name: string): string {
  const path = resolve(ROOT, 'skills', name, 'SKILL.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

describe('Skill Frontmatter', () => {
  it.each(ALL_SKILLS)('AllSkills_Frontmatter_HasNameAndDescription — %s', (skill) => {
    const content = readSkill(skill);
    expect(content, `${skill}/SKILL.md missing`).not.toBe('');
    const fm = parseFrontmatter(content);
    expect(fm, `${skill} has no frontmatter`).not.toBeNull();
    expect(fm!.name).toBeDefined();
    expect(fm!.description).toBeDefined();
  });

  it.each(INVOKABLE_SKILLS)('AllInvokableSkills_Description_Under1024Chars — %s', (skill) => {
    const content = readSkill(skill);
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(typeof fm!.description, `${skill} description must be a string`).toBe('string');
    const desc = fm!.description as string;
    expect(desc.length, `${skill} description is ${desc.length} chars`).toBeLessThanOrEqual(1024);
  });

  it.each(INVOKABLE_SKILLS)('InvokableSkills_Body_HasTriggerDocumentation — %s', (skill) => {
    const content = readSkill(skill);
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(typeof fm!.description, `${skill} description must be a string`).toBe('string');
    const desc = fm!.description as string;
    // Triggers should be documented in the description or in a Triggers section
    const hasTriggerKeywords = /trigger|use when|run when|invoke when/i.test(desc) ||
      /## Triggers/i.test(content);
    expect(hasTriggerKeywords, `${skill} has no trigger documentation`).toBe(true);
  });

  it.each(INVOKABLE_SKILLS)('InvokableSkills_DimensionsMetadata_Declared — %s', (skill) => {
    const content = readSkill(skill);
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    const metadata = fm!.metadata as Record<string, unknown> | undefined;
    expect(metadata, `${skill} missing metadata`).toBeDefined();
    expect(metadata!.dimensions, `${skill} missing metadata.dimensions`).toBeDefined();
  });
});
