import { describe, it, expect } from 'vitest';
import {
  TIER1_HARNESSES,
  HARNESS_RUNTIME_ID,
  resolveHarness,
  type HarnessTarget,
} from './harness-registry.js';

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
