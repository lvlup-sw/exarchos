// The Claude agent files must stay in sync with the agent spec registry. The suite lowers each spec
// with `claudeAdapter` and writes the result to `<tmpDir>/<id>.md`. It then compares the parsed
// frontmatter and the body with `ALL_AGENT_SPECS`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { claudeAdapter, deriveClaudeToolsFromCapabilities } from '../../../../src/runtime/agents/adapters/claude.js';
import { ALL_AGENT_SPECS } from '../../../../src/runtime/agents/definitions.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

/**
 * Parses the frontmatter with a YAML library. The renderer can emit block style or flow style, so
 * the drift contract is on the parsed value, not on the byte form.
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
}

let tmpDir: string;
let generatedFiles: string[];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
  for (const spec of ALL_AGENT_SPECS) {
    const lowered = claudeAdapter.lowerSpec(spec);
    fs.writeFileSync(path.join(tmpDir, `${spec.id}.md`), lowered.contents, 'utf-8');
  }
  generatedFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md'));
});

afterAll(() => {
  rmrf(tmpDir);
});

describe('Generated Agent File Drift', () => {
  it('GeneratedAgentFiles_MatchRegistrySpecs_NameCorrect', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const filePath = path.join(tmpDir, `${spec.id}.md`);
      expect(fs.existsSync(filePath), `Missing file for spec '${spec.id}'`).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content);

      expect(
        fm.name,
        `Frontmatter name mismatch for spec '${spec.id}'`,
      ).toBe(`exarchos-${spec.id}`);
    }
  });

  it('GeneratedAgentFiles_MatchRegistrySpecs_ModelCorrect', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const filePath = path.join(tmpDir, `${spec.id}.md`);
      const content = fs.readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content);

      expect(
        fm.model,
        `Frontmatter model mismatch for spec '${spec.id}': expected '${spec.model}', got '${fm.model}'`,
      ).toBe(spec.model);
    }
  });

  it('GeneratedAgentFiles_AllSpecsHaveFiles_NoneSkipped', () => {
    expect(generatedFiles).toHaveLength(ALL_AGENT_SPECS.length);

    for (const spec of ALL_AGENT_SPECS) {
      const expectedFile = `${spec.id}.md`;
      expect(
        generatedFiles,
        `Missing generated file for spec '${spec.id}'`,
      ).toContain(expectedFile);
    }

    const expectedFileNames = ALL_AGENT_SPECS.map(s => `${s.id}.md`);
    for (const file of generatedFiles) {
      expect(
        expectedFileNames,
        `Unexpected generated file '${file}' not in registry`,
      ).toContain(file);
    }
  });

  it('GeneratedAgentFiles_MatchRegistrySpecs_ToolsCorrect', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const filePath = path.join(tmpDir, `${spec.id}.md`);
      const content = fs.readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content);

      const derivedTools = [...deriveClaudeToolsFromCapabilities(spec)];
      expect(
        fm.tools,
        `Frontmatter tools mismatch for spec '${spec.id}'`,
      ).toEqual(derivedTools);
    }
  });

  /**
   * A multi-line description renders as a block scalar. For that form, the test looks only for the
   * `description: |` key and the indented first line.
   */
  it('GeneratedAgentFiles_MatchRegistrySpecs_DescriptionPresent', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const filePath = path.join(tmpDir, `${spec.id}.md`);
      const content = fs.readFileSync(filePath, 'utf-8');

      if (spec.description.includes('\n')) {
        expect(
          content,
          `Description content missing for spec '${spec.id}'`,
        ).toContain('description: |');
        const firstLine = spec.description.split('\n')[0];
        expect(
          content,
          `Description first line missing for spec '${spec.id}'`,
        ).toContain(`  ${firstLine}`);
      } else {
        const fm = parseFrontmatter(content);
        expect(
          fm.description,
          `Frontmatter description missing for spec '${spec.id}'`,
        ).toBeTruthy();
        expect(
          fm.description,
          `Frontmatter description mismatch for spec '${spec.id}'`,
        ).toBe(spec.description);
      }
    }
  });

  it('GeneratedAgentFiles_MatchRegistrySpecs_ColorCorrect', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const filePath = path.join(tmpDir, `${spec.id}.md`);
      const content = fs.readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content);

      if (spec.color) {
        expect(
          fm.color,
          `Frontmatter color mismatch for spec '${spec.id}'`,
        ).toBe(spec.color);
      } else {
        expect(
          fm.color,
          `Unexpected color in frontmatter for spec '${spec.id}'`,
        ).toBeUndefined();
      }
    }
  });

  /**
   * The body is the text after the second `---`. The test compares only the first 50 characters of
   * the system prompt.
   */
  it('GeneratedAgentFiles_BodyContainsSystemPrompt', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const filePath = path.join(tmpDir, `${spec.id}.md`);
      const content = fs.readFileSync(filePath, 'utf-8');

      const parts = content.split('---');
      const body = parts.slice(2).join('---').trim();

      const promptStart = spec.systemPrompt.substring(0, 50);
      expect(
        body,
        `Body for spec '${spec.id}' does not contain system prompt`,
      ).toContain(promptStart);
    }
  });
});
