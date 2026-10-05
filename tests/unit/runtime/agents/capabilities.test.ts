import { describe, it, expect } from 'vitest';
import { Capability, CAPABILITY_KEYS } from '../../../../src/runtime/agents/capabilities.js';

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

  it('CapabilityKeys_MatchesEnumValues', () => {
    expect(CAPABILITY_KEYS).toEqual(new Set(Capability.options));
    expect(CAPABILITY_KEYS.size).toBe(Capability.options.length);
  });

  /** `Object.freeze` does not protect the entries of a `Set`, so the test also checks that `add`, `delete` and `clear` throw. */
  it('CapabilityKeys_IsReadonly', () => {
    expect(Object.isFrozen(CAPABILITY_KEYS)).toBe(true);
    const mutable = CAPABILITY_KEYS as unknown as Set<string>;
    const sizeBefore = CAPABILITY_KEYS.size;
    expect(() => mutable.add('not-a-real-capability')).toThrow(TypeError);
    expect(() => mutable.delete('fs:read')).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect(CAPABILITY_KEYS.size).toBe(sizeBefore);
  });
});
