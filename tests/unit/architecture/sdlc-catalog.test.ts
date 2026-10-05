// Tests for the SDLC consumer catalog that the plugin ships. The catalog is on by default.
// The catalog is authored inline, and `parseInvariantEntries` validates it, the same path as the dev loader.

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
    for (const e of loadSdlcCatalog()) {
      const prompt = (
        e.enforcement as { mode: 'audit'; 'audit-prompt': string }
      )['audit-prompt'].toLowerCase();
      expect(prompt).not.toMatch(/mcp[- ]local|local-only|on this machine/);
    }
  });

  /**
   * The strict enforcement schema rejects an entry with an embedded executable field.
   * As a result, the inline catalog stays declarative.
   */
  it('sdlcEntries_embeddedExecutable_failsStrictSchemaAtParse', () => {
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
