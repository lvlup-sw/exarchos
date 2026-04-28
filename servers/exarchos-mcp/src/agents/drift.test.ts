// ─── Agent Spec Anti-Drift Tests ───────────────────────────────────────────
//
// Bidirectional sync tests that prevent agent spec definitions from drifting
// out of valid constraints. These tests catch issues at commit time rather
// than at runtime.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { ALL_AGENT_SPECS } from './definitions.js';

// ─── Known Names ───────────────────────────────────────────────────────────

const KNOWN_DISALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebFetch', 'WebSearch',
]);

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
  'fs:read', 'fs:write', 'shell:exec',
  'subagent:spawn', 'subagent:completion-signal', 'subagent:start-signal',
  'mcp:exarchos', 'isolation:worktree', 'team:agent-teams', 'session:resume',
]);

// ─── Template Var Pattern ──────────────────────────────────────────────────

/** Matches any content between {{ and }} — captures the raw token for validation. */
const TEMPLATE_VAR_PATTERN = /\{\{(.+?)\}\}/g;
const VALID_IDENTIFIER = /^[a-zA-Z_]\w*$/;

// ─── Drift Tests ───────────────────────────────────────────────────────────

describe('Agent Spec Drift Prevention', () => {
  it('AllAgentSpecs_ReferenceValidCapabilities_KnownNames', () => {
    for (const spec of ALL_AGENT_SPECS) {
      for (const cap of spec.capabilities) {
        expect(
          KNOWN_CAPABILITIES.has(cap),
          `${spec.id}: capability '${cap}' is not in the known set: ${[...KNOWN_CAPABILITIES].join(', ')}`,
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

  it('AllAgentSpecs_DisallowedToolsNotInDerivedTools_NoOverlap', () => {
    // After Task 4a/14 this drift check moves into the Claude adapter snapshot.
    // Until then, we sanity-check against the derivation shim.
    for (const spec of ALL_AGENT_SPECS) {
      if (!spec.disallowedTools) continue;
      // Reproduce the same derivation shape used by the temporary shim so the
      // assertion still describes "what Claude sees". Direct fs:write/shell:exec
      // mapping is sufficient to detect overlap with disallowedTools.
      const derived = new Set<string>();
      if (spec.capabilities.includes('fs:read')) {
        derived.add('Read'); derived.add('Grep'); derived.add('Glob');
      }
      if (spec.capabilities.includes('fs:write')) {
        derived.add('Write'); derived.add('Edit');
      }
      if (spec.capabilities.includes('shell:exec')) {
        derived.add('Bash');
      }
      for (const disallowed of spec.disallowedTools) {
        expect(
          derived.has(disallowed),
          `${spec.id}: disallowed tool '${disallowed}' also appears in derived tools`,
        ).toBe(false);
      }
    }
  });
});
