import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Companion content separation', () => {
  describe('Core rules', () => {
    it('coreRules_mcpToolGuidance_onlyReferencesCoreMcpTools', () => {
      const content = readFileSync(join(repoRoot, 'rules/mcp-tool-guidance.md'), 'utf-8');
      // Core should reference Exarchos
      expect(content).toContain('Exarchos');
      // Core should NOT reference companion tools
      expect(content).not.toMatch(/mcp__plugin_github/);
      expect(content).not.toMatch(/mcp__plugin_serena/);
      expect(content).not.toMatch(/mcp__plugin_context7/);
      expect(content).not.toContain('microsoft-learn');
      // But it CAN mention them by name with "companion" qualifier
      // Just not as hard tool references
    });
  });

  describe('Companion rules', () => {
    it('companionRules_mcpToolGuidance_containsAllToolReferences', () => {
      const path = join(repoRoot, 'companion/rules/mcp-tool-guidance.md');
      expect(existsSync(path), 'companion/rules/mcp-tool-guidance.md must exist').toBe(true);
      const content = readFileSync(path, 'utf-8');
      expect(content).toContain('Serena');
      expect(content).toContain('GitHub');
      expect(content).toContain('Context7');
    });
  });

  describe('Companion MCP reference', () => {
    it('companionMcpReference_containsAllCompanionSections', () => {
      const path = join(repoRoot, 'companion/skills/workflow-state/references/companion-mcp-reference.md');
      expect(existsSync(path), 'companion MCP reference must exist').toBe(true);
      const content = readFileSync(path, 'utf-8');
      expect(content).toMatch(/##.*GitHub/);
      expect(content).toMatch(/##.*Serena/);
      expect(content).toMatch(/##.*Context7/);
      expect(content).toMatch(/##.*Microsoft Learn/);
    });
  });

  describe('Implementer prompt', () => {
    it('implementerPrompt_serenaGuidance_present', () => {
      const content = readFileSync(join(repoRoot, 'skills/delegation/references/implementer-prompt.md'), 'utf-8');
      // Serena tool names MUST still be present
      expect(content).toContain('mcp__plugin_serena_serena__find_symbol');
      expect(content).toContain('mcp__plugin_serena_serena__get_symbols_overview');
      expect(content).toContain('mcp__plugin_serena_serena__search_for_pattern');
      expect(content).toContain('mcp__plugin_serena_serena__find_referencing_symbols');
      // Primary fallback tools must also be present
      expect(content).toMatch(/Grep/i);
      expect(content).toMatch(/Read/i);
      expect(content).toMatch(/Glob/i);
    });
  });

  describe('No-degradation', () => {
    it('companionMcpToolGuidance_coversAllCurrentToolReferences', () => {
      const content = readFileSync(join(repoRoot, 'companion/rules/mcp-tool-guidance.md'), 'utf-8');
      // These must be present (they're in today's version)
      expect(content).toContain('Serena');
      expect(content).toContain('find_symbol');
      expect(content).toContain('get_symbols_overview');
      expect(content).toContain('GitHub');
      expect(content).toContain('Context7');
      expect(content).toContain('web search');
    });

    it('implementerPrompt_serenaToolNames_allPresent', () => {
      const content = readFileSync(join(repoRoot, 'skills/delegation/references/implementer-prompt.md'), 'utf-8');
      const requiredTools = [
        'mcp__plugin_serena_serena__find_symbol',
        'mcp__plugin_serena_serena__get_symbols_overview',
        'mcp__plugin_serena_serena__search_for_pattern',
        'mcp__plugin_serena_serena__find_referencing_symbols',
      ];
      for (const tool of requiredTools) {
        expect(content, `Missing Serena tool: ${tool}`).toContain(tool);
      }
    });
  });
});
