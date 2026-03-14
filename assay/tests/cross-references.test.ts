import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const SKILLS_WITH_REFS = ['backend-quality', 'audit', 'critique', 'harden', 'distill', 'verify', 'scan'];

describe('Cross References', () => {
  it.each(SKILLS_WITH_REFS)('AllSkills_CrossReferences_ResolveToExistingFiles — %s', (skill) => {
    const skillPath = resolve(ROOT, 'skills', skill, 'SKILL.md');
    if (!existsSync(skillPath)) return; // Tested by frontmatter suite

    const content = readFileSync(skillPath, 'utf-8');
    // Match @skills/xxx/references/yyy.md patterns
    const refs = content.matchAll(/@skills\/([a-z-]+)\/references\/([a-z-]+\.md)/g);
    for (const match of refs) {
      const refPath = resolve(ROOT, 'skills', match[1], 'references', match[2]);
      expect(existsSync(refPath), `Broken reference: @skills/${match[1]}/references/${match[2]}`).toBe(true);
    }
  });

  it.each(SKILLS_WITH_REFS)('AllSkills_ReferencesDir_AllFilesReferencedBySkill — %s', (skill) => {
    const refsDir = resolve(ROOT, 'skills', skill, 'references');
    if (!existsSync(refsDir)) return;

    const skillPath = resolve(ROOT, 'skills', skill, 'SKILL.md');
    if (!existsSync(skillPath)) return;

    const content = readFileSync(skillPath, 'utf-8');
    const refFiles = readdirSync(refsDir).filter(f => f.endsWith('.md'));

    for (const file of refFiles) {
      const referenced = content.includes(file);
      expect(referenced, `${skill}/references/${file} exists but is not referenced in SKILL.md`).toBe(true);
    }
  });
});
