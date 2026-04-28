// ─── Generated Agent File Drift Tests ───────────────────────────────────────
//
// Verifies that Claude-rendered agent files stay in sync with the agent spec
// registry. Lowers each spec via `claudeAdapter`, writes the contents to a
// temp directory keyed by spec id, parses frontmatter, and compares against
// ALL_AGENT_SPECS.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { claudeAdapter, deriveClaudeToolsFromCapabilities } from './adapters/claude.js';
import { ALL_AGENT_SPECS } from './definitions.js';

// ─── Helper: Parse YAML Frontmatter ─────────────────────────────────────────
//
// Use a real YAML parser. The previous regex-based parser only matched
// flow-style scalars (`tools: ["a", "b"]` on one line) which was an
// artefact of the hand-rolled string-concat renderer; the YAML library
// emits structured values (block lists, block scalars, etc) and the
// drift contract is on the *parsed* value, not the byte form.
function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
}

// ─── Shared Setup ───────────────────────────────────────────────────────────

let tmpDir: string;
let generatedFiles: string[];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
  // Lower each spec via the canonical Claude adapter and write to <tmpDir>/<id>.md
  // (flat layout preserved from the legacy `generateAllAgentFiles` writer that
  // this test originally exercised).
  for (const spec of ALL_AGENT_SPECS) {
    const lowered = claudeAdapter.lowerSpec(spec);
    fs.writeFileSync(path.join(tmpDir, `${spec.id}.md`), lowered.contents, 'utf-8');
  }
  generatedFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Task 8: Generated File Drift Tests ─────────────────────────────────────

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
    // Every spec should have a corresponding .md file
    expect(generatedFiles).toHaveLength(ALL_AGENT_SPECS.length);

    for (const spec of ALL_AGENT_SPECS) {
      const expectedFile = `${spec.id}.md`;
      expect(
        generatedFiles,
        `Missing generated file for spec '${spec.id}'`,
      ).toContain(expectedFile);
    }

    // No extra files beyond what specs define
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

      // Compare parsed arrays — the YAML renderer may emit either
      // block-style or flow-style sequences; the drift contract is
      // semantic equality with the derivation shim, not byte form.
      const derivedTools = [...deriveClaudeToolsFromCapabilities(spec)];
      expect(
        fm.tools,
        `Frontmatter tools mismatch for spec '${spec.id}'`,
      ).toEqual(derivedTools);
    }
  });

  it('GeneratedAgentFiles_MatchRegistrySpecs_DescriptionPresent', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const filePath = path.join(tmpDir, `${spec.id}.md`);
      const content = fs.readFileSync(filePath, 'utf-8');

      if (spec.description.includes('\n')) {
        // Multi-line descriptions use block scalar — verify content is present
        expect(
          content,
          `Description content missing for spec '${spec.id}'`,
        ).toContain('description: |');
        // First line of description should appear indented in frontmatter
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

  it('GeneratedAgentFiles_BodyContainsSystemPrompt', () => {
    for (const spec of ALL_AGENT_SPECS) {
      const filePath = path.join(tmpDir, `${spec.id}.md`);
      const content = fs.readFileSync(filePath, 'utf-8');

      // Body is everything after the second ---
      const parts = content.split('---');
      const body = parts.slice(2).join('---').trim();

      // The body should contain the beginning of the system prompt
      const promptStart = spec.systemPrompt.substring(0, 50);
      expect(
        body,
        `Body for spec '${spec.id}' does not contain system prompt`,
      ).toContain(promptStart);
    }
  });
});
