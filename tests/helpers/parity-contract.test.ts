import { describe, it, expect } from 'vitest';
import { PARITY_CONTRACT, assertParity, type ParitySpec } from './parity-contract.js';

/**
 * T3.1 — parity contract schema + first entry.
 *
 * The parity contract is the single declarative source-of-truth for which
 * envelope fields must match between CLI and MCP transports for each
 * action. Tests in `test/process/parity-*` look up entries by `action`
 * and call `assertParity(cli, mcp, spec)` to enforce equality on the
 * fields the spec lists.
 *
 * Design: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.3
 */

describe('PARITY_CONTRACT', () => {
  it('paritySpec_describeAction_listsRequiredFields', () => {
    const spec = PARITY_CONTRACT.find((s) => s.action === 'workflow.describe');
    expect(spec).toBeDefined();
    // The describe envelope's user-meaningful core: phase, featureId, tasks
    // must agree across transports. Mid-flight correction renamed this
    // from `view.describe` — describe lives on `_workflow`, not `_view`.
    // T3.4 follow-up: the underlying envelope wraps the workflow document
    // under `data`, so the literal dot-paths used by `assertParity` carry
    // a `data.` prefix.
    expect(spec!.fieldsRequiringEquality).toEqual(
      expect.arrayContaining(['data.phase', 'data.featureId', 'data.tasks']),
    );
  });

  it('paritySpec_eventQuery_listsRequiredFields', () => {
    const spec = PARITY_CONTRACT.find((s) => s.action === 'event.query');
    expect(spec).toBeDefined();
    expect(spec!.fieldsRequiringEquality.length).toBeGreaterThan(0);
    // The events array under `data` is the user-meaningful core that
    // must agree across transports. Both transports also surface
    // `success` and `next_actions` on the canonical envelope.
    expect(spec!.fieldsRequiringEquality).toEqual(
      expect.arrayContaining(['data', 'success', 'next_actions']),
    );
  });

  it('paritySpec_workflowRehydrate_listsRequiredFields', () => {
    const spec = PARITY_CONTRACT.find((s) => s.action === 'workflow.rehydrate');
    expect(spec).toBeDefined();
    expect(spec!.fieldsRequiringEquality.length).toBeGreaterThan(0);
    // The user-meaningful core of the rehydration document: workflow
    // state, task progress derived from events, and the projection
    // sequence (which must match across transports after the same N
    // events — projectionSequence is NOT normalized so this is real
    // numeric equality).
    expect(spec!.fieldsRequiringEquality).toEqual(
      expect.arrayContaining([
        'success',
        'data.workflowState',
        'data.taskProgress',
        'data.projectionSequence',
      ]),
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

describe('assertParity', () => {
  const spec: ParitySpec = {
    action: 'test.action',
    fieldsRequiringEquality: ['phase', 'data.featureId'],
    fieldsAllowedToDiffer: ['_transport.requestId'],
  };

  it('assertParity_equalEnvelopes_passes', () => {
    const cli = { phase: 'plan', data: { featureId: 'x' }, _transport: { requestId: 'cli-1' } };
    const mcp = { phase: 'plan', data: { featureId: 'x' }, _transport: { requestId: 'mcp-1' } };
    expect(() => assertParity(cli, mcp, spec)).not.toThrow();
  });

  it('assertParity_diffInRequiredField_throws', () => {
    const cli = { phase: 'plan', data: { featureId: 'x' } };
    const mcp = { phase: 'review', data: { featureId: 'x' } };
    expect(() => assertParity(cli, mcp, spec)).toThrow(/phase/);
  });

  it('assertParity_diffInAllowedField_passes', () => {
    const cli = { phase: 'plan', data: { featureId: 'x' }, _transport: { requestId: 'A' } };
    const mcp = { phase: 'plan', data: { featureId: 'x' }, _transport: { requestId: 'B' } };
    expect(() => assertParity(cli, mcp, spec)).not.toThrow();
  });

  it('assertParity_missingRequiredField_throws', () => {
    const cli = { phase: 'plan' };
    const mcp = { phase: 'plan', data: { featureId: 'x' } };
    expect(() => assertParity(cli, mcp, spec)).toThrow(/data\.featureId/);
  });
});
