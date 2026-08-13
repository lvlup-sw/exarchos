import { describe, it, expect } from 'vitest';
import {
  TIER1_HARNESSES,
  HARNESS_RUNTIME_ID,
  HARNESS_DESCRIPTORS,
  resolveHarness,
  type HarnessTarget,
  type InjectionCandidate,
} from './harness-registry.js';

/**
 * `true` iff `value` is, or (recursively) contains, a function — the runtime
 * mirror of the compile-time `HasFunctionDeep` pin in
 * `harness-registry.type-test.ts`. Guards against a behavior hook smuggled into
 * a descriptor's injection candidate list.
 */
function containsFunctionDeep(value: unknown): boolean {
  if (typeof value === 'function') return true;
  if (Array.isArray(value)) return value.some(containsFunctionDeep);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsFunctionDeep);
  }
  return false;
}

describe('harness-registry (DR-1, DR-4)', () => {
  it('Registry_FiveTier1_ResolveDescriptor', () => {
    // Exactly the five Tier-1 harnesses, no more, no fewer.
    expect(TIER1_HARNESSES).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'copilot',
      'opencode',
    ]);

    for (const target of TIER1_HARNESSES) {
      const result = resolveHarness(target);
      expect(result.success).toBe(true);
      if (!result.success) continue; // narrow for the type checker

      const { descriptor } = result;
      // Required pure-data fields are present with the declared runtime types.
      expect(typeof descriptor.command).toBe('string');
      expect(descriptor.command.length).toBeGreaterThan(0);
      expect(Array.isArray(descriptor.args)).toBe(true);
      expect(typeof descriptor.cwd).toBe('string');
      expect(descriptor.env).toBeTypeOf('object');
      expect(descriptor.env).not.toBeNull();

      // No field carries a function value (belt-and-braces to the compile-time
      // pin in harness-registry.type-test.ts).
      for (const value of Object.values(descriptor)) {
        expect(typeof value).not.toBe('function');
      }
      for (const envValue of Object.values(descriptor.env)) {
        expect(typeof envValue).toBe('string');
      }
    }
  });

  it('Registry_EnumMapsRuntimeId', () => {
    // The load-bearing divergence: claude-code → claude.
    expect(HARNESS_RUNTIME_ID['claude-code']).toBe('claude');
    // The other four map to their like-named runtimes/<id>.yaml basenames.
    expect(HARNESS_RUNTIME_ID.codex).toBe('codex');
    expect(HARNESS_RUNTIME_ID.cursor).toBe('cursor');
    expect(HARNESS_RUNTIME_ID.copilot).toBe('copilot');
    expect(HARNESS_RUNTIME_ID.opencode).toBe('opencode');

    // The map has an entry for every enum member and nothing extra.
    expect(Object.keys(HARNESS_RUNTIME_ID).sort()).toEqual(
      [...TIER1_HARNESSES].sort(),
    );

    // resolveHarness surfaces the same runtime id.
    for (const target of TIER1_HARNESSES) {
      const result = resolveHarness(target);
      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.runtimeId).toBe(HARNESS_RUNTIME_ID[target]);
    }
  });

  it('Registry_Unknown_StructuredError', () => {
    const result = resolveHarness('claude'); // runtime id, not a harness enum value
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');

    expect(result.code).toBe('INVALID_INPUT');
    expect(result.validTargets).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'copilot',
      'opencode',
    ]);
    expect(result.message).toContain('claude');

    // Other unknown inputs (empty string, arbitrary text) also fail-structured.
    for (const bad of ['', 'gemini', 'vscode', 'CLAUDE-CODE']) {
      const r = resolveHarness(bad);
      expect(r.success).toBe(false);
      if (r.success) continue;
      expect(r.code).toBe('INVALID_INPUT');
      expect(r.validTargets).toHaveLength(5);
    }
  });

  it('resolveHarness never throws on arbitrary input', () => {
    const inputs: string[] = ['', ' ', 'claude-code ', 'CODEX', '../claude'];
    for (const input of inputs) {
      expect(() => resolveHarness(input)).not.toThrow();
    }
    // A valid value in the set still resolves.
    const valid: HarnessTarget = 'opencode';
    expect(resolveHarness(valid).success).toBe(true);
  });
});

describe('harness-registry injection channels (DR-6, Task 014)', () => {
  /** Convenience: the injection candidate list for a harness, via the registry map. */
  function injectionOf(target: HarnessTarget): readonly InjectionCandidate[] {
    return HARNESS_DESCRIPTORS[target].injection;
  }

  it('harnessRegistry_EveryHarness_DeclaresInjectionCandidates', () => {
    for (const target of TIER1_HARNESSES) {
      const result = resolveHarness(target);
      expect(result.success).toBe(true);
      if (!result.success) continue; // narrow for the type checker

      const { injection } = result.descriptor;
      // Every harness declares a non-empty, preference-ordered candidate list.
      expect(Array.isArray(injection)).toBe(true);
      expect(injection.length).toBeGreaterThan(0);

      for (const candidate of injection) {
        // Discriminant is one of the three declared kinds.
        expect(['flag', 'env', 'none']).toContain(candidate.kind);
        // Every candidate documents provenance + fallback.
        expect(typeof candidate.note).toBe('string');
        expect(candidate.note.length).toBeGreaterThan(0);

        if (candidate.kind === 'flag') {
          expect(candidate.flag.length).toBeGreaterThan(0);
          expect(['file', 'string', 'assignment']).toContain(candidate.valueForm);
          expect(typeof candidate.assignmentKey).toBe('string');
          // The assignment form carries a non-empty config key; other forms don't need one.
          if (candidate.valueForm === 'assignment') {
            expect(candidate.assignmentKey.length).toBeGreaterThan(0);
          }
        } else if (candidate.kind === 'env') {
          expect(candidate.envVar.length).toBeGreaterThan(0);
          expect(['dir', 'config-json']).toContain(candidate.payload);
        }
      }
    }

    // Pin the load-bearing DR-6 candidates per harness (channel + provenance data).
    const claude = injectionOf('claude-code');
    expect(claude.map((c) => (c.kind === 'flag' ? c.flag : c.kind))).toEqual([
      '--append-system-prompt-file',
      '--append-system-prompt',
    ]);
    expect(claude[0]).toMatchObject({ kind: 'flag', valueForm: 'file' });
    expect(claude[1]).toMatchObject({ kind: 'flag', valueForm: 'string' });

    const codex = injectionOf('codex');
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({
      kind: 'flag',
      flag: '-c',
      valueForm: 'assignment',
      assignmentKey: 'developer_instructions',
    });

    const copilot = injectionOf('copilot');
    expect(copilot).toHaveLength(1);
    expect(copilot[0]).toMatchObject({
      kind: 'env',
      envVar: 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS',
      payload: 'dir',
    });

    const opencode = injectionOf('opencode');
    expect(opencode).toHaveLength(1);
    expect(opencode[0]).toMatchObject({
      kind: 'env',
      envVar: 'OPENCODE_CONFIG_CONTENT',
      payload: 'config-json',
    });
  });

  it('injectionChannel_Cursor_IsNone', () => {
    const cursor = injectionOf('cursor');
    // Cursor exposes no native channel: a single `none` candidate.
    expect(cursor).toHaveLength(1);
    expect(cursor[0].kind).toBe('none');
    // …documenting the managed-block fallback.
    expect(cursor[0].note.toLowerCase()).toContain('managed-block');

    // Cursor is the ONLY `none` harness — every other harness has a real channel.
    for (const target of TIER1_HARNESSES) {
      if (target === 'cursor') continue;
      expect(injectionOf(target).every((c) => c.kind !== 'none')).toBe(true);
    }
  });

  it('harnessRegistry_RemainsPureData', () => {
    // Runtime mirror of the compile-time HasFunctionDeep pin: no descriptor field
    // — including the new injection candidate lists — is or nests a function.
    for (const target of TIER1_HARNESSES) {
      const descriptor = HARNESS_DESCRIPTORS[target];
      expect(containsFunctionDeep(descriptor)).toBe(false);
      // Explicitly cover the injection list (the field Task 014 adds).
      expect(containsFunctionDeep(descriptor.injection)).toBe(false);
    }

    // Detector self-test (kill-probe): a no-op containsFunctionDeep can't
    // rubber-stamp — it MUST pass a pure shape and flag a smuggled function.
    expect(containsFunctionDeep({ a: 1, b: [{ c: 'x' }] })).toBe(false);
    expect(
      containsFunctionDeep({ injection: [{ kind: 'flag', build: () => 'x' }] }),
    ).toBe(true);
  });
});
