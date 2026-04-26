// ─── RuntimeAdapter type contract tests ────────────────────────────────────
//
// Mix of runtime assertions (RUNTIMES enumeration) and compile-time
// assertions (`satisfies` and `@ts-expect-error`). If this file
// type-checks AND the runtime tests pass, the contract holds.
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import type { AgentSpec } from '../types.js';
import { RUNTIMES } from './types.js';
import type { Runtime, RuntimeAdapter, ValidationResult } from './types.js';

describe('RuntimeAdapter type contract', () => {
  it('RuntimeAdapter_TypeContract_HasRequiredMembers', () => {
    const stub = {
      runtime: 'claude' as const,
      agentFilePath: (agentName: string) => `.claude/agents/${agentName}.md`,
      lowerSpec: (_spec: AgentSpec) => ({ path: 'x', contents: 'y' }),
      validateSupport: (_spec: AgentSpec): ValidationResult => ({ ok: true }),
    } satisfies RuntimeAdapter;

    expect(stub.runtime).toBe('claude');
    expect(stub.agentFilePath('foo')).toContain('foo');
    expect(stub.lowerSpec({} as AgentSpec)).toEqual({ path: 'x', contents: 'y' });
    expect(stub.validateSupport({} as AgentSpec)).toEqual({ ok: true });
  });

  it('Runtime_EnumLiterals_FiveTier1Names', () => {
    // Compile-time: each tier-1 runtime is assignable to `Runtime`.
    const claude: Runtime = 'claude';
    const codex: Runtime = 'codex';
    const opencode: Runtime = 'opencode';
    const cursor: Runtime = 'cursor';
    const copilot: Runtime = 'copilot';

    // @ts-expect-error — 'generic' is not a tier-1 runtime
    const generic: Runtime = 'generic';
    // @ts-expect-error — arbitrary strings are rejected
    const bogus: Runtime = 'something-else';

    // Runtime: the canonical enumeration is exposed as a frozen tuple.
    expect(RUNTIMES).toEqual(['claude', 'codex', 'opencode', 'cursor', 'copilot']);
    expect(RUNTIMES).toHaveLength(5);
    expect([claude, codex, opencode, cursor, copilot]).toEqual([...RUNTIMES]);
    void generic;
    void bogus;
  });

  it('ValidationResult_Discriminant_OkOrFailure', () => {
    const ok: ValidationResult = { ok: true };
    const fail: ValidationResult = {
      ok: false,
      reason: 'unsupported capability',
      fixHint: 'remove capability X',
    };

    // @ts-expect-error — `ok: false` requires both `reason` and `fixHint`
    const badFail: ValidationResult = { ok: false };
    // @ts-expect-error — `ok: false` requires `fixHint`
    const partialFail: ValidationResult = { ok: false, reason: 'r' };

    expect(ok.ok).toBe(true);
    expect(fail.ok).toBe(false);
    if (!fail.ok) {
      expect(fail.reason).toBe('unsupported capability');
      expect(fail.fixHint).toBe('remove capability X');
    }
    void badFail;
    void partialFail;
  });
});
