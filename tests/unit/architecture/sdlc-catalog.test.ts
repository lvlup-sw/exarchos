// ─── SDLC-* consumer catalog (issue #1467) ──────────────────────────────────
//
// The plugin-shipped, default-on consumer catalog. Authored inline (the MCP
// server is a single-file binary; docs/ is not in the plugin package) and
// validated through the SAME parseInvariantEntries path as the dev loader.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { loadSdlcCatalog } from '../../../src/architecture/sdlc-catalog.js';
import { parseInvariantEntries } from '../../../src/architecture/invariants-loader.js';

describe('SDLC-* consumer catalog (#1467)', () => {
  it('loadSdlcCatalog_returnsFiveEntries_allAuditModeIntegritySdlc', () => {
    const entries = loadSdlcCatalog();
    expect(entries).toHaveLength(5);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(['SDLC-1', 'SDLC-2', 'SDLC-3', 'SDLC-4', 'SDLC-5']);
    for (const e of entries) {
      expect(e.enforcement?.mode).toBe('audit');
      expect(e.integrityClass).toBe('sdlc');
    }
  });

  it('loadSdlcCatalog_everyEntry_axisSubstrateWorkflowAffinityExcludesDiscovery', () => {
    for (const e of loadSdlcCatalog()) {
      expect(e.axis).toBe('substrate');
      expect(e.workflowAffinity).toBeDefined();
      expect(e.workflowAffinity).not.toContain('discovery');
    }
  });

  it('loadSdlcCatalog_auditPrompts_areTransportNeutral', () => {
    // INV-3: no MCP-local presumption in any shipped audit prompt.
    for (const e of loadSdlcCatalog()) {
      const prompt = (
        e.enforcement as { mode: 'audit'; 'audit-prompt': string }
      )['audit-prompt'].toLowerCase();
      expect(prompt).not.toMatch(/mcp[- ]local|local-only|on this machine/);
    }
  });

  it('sdlcEntries_embeddedExecutable_failsStrictSchemaAtParse', () => {
    // INV-4 sandbox guarantee: an SDLC entry with an embedded executable field
    // is rejected by the .strict() enforcement DSL — proving the inline catalog
    // is held to the same declarative-only bar as everything else.
    const malformed = [
      {
        id: 'SDLC-9',
        dimension: 'malformed',
        axis: 'substrate',
        'cost-of-load': 'always-load',
        'integrity-class': 'sdlc',
        'applies-to': ['x'],
        summary: 's',
        references: ['r'],
        enforcement: {
          mode: 'check',
          check: { kind: 'grep', pattern: 'x', script: 'rm -rf /' },
        },
      },
    ];
    expect(() => parseInvariantEntries(malformed)).toThrow();
  });
});
