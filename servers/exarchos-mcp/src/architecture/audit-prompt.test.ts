/**
 * Tests for the catalog-driven audit-prompt renderer (DR-4).
 *
 * The renderer compiles every `enforcement.mode === 'audit'` invariant into a
 * single review-subagent prompt block. It MUST be workflow-agnostic (no
 * `INV-*`-specific branching — INV-6) and MUST NOT presume MCP-local
 * execution (INV-3): the vocabulary lives in the catalog, not in code.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { InvariantEntry } from './invariants-loader.js';
import { renderAuditPrompt } from './audit-prompt.js';

/**
 * Minimal `InvariantEntry` factory — only the fields the renderer reads need
 * be realistic; the rest are filled with inert placeholders.
 */
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
  it('RenderAuditPrompt_AuditModeInvariants_EmitsPromptVerbatim', () => {
    const auditText =
      'Confirm no cross-tier call bypasses the ControlPlane mediator.';
    const invariants: InvariantEntry[] = [
      entry({
        id: 'INV-1',
        summary: 'Cross-tier calls route through the ControlPlane.',
        enforcement: { mode: 'audit', 'audit-prompt': auditText },
      }),
      // a check-mode entry must contribute nothing
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
    // the check-mode entry's id/summary must be absent
    expect(out).not.toContain('INV-CHECK');
    expect(out).not.toContain('should not appear');
  });

  it('RenderAuditPrompt_NoAuditInvariants_ReturnsEmptyString', () => {
    const invariants: InvariantEntry[] = [
      entry({
        id: 'INV-CHECK',
        enforcement: {
          mode: 'check',
          check: { kind: 'grep', pattern: 'foo' },
        },
      }),
      entry({ id: 'INV-NONE' }), // no enforcement at all
    ];

    expect(renderAuditPrompt(invariants)).toBe('');
  });

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

    // deterministic ordering by id, regardless of input order
    expect(out.indexOf('INV-1')).toBeLessThan(out.indexOf('INV-2'));
    expect(out.indexOf('INV-2')).toBeLessThan(out.indexOf('INV-3'));
  });

  /**
   * INV-6 guard: the renderer must treat all audit invariants uniformly. A
   * brand-new id it has never seen must render identically in shape to a
   * familiar one — there is no per-id branching in the source.
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

    // Replacing the id token yields byte-identical output: no id-specific
    // branching, formatting, or special-casing.
    expect(novel.split('TOTALLY-NEW-ID').join('INV-1')).toBe(familiar);
  });

  /**
   * Static guard against INV-specific literal branching in the source. The
   * renderer source must not hardcode any `INV-` literal (no `id === 'INV-…'`
   * special cases). Catalog vocabulary lives in data, not code (INV-6).
   */
  it('RenderAuditPrompt_Source_HasNoInvSpecificLiteralBranching', () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL('./audit-prompt.ts', import.meta.url)),
      'utf8',
    );
    // strip line + block comments before scanning so that doc references to
    // INV-N (e.g. "INV-6") in prose don't trip the guard.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/['"`]INV-/);
  });
});
