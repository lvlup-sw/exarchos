// ─── Wave 5 / Task 5.2 (#1341): playbooks.ts tool-hint migration ──────────
//
// Every PhasePlaybook's `tools[]` entry that references the
// `exarchos_workflow` MCP tool must declare the CANONICAL action name.
// Action `'set'` was removed in v2.11's DR-4 substrate cut (#1332) and
// re-introduced under `'update'` by Wave 0 of v2.10.0-preview.2 (#1340).
//
// This test walks the live `workflowPlaybooks` registry (the same map the
// playbook-rendering surfaces feed to agents) and asserts that no
// `exarchos_workflow` tool hint declares `action: 'set'`. An accompanying
// lower-bound check on `action: 'update'` count guards against a refactor
// that silently deletes hints rather than renaming them.

import { describe, it, expect } from 'vitest';
import { workflowPlaybooks, oneshotPlaybook, type PhasePlaybook } from './playbooks.js';

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
  // Belt-and-suspenders: also walk `oneshotPlaybook` directly so a future
  // map-key rename can't hide entries from the gate.
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

    // Lower-bound sanity: per the v2.10.0-preview.2 plan, ~35 tool hints
    // are scheduled for migration. The exact count is allowed to grow as
    // new phases get added; what matters is that the migration didn't
    // delete them.
    const updateHits = hits.filter((h) => h.action === 'update');
    expect(
      updateHits.length,
      `Expected at least 30 \`action: 'update'\` exarchos_workflow tool hints ` +
        `across registered playbooks; found ${updateHits.length}.`,
    ).toBeGreaterThanOrEqual(30);
  });
});
