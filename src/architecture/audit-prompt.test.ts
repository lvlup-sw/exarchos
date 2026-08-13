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
import {
  renderAuditPrompt,
  projectAuditPrompt,
  EmptyAuditProjectionError,
} from './audit-prompt.js';

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

/**
 * Non-empty denominator (DR-4, task 069).
 *
 * `renderAuditPrompt([])` used to return `''` — the SAME value it returns for a
 * catalog that simply has no audit-mode entries. So "the catalog projected
 * nothing at all" and "nothing needed auditing" printed identically, and the
 * louder of the two conditions was the one that vanished.
 */
describe('projectAuditPrompt — non-empty denominator', () => {
  it('ProjectAuditPrompt_ZeroApplicableEntries_ThrowsRatherThanRenderingCleanAudit', () => {
    expect(() => projectAuditPrompt([])).toThrow(EmptyAuditProjectionError);
    // The message must name the failure mode, not just the fact — a red without
    // the repair is how a tooth turns into a thing people delete.
    expect(() => projectAuditPrompt([])).toThrow(/ZERO applicable invariants/);
  });

  /**
   * The tooth lives in the PURE function, so the thin wrapper inherits it rather
   * than bypassing it. This is the half-installed-tooth defect task 022 recorded
   * against the CLI guard: a protection installed only in the caller is absent
   * from every future consumer wired to the callee.
   */
  it('RenderAuditPrompt_ZeroApplicableEntries_InheritsTheSameTooth', () => {
    expect(() => renderAuditPrompt([])).toThrow(EmptyAuditProjectionError);
  });

  /**
   * The distinction the tooth exists to preserve: a NON-empty projection holding
   * no audit-mode entry is an ordinary result, not a lost subject.
   */
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
   * The enumerator is the reader's checklist. Without it, "I read the prompt"
   * and "I answered all of it" are indistinguishable — which is the difference
   * between a reader and a recipient.
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
    // Every enumerated id really is in the prompt, and nothing else is.
    for (const id of projection.invariantIds) {
      expect(projection.prompt).toContain(id);
    }
    expect(projection.prompt).not.toContain('INV-CHECK');
  });
});
