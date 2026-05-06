import { describe, it, expect } from 'vitest';
import { PARITY_CONTRACT } from './parity-contract.js';

/**
 * T3.1 — parity contract schema + first entry.
 *
 * The parity contract is the single declarative source-of-truth for which
 * envelope fields must match between CLI and MCP transports for each
 * action. Tests in `test/process/parity-*` look up entries by `action`
 * and call `assertParity(cli, mcp, spec)` to enforce equality on the
 * fields the spec lists.
 *
 * Design: docs/designs/2026-05-05-e2e-v29-revisited.md §4.3
 */

describe('PARITY_CONTRACT', () => {
  it('paritySpec_describeAction_listsRequiredFields', () => {
    const spec = PARITY_CONTRACT.find((s) => s.action === 'workflow.describe');
    expect(spec).toBeDefined();
    // The describe envelope's user-meaningful core: phase, featureId, tasks
    // must agree across transports. Mid-flight correction renamed this
    // from `view.describe` — describe lives on `_workflow`, not `_view`.
    expect(spec!.fieldsRequiringEquality).toEqual(
      expect.arrayContaining(['phase', 'featureId', 'tasks']),
    );
  });

  it('paritySpec_actionUniqueness_eachActionHasOneEntry', () => {
    const seen = new Set<string>();
    for (const spec of PARITY_CONTRACT) {
      expect(seen.has(spec.action)).toBe(false);
      seen.add(spec.action);
    }
  });
});
