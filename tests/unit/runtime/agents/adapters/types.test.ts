/**
 * Type contract tests for `RuntimeAdapter`. The `RUNTIMES` enumeration and the stub values get runtime assertions.
 * The `satisfies` and `@ts-expect-error` assertions are compile-time checks, so they hold only when a typecheck includes this file.
 */

import { describe, it, expect } from 'vitest';
import type { AgentSpec } from '../../../../../src/runtime/agents/types.js';
import { RUNTIMES } from '../../../../../src/runtime/agents/adapters/types.js';
import type { Runtime, RuntimeAdapter, ValidationResult } from '../../../../../src/runtime/agents/adapters/types.js';

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

  /** The typed constants and the `@ts-expect-error` lines are compile-time checks. The `RUNTIMES` assertions are runtime checks. */
  it('Runtime_EnumLiterals_FiveTier1Names', () => {
    const claude: Runtime = 'claude';
    const codex: Runtime = 'codex';
    const opencode: Runtime = 'opencode';
    const cursor: Runtime = 'cursor';
    const copilot: Runtime = 'copilot';

    // @ts-expect-error — 'generic' is not a tier-1 runtime
    const generic: Runtime = 'generic';
    // @ts-expect-error — arbitrary strings are rejected
    const bogus: Runtime = 'something-else';

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
