/**
 * Tests that each `exarchos_workflow` tool hint in the playbooks names the canonical `update` action, not `set`.
 * A lower bound on the `update` hints catches a change that deletes hints.
 */

import { describe, it, expect } from 'vitest';
import { workflowPlaybooks, oneshotPlaybook, type PhasePlaybook } from '../../../src/workflow/playbooks.js';

/** Collects each `exarchos_workflow` tool hint. It also walks `oneshotPlaybook` directly, so a renamed map key cannot hide its entries. */
function collectWorkflowToolHints(): Array<{
  workflowType: string;
  phase: string;
  action: string;
}> {
  const hits: Array<{ workflowType: string; phase: string; action: string }> = [];
  const seen = new Set<PhasePlaybook>();
  const addAll = (workflowType: string, playbooks: readonly PhasePlaybook[]): void => {
    for (const pb of playbooks) {
      if (seen.has(pb)) continue;
      seen.add(pb);
      for (const t of pb.tools) {
        if (t.tool === 'exarchos_workflow') {
          hits.push({ workflowType, phase: pb.phase, action: t.action });
        }
      }
    }
  };

  for (const [workflowType, playbooks] of workflowPlaybooks.entries()) {
    addAll(workflowType, playbooks);
  }
  addAll('oneshot', oneshotPlaybook);

  return hits;
}

describe('Playbooks tool-hint migration (Wave 5 / Task 5.2, #1341)', () => {
  it('Playbooks_DeclaredToolsPointAtCanonicalUpdateAction', () => {
    const hits = collectWorkflowToolHints();

    const stale = hits.filter((h) => h.action === 'set');
    expect(
      stale.length,
      `PhasePlaybook tool hints must not declare exarchos_workflow action: 'set'. ` +
        `Found ${stale.length} occurrence(s): ` +
        stale.map((h) => `${h.workflowType}:${h.phase}`).join(', ') +
        `. Action 'set' was removed in v2.11 (#1332); use canonical 'update' (#1340).`,
    ).toBe(0);

    const updateHits = hits.filter((h) => h.action === 'update');
    expect(
      updateHits.length,
      `Expected at least 30 \`action: 'update'\` exarchos_workflow tool hints ` +
        `across registered playbooks; found ${updateHits.length}.`,
    ).toBeGreaterThanOrEqual(30);
  });
});
