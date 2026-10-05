import { describe, it, expect } from 'vitest';
import { PARITY_CONTRACT, assertParity, type ParitySpec } from './parity-contract.js';

/**
 * The contract is the one declaration of the envelope fields that must match between the
 * CLI and MCP transports. The `parity-` tests under `tests/process` find an entry by
 * `action` and pass it to `assertParity`.
 */
describe('PARITY_CONTRACT', () => {
  /** The envelope holds the workflow document under `data`, so each path has a `data.` prefix. */
  it('paritySpec_describeAction_listsRequiredFields', () => {
    const spec = PARITY_CONTRACT.find((s) => s.action === 'workflow.describe');
    expect(spec).toBeDefined();
    expect(spec!.fieldsRequiringEquality).toEqual(
      expect.arrayContaining(['data.phase', 'data.featureId', 'data.tasks']),
    );
  });

  it('paritySpec_eventQuery_listsRequiredFields', () => {
    const spec = PARITY_CONTRACT.find((s) => s.action === 'event.query');
    expect(spec).toBeDefined();
    expect(spec!.fieldsRequiringEquality.length).toBeGreaterThan(0);
    expect(spec!.fieldsRequiringEquality).toEqual(
      expect.arrayContaining(['data', 'success', 'next_actions']),
    );
  });

  /** `normalize` keeps `projectionSequence`, so the transports must agree on the real number. */
  it('paritySpec_workflowRehydrate_listsRequiredFields', () => {
    const spec = PARITY_CONTRACT.find((s) => s.action === 'workflow.rehydrate');
    expect(spec).toBeDefined();
    expect(spec!.fieldsRequiringEquality.length).toBeGreaterThan(0);
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
