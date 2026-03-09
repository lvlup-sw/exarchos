// ─── Agent Spec Anti-Drift Tests ───────────────────────────────────────────
//
// Bidirectional sync tests that prevent agent spec definitions from drifting
// out of valid constraints. These tests catch issues at commit time rather
// than at runtime.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { ALL_AGENT_SPECS } from './definitions.js';

// ─── Known Tool Names ──────────────────────────────────────────────────────

const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebFetch', 'WebSearch',
]);

// ─── Template Var Pattern ──────────────────────────────────────────────────

const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g;
const VALID_IDENTIFIER = /^[a-zA-Z_]\w*$/;

// ─── Drift Tests ───────────────────────────────────────────────────────────

describe('Agent Spec Drift Prevention', () => {
  it('AllAgentSpecs_ReferenceValidTools_KnownToolNames', () => {
    for (const spec of ALL_AGENT_SPECS) {
      for (const tool of spec.tools) {
        expect(
          KNOWN_TOOLS.has(tool),
          `${spec.id}: tool '${tool}' is not in the known tool set: ${[...KNOWN_TOOLS].join(', ')}`,
        ).toBe(true);
      }
      if (spec.disallowedTools) {
        for (const tool of spec.disallowedTools) {
          expect(
            KNOWN_TOOLS.has(tool),
            `${spec.id}: disallowed tool '${tool}' is not in the known tool set: ${[...KNOWN_TOOLS].join(', ')}`,
          ).toBe(true);
        }
      }
    }
  });

  it('AllAgentSpecs_UniqueIds_NoDuplicates', () => {
    const ids = ALL_AGENT_SPECS.map(s => s.id);
    const uniqueIds = new Set(ids);
    expect(
      uniqueIds.size,
      `Duplicate agent spec IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`,
    ).toBe(ids.length);
  });

  it('AllAgentSpecs_TemplateVarsInPrompts_UseCorrectSyntax', () => {
    for (const spec of ALL_AGENT_SPECS) {
      let match: RegExpExecArray | null;
      const regex = new RegExp(TEMPLATE_VAR_PATTERN.source, 'g');
      while ((match = regex.exec(spec.systemPrompt)) !== null) {
        const varName = match[1];
        expect(
          VALID_IDENTIFIER.test(varName),
          `${spec.id}: template var '{{${varName}}}' uses invalid identifier characters`,
        ).toBe(true);
      }
    }
  });

  it('AllAgentSpecs_DisallowedToolsNotInTools_NoOverlap', () => {
    for (const spec of ALL_AGENT_SPECS) {
      if (!spec.disallowedTools) continue;
      const toolSet = new Set(spec.tools);
      for (const disallowed of spec.disallowedTools) {
        expect(
          toolSet.has(disallowed),
          `${spec.id}: disallowed tool '${disallowed}' also appears in tools array`,
        ).toBe(false);
      }
    }
  });
});
