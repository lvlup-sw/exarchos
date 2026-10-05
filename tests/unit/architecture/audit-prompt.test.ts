/**
 * Tests the audit-prompt renderer. The renderer compiles every invariant with
 * `enforcement.mode === 'audit'` into one prompt for a review subagent. It must have no branch on
 * an invariant id, because the vocabulary lives in the catalog and not in code.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { InvariantEntry } from '../../../src/architecture/invariants-loader.js';
import {
  renderAuditPrompt,
  projectAuditPrompt,
  EmptyAuditProjectionError,
} from '../../../src/architecture/audit-prompt.js';

/** Builds an `InvariantEntry`. Only the fields that the renderer reads need real values. */
function entry(overrides: Partial<InvariantEntry>): InvariantEntry {
  return {
    id: 'INV-X',
    dimension: 'test',
    axis: 'substrate',
    costOfLoad: 'always-load',
    appliesTo: [],
    summary: 'placeholder summary',
    references: [],
    raw: {},
    ...overrides,
  };
}

describe('renderAuditPrompt', () => {
  /** The check-mode entry must add nothing to the prompt, so its id and summary must be absent. */
  it('RenderAuditPrompt_AuditModeInvariants_EmitsPromptVerbatim', () => {
    const auditText =
      'Confirm no cross-tier call bypasses the ControlPlane mediator.';
    const invariants: InvariantEntry[] = [
      entry({
        id: 'INV-1',
        summary: 'Cross-tier calls route through the ControlPlane.',
        enforcement: { mode: 'audit', 'audit-prompt': auditText },
      }),
      entry({
        id: 'INV-CHECK',
        summary: 'should not appear',
        enforcement: {
          mode: 'check',
          check: { kind: 'grep', pattern: 'foo' },
        },
      }),
    ];

    const out = renderAuditPrompt(invariants);

    expect(out).toContain(auditText);
    expect(out).toContain('INV-1');
    expect(out).toContain('Cross-tier calls route through the ControlPlane.');
    expect(out).not.toContain('INV-CHECK');
    expect(out).not.toContain('should not appear');
  });

  /** One entry is check-mode, and the other has no enforcement. */
  it('RenderAuditPrompt_NoAuditInvariants_ReturnsEmptyString', () => {
    const invariants: InvariantEntry[] = [
      entry({
        id: 'INV-CHECK',
        enforcement: {
          mode: 'check',
          check: { kind: 'grep', pattern: 'foo' },
        },
      }),
      entry({ id: 'INV-NONE' }),
    ];

    expect(renderAuditPrompt(invariants)).toBe('');
  });

  /** The blocks appear in ascending id order for every input order. */
  it('RenderAuditPrompt_MultipleAuditInvariants_OrderedById', () => {
    const invariants: InvariantEntry[] = [
      entry({
        id: 'INV-3',
        summary: 'third',
        enforcement: { mode: 'audit', 'audit-prompt': 'prompt-three' },
      }),
      entry({
        id: 'INV-1',
        summary: 'first',
        enforcement: { mode: 'audit', 'audit-prompt': 'prompt-one' },
      }),
      entry({
        id: 'INV-2',
        summary: 'second',
        enforcement: { mode: 'audit', 'audit-prompt': 'prompt-two' },
      }),
    ];

    const out = renderAuditPrompt(invariants);

    expect(out.indexOf('INV-1')).toBeLessThan(out.indexOf('INV-2'));
    expect(out.indexOf('INV-2')).toBeLessThan(out.indexOf('INV-3'));
  });

  /**
   * The renderer treats every audit invariant the same. When the test replaces the new id with
   * the familiar id, the two outputs must be byte-identical.
   */
  it('RenderAuditPrompt_UnknownInvariantId_RendersUniformly', () => {
    const familiar = renderAuditPrompt([
      entry({
        id: 'INV-1',
        summary: 'shared summary',
        enforcement: { mode: 'audit', 'audit-prompt': 'shared prompt body' },
      }),
    ]);
    const novel = renderAuditPrompt([
      entry({
        id: 'TOTALLY-NEW-ID',
        summary: 'shared summary',
        enforcement: { mode: 'audit', 'audit-prompt': 'shared prompt body' },
      }),
    ]);

    expect(novel.split('TOTALLY-NEW-ID').join('INV-1')).toBe(familiar);
  });

  /**
   * The renderer source must hold no string literal that starts with `INV-`, so it has no special
   * case for an id. The scan removes the comments first, because prose can name an invariant id.
   */
  it('RenderAuditPrompt_Source_HasNoInvSpecificLiteralBranching', () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL('../../../src/architecture/audit-prompt.ts', import.meta.url)),
      'utf8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/['"`]INV-/);
  });
});

/**
 * An empty input must throw. An empty prompt for an empty input reads the same as the prompt for
 * a catalog with no audit-mode entry. That result hides a catalog that projects nothing.
 */
describe('projectAuditPrompt — non-empty denominator', () => {
  /** The error message must name the failure mode, so the reader knows what to repair. */
  it('ProjectAuditPrompt_ZeroApplicableEntries_ThrowsRatherThanRenderingCleanAudit', () => {
    expect(() => projectAuditPrompt([])).toThrow(EmptyAuditProjectionError);
    expect(() => projectAuditPrompt([])).toThrow(/ZERO applicable invariants/);
  });

  /**
   * The throw is in `projectAuditPrompt`, so the `renderAuditPrompt` wrapper inherits it.
   * A check that only a caller makes is absent from every other consumer of the callee.
   */
  it('RenderAuditPrompt_ZeroApplicableEntries_InheritsTheSameTooth', () => {
    expect(() => renderAuditPrompt([])).toThrow(EmptyAuditProjectionError);
  });

  /** A non-empty input with no audit-mode entry is an ordinary result and does not throw. */
  it('ProjectAuditPrompt_EntriesButNoAuditMode_IsNoAuditEntriesNotAThrow', () => {
    const projection = projectAuditPrompt([
      entry({
        id: 'INV-CHECK',
        enforcement: { mode: 'check', check: { kind: 'grep', pattern: 'foo' } },
      }),
    ]);
    expect(projection.status).toBe('no-audit-entries');
    expect(projection.prompt).toBe('');
    expect(projection.invariantIds).toEqual([]);
  });

  /**
   * `invariantIds` is the checklist of the reader: each id in the prompt, ascending, and no other id.
   * Without the list, nobody can tell "I read the prompt" from "I answered all of it".
   */
  it('ProjectAuditPrompt_RenderedEntries_EnumerateEveryPromptedIdAscending', () => {
    const projection = projectAuditPrompt([
      entry({ id: 'INV-3', enforcement: { mode: 'audit', 'audit-prompt': 'three' } }),
      entry({ id: 'INV-1', enforcement: { mode: 'audit', 'audit-prompt': 'one' } }),
      entry({ id: 'INV-CHECK', enforcement: { mode: 'check', check: { kind: 'grep', pattern: 'x' } } }),
      entry({ id: 'INV-2', enforcement: { mode: 'audit', 'audit-prompt': 'two' } }),
    ]);

    expect(projection.status).toBe('rendered');
    expect([...projection.invariantIds]).toEqual(['INV-1', 'INV-2', 'INV-3']);
    for (const id of projection.invariantIds) {
      expect(projection.prompt).toContain(id);
    }
    expect(projection.prompt).not.toContain('INV-CHECK');
  });
});
