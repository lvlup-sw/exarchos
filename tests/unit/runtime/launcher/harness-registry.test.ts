import { describe, it, expect } from 'vitest';
import {
  TIER1_HARNESSES,
  HARNESS_RUNTIME_ID,
  HARNESS_DESCRIPTORS,
  resolveHarness,
  type HarnessTarget,
  type InjectionCandidate,
} from '../../../../src/runtime/launcher/harness-registry.js';

/**
 * True when `value` is a function or holds a function at any depth. It is the runtime mirror of
 * the type-level `HasFunctionDeep` check in `harness-registry.type-test.ts`.
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
  /** Each harness resolves to a descriptor whose fields have the declared runtime types and hold no function. */
  it('Registry_FiveTier1_ResolveDescriptor', () => {
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
      if (!result.success) continue;

      const { descriptor } = result;
      expect(typeof descriptor.command).toBe('string');
      expect(descriptor.command.length).toBeGreaterThan(0);
      expect(Array.isArray(descriptor.args)).toBe(true);
      expect(typeof descriptor.cwd).toBe('string');
      expect(descriptor.env).toBeTypeOf('object');
      expect(descriptor.env).not.toBeNull();

      for (const value of Object.values(descriptor)) {
        expect(typeof value).not.toBe('function');
      }
      for (const envValue of Object.values(descriptor.env)) {
        expect(typeof envValue).toBe('string');
      }
    }
  });

  /**
   * Only `claude-code` maps to a different runtime id, `claude`. The map holds one entry for each
   * harness and no other entry, and `resolveHarness` returns the same id.
   */
  it('Registry_EnumMapsRuntimeId', () => {
    expect(HARNESS_RUNTIME_ID['claude-code']).toBe('claude');
    expect(HARNESS_RUNTIME_ID.codex).toBe('codex');
    expect(HARNESS_RUNTIME_ID.cursor).toBe('cursor');
    expect(HARNESS_RUNTIME_ID.copilot).toBe('copilot');
    expect(HARNESS_RUNTIME_ID.opencode).toBe('opencode');

    expect(Object.keys(HARNESS_RUNTIME_ID).sort()).toEqual(
      [...TIER1_HARNESSES].sort(),
    );

    for (const target of TIER1_HARNESSES) {
      const result = resolveHarness(target);
      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.runtimeId).toBe(HARNESS_RUNTIME_ID[target]);
    }
  });

  /**
   * `claude` is a runtime id, not a harness value. `resolveHarness` rejects it, and each other
   * unknown input, with `INVALID_INPUT` and the five `validTargets`.
   */
  it('Registry_Unknown_StructuredError', () => {
    const result = resolveHarness('claude');
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
    const valid: HarnessTarget = 'opencode';
    expect(resolveHarness(valid).success).toBe(true);
  });
});

describe('harness-registry injection channels (DR-6, Task 014)', () => {
  function injectionOf(target: HarnessTarget): readonly InjectionCandidate[] {
    return HARNESS_DESCRIPTORS[target].injection;
  }

  /**
   * Each harness declares a non-empty candidate list. Each candidate has a declared kind and a
   * non-empty note, and the `assignment` form has a non-empty config key. The test then pins the
   * candidates of the four harnesses that have a native channel.
   */
  it('harnessRegistry_EveryHarness_DeclaresInjectionCandidates', () => {
    for (const target of TIER1_HARNESSES) {
      const result = resolveHarness(target);
      expect(result.success).toBe(true);
      if (!result.success) continue;

      const { injection } = result.descriptor;
      expect(Array.isArray(injection)).toBe(true);
      expect(injection.length).toBeGreaterThan(0);

      for (const candidate of injection) {
        expect(['flag', 'env', 'none']).toContain(candidate.kind);
        expect(typeof candidate.note).toBe('string');
        expect(candidate.note.length).toBeGreaterThan(0);

        if (candidate.kind === 'flag') {
          expect(candidate.flag.length).toBeGreaterThan(0);
          expect(['file', 'string', 'assignment']).toContain(candidate.valueForm);
          expect(typeof candidate.assignmentKey).toBe('string');
          if (candidate.valueForm === 'assignment') {
            expect(candidate.assignmentKey.length).toBeGreaterThan(0);
          }
        } else if (candidate.kind === 'env') {
          expect(candidate.envVar.length).toBeGreaterThan(0);
          expect(['dir', 'config-json']).toContain(candidate.payload);
        }
      }
    }

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

  /**
   * Cursor has no native channel, so it declares one `none` candidate whose note names the
   * managed-block fallback. No other harness declares a `none` candidate.
   */
  it('injectionChannel_Cursor_IsNone', () => {
    const cursor = injectionOf('cursor');
    expect(cursor).toHaveLength(1);
    expect(cursor[0].kind).toBe('none');
    expect(cursor[0].note.toLowerCase()).toContain('managed-block');

    for (const target of TIER1_HARNESSES) {
      if (target === 'cursor') continue;
      expect(injectionOf(target).every((c) => c.kind !== 'none')).toBe(true);
    }
  });

  /**
   * No descriptor is a function or holds one, and the same is true for each injection list. The
   * last two assertions test the detector: it must pass a pure shape and flag a nested function.
   */
  it('harnessRegistry_RemainsPureData', () => {
    for (const target of TIER1_HARNESSES) {
      const descriptor = HARNESS_DESCRIPTORS[target];
      expect(containsFunctionDeep(descriptor)).toBe(false);
      expect(containsFunctionDeep(descriptor.injection)).toBe(false);
    }

    expect(containsFunctionDeep({ a: 1, b: [{ c: 'x' }] })).toBe(false);
    expect(
      containsFunctionDeep({ injection: [{ kind: 'flag', build: () => 'x' }] }),
    ).toBe(true);
  });
});
