import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function collectMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Match Skill({ skill: "X" where X does NOT start with a namespace prefix (word:)
// Allows exarchos: and companion plugin namespaces (axiom:, impeccable:, etc.)
const UN_NAMESPACED_SKILL = /Skill\(\{\s*skill:\s*"(?![a-z][-a-z]*:)[a-z]/g;

function findUnNamespacedSkillCalls(dir: string): string[] {
  const files = collectMdFiles(dir);
  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const matches = content.match(UN_NAMESPACED_SKILL);
    if (matches) {
      violations.push(`${relative(repoRoot, file)}: ${matches.length} un-namespaced Skill() invocations`);
    }
  }
  return violations;
}

// Explicit `name:` frontmatter in a command file bypasses the plugin
// namespace — surfaces the command as bare `/X` instead of `/exarchos:X`.
// Let the plugin loader derive the name from the filename instead.
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/m;
const NAME_KEY = /^name:\s*\S+/m;

function findExplicitNameFrontmatter(dir: string): string[] {
  const files = collectMdFiles(dir);
  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const match = FRONTMATTER_BLOCK.exec(content);
    if (match && NAME_KEY.test(match[1])) {
      violations.push(relative(repoRoot, file));
    }
  }
  return violations;
}

describe('Command namespacing', () => {
  it('scanCommandFiles_UnNamespacedSkillInvocations_ReportsViolations', () => {
    const violations = findUnNamespacedSkillCalls(join(repoRoot, 'commands'));
    expect(violations, `Un-namespaced Skill() calls in commands:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('scanSkillFiles_UnNamespacedSkillInvocations_ReportsViolations', () => {
    const violations = findUnNamespacedSkillCalls(join(repoRoot, 'skills'));
    expect(violations, `Un-namespaced Skill() calls in skills:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('scanCommandFiles_ExplicitNameFrontmatter_ReportsViolations', () => {
    const violations = findExplicitNameFrontmatter(join(repoRoot, 'commands'));
    expect(
      violations,
      `Command files with explicit \`name:\` frontmatter (breaks plugin namespacing — remove the field so the loader derives it from the filename):\n${violations.join('\n')}`,
    ).toHaveLength(0);
  });
});
