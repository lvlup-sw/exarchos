import { describe, it, expect } from 'vitest';
import { Capability, CAPABILITY_KEYS } from './capabilities.js';

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

  it('CapabilityKeys_IsReadonly', () => {
    expect(Object.isFrozen(CAPABILITY_KEYS)).toBe(true);
    // `Object.freeze` alone does not protect Set internals — verify that
    // mutators actually throw (the freezeCapabilityKeys helper replaces
    // .add/.delete/.clear with throwing stubs).
    const mutable = CAPABILITY_KEYS as unknown as Set<string>;
    const sizeBefore = CAPABILITY_KEYS.size;
    expect(() => mutable.add('not-a-real-capability')).toThrow(TypeError);
    expect(() => mutable.delete('fs:read')).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect(CAPABILITY_KEYS.size).toBe(sizeBefore);
  });
});
