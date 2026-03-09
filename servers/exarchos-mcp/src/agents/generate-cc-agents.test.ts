// ─── CC Agent File Generator Tests ──────────────────────────────────────────
//
// Tests for generating Claude Code agent definition (.md) files from the
// agent spec registry. Verifies frontmatter structure, hook mapping,
// optional field handling, and bulk file generation.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateAgentMarkdown, buildHooksFromRules, generateAllAgentFiles } from './generate-cc-agents.js';
import { IMPLEMENTER, FIXER, REVIEWER, ALL_AGENT_SPECS } from './definitions.js';

// ─── Helper: Parse Frontmatter ────────────────────────────────────────────

function parseFrontmatter(md: string): Record<string, string> {
  const parts = md.split('---');
  if (parts.length < 3) return {};
  const yaml = parts[1].trim();
  const result: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return result;
}

function getBody(md: string): string {
  const parts = md.split('---');
  if (parts.length < 3) return '';
  return parts.slice(2).join('---').trim();
}

// ─── Task 6: Generate CC Agent Files ──────────────────────────────────────

describe('GenerateAgentMarkdown', () => {
  it('GenerateAgentMarkdown_Implementer_HasCorrectFrontmatter', () => {
    // Act
    const md = generateAgentMarkdown(IMPLEMENTER);
    const fm = parseFrontmatter(md);

    // Assert: required frontmatter fields
    expect(fm.name).toBe('exarchos-implementer');
    expect(fm.description).toBeTruthy();
    expect(fm.tools).toBe('Read, Write, Edit, Bash, Grep, Glob');
    expect(fm.model).toBe('opus');
    expect(fm.isolation).toBe('worktree');
    expect(fm.memory).toBe('project');

    // maxTurns should be absent since IMPLEMENTER doesn't define it
    // but the field should appear if the spec defines it

    // Body should be the system prompt
    const body = getBody(md);
    expect(body).toContain('You are a TDD implementer agent');
  });

  it('GenerateAgentMarkdown_Implementer_HasHooksFromRules', () => {
    // Act
    const md = generateAgentMarkdown(IMPLEMENTER);

    // Assert: hooks section present in frontmatter
    // IMPLEMENTER has pre-write (no command, skipped) and post-test (has command) rules
    expect(md).toContain('hooks:');
    expect(md).toContain('PostToolUse:');
    expect(md).toContain('matcher: "Bash"');
    expect(md).toContain('command: "npm run test:run"');
  });

  it('GenerateAgentMarkdown_Reviewer_OmitsOptionalFields', () => {
    // Act
    const md = generateAgentMarkdown(REVIEWER);
    const fm = parseFrontmatter(md);

    // Assert: no isolation (REVIEWER doesn't define it)
    expect(fm.isolation).toBeUndefined();
    // Assert: no maxTurns
    expect(fm.maxTurns).toBeUndefined();
    // Assert: no memory (REVIEWER doesn't define memoryScope)
    expect(fm.memory).toBeUndefined();
    // Assert: no hooks section since REVIEWER has no validation rules with commands
    expect(md).not.toContain('hooks:');
    // Assert: no skills section (empty array)
    expect(md).not.toMatch(/^skills:/m);
  });

  it('GenerateAgentMarkdown_Fixer_DisallowedToolsPresent', () => {
    // Act
    const md = generateAgentMarkdown(FIXER);
    const fm = parseFrontmatter(md);

    // Assert: disallowedTools present
    expect(fm.disallowedTools).toBe('Agent');
  });
});

describe('BuildHooksFromRules', () => {
  it('BuildHooksFromRules_PreWrite_MapsToWriteEditMatcher', () => {
    // Arrange
    const rules = [
      { trigger: 'pre-write', rule: 'Test must exist', command: 'exarchos validate tdd-order' },
    ] as const;

    // Act
    const hooks = buildHooksFromRules(rules);

    // Assert
    expect(hooks).toHaveProperty('PreToolUse');
    const preToolUse = (hooks as Record<string, unknown[]>).PreToolUse;
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0]).toEqual({
      matcher: 'Write|Edit',
      hooks: [{ type: 'command', command: 'exarchos validate tdd-order' }],
    });
  });

  it('BuildHooksFromRules_PostTest_MapsToBashMatcher', () => {
    // Arrange
    const rules = [
      { trigger: 'post-test', rule: 'All tests must pass', command: 'npm run test:run' },
    ] as const;

    // Act
    const hooks = buildHooksFromRules(rules);

    // Assert
    expect(hooks).toHaveProperty('PostToolUse');
    const postToolUse = (hooks as Record<string, unknown[]>).PostToolUse;
    expect(postToolUse).toHaveLength(1);
    expect(postToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'npm run test:run' }],
    });
  });

  it('BuildHooksFromRules_RuleWithoutCommand_Skipped', () => {
    // Arrange
    const rules = [
      { trigger: 'pre-write', rule: 'Test must exist' },
    ] as const;

    // Act
    const hooks = buildHooksFromRules(rules);

    // Assert: empty object since the only rule has no command
    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('BuildHooksFromRules_PreEdit_MapsToEditMatcher', () => {
    // Arrange
    const rules = [
      { trigger: 'pre-edit', rule: 'Must validate', command: 'validate-edit' },
    ] as const;

    // Act
    const hooks = buildHooksFromRules(rules);

    // Assert
    expect(hooks).toHaveProperty('PreToolUse');
    const preToolUse = (hooks as Record<string, unknown[]>).PreToolUse;
    expect(preToolUse[0]).toEqual({
      matcher: 'Edit',
      hooks: [{ type: 'command', command: 'validate-edit' }],
    });
  });
});

describe('GenerateAllAgentFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agents-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GenerateAllAgentFiles_CreatesAllFiles_MatchesSpecCount', () => {
    // Act
    generateAllAgentFiles(tmpDir);

    // Assert: correct number of files
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(ALL_AGENT_SPECS.length);

    // Assert: each spec has a corresponding file
    for (const spec of ALL_AGENT_SPECS) {
      const expectedFile = `${spec.id}.md`;
      expect(files).toContain(expectedFile);

      // Verify file content starts with frontmatter
      const content = fs.readFileSync(path.join(tmpDir, expectedFile), 'utf-8');
      expect(content).toMatch(/^---\n/);
      expect(content).toContain(`name: exarchos-${spec.id}`);
    }
  });
});
