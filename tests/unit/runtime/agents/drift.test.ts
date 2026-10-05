// The agent specs must stay inside their constraints. Capability and tool names are known, ids are
// unique, template variables are well-formed, and no spec both grants and disallows a tool.

import { describe, it, expect } from 'vitest';
import { ALL_AGENT_SPECS } from '../../../../src/runtime/agents/definitions.js';
import { CAPABILITY_KEYS } from '../../../../src/runtime/agents/capabilities.js';
import { deriveClaudeToolsFromCapabilities } from '../../../../src/runtime/agents/adapters/claude.js';
import { resolveCapabilities } from '../../../../src/workflow/capabilities/posture-mapping.js';

const KNOWN_DISALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebFetch', 'WebSearch',
]);

/** Captures the raw token between `{{` and `}}`. */
const TEMPLATE_VAR_PATTERN = /\{\{(.+?)\}\}/g;
const VALID_IDENTIFIER = /^[a-zA-Z_]\w*$/;

describe('Agent Spec Drift Prevention', () => {
  it('AllAgentSpecs_ReferenceValidCapabilities_KnownNames', () => {
    for (const spec of ALL_AGENT_SPECS) {
      for (const cap of resolveCapabilities(spec.posture, spec.id)) {
        expect(
          CAPABILITY_KEYS.has(cap),
          `${spec.id}: capability '${cap}' is not in the known set: ${[...CAPABILITY_KEYS].join(', ')}`,
        ).toBe(true);
      }
      if (spec.disallowedTools) {
        for (const tool of spec.disallowedTools) {
          expect(
            KNOWN_DISALLOWED_TOOLS.has(tool),
            `${spec.id}: disallowed tool '${tool}' is not in the known tool set: ${[...KNOWN_DISALLOWED_TOOLS].join(', ')}`,
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
        const rawToken = match[1];
        const trimmed = rawToken.trim();
        expect(
          VALID_IDENTIFIER.test(trimmed),
          `${spec.id}: template var '{{${rawToken}}}' is malformed — token must be a valid identifier (got '${trimmed}')`,
        ).toBe(true);
      }
    }
  });

  /**
   * The Claude adapter renders the `tools` of each agent file with `deriveClaudeToolsFromCapabilities`,
   * so this check reads what the Claude agent files grant. Each other adapter has its own test.
   */
  it('AllAgentSpecs_DisallowedToolsNotInDerivedTools_NoOverlap', () => {
    for (const spec of ALL_AGENT_SPECS) {
      if (!spec.disallowedTools) continue;
      const derived = new Set<string>(deriveClaudeToolsFromCapabilities(spec));
      for (const disallowed of spec.disallowedTools) {
        expect(
          derived.has(disallowed),
          `${spec.id}: disallowed tool '${disallowed}' also appears in derived tools`,
        ).toBe(false);
      }
    }
  });
});
