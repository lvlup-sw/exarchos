import { describe, it, expect } from 'vitest';
import { Capability } from './capabilities.js';

describe('Capability vocabulary', () => {
  it('Capability_RejectsUnknownVerb_ZodFails', () => {
    expect(() => Capability.parse('bogus')).toThrow();
  });

  it('Capability_Parses_MCPExarchosReadonly', () => {
    expect(Capability.parse('mcp:exarchos:readonly')).toBe('mcp:exarchos:readonly');
  });

  it('Capability_AllVocabularyMembersValid_AllParse', () => {
    const vocabulary = [
      'fs:read',
      'fs:write',
      'shell:exec',
      'subagent:spawn',
      'subagent:completion-signal',
      'subagent:start-signal',
      'mcp:exarchos',
      'isolation:worktree',
      'team:agent-teams',
      'session:resume',
    ];
    for (const member of vocabulary) {
      expect(() => Capability.parse(member)).not.toThrow();
    }
  });
});
