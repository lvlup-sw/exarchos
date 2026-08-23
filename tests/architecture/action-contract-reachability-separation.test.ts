/**
 * Wiring reachability and ActionId-scoped contract closure have disjoint
 * jobs. A subject can be wiring-closed and still omit a contract dimension
 * or carry an orphan projection; the reachability walk must not claim that
 * detection. The G5 action-contract row names the closure instrument for
 * that population, not the wiring census.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateActionContractClosure,
  type ActionContractClosureSubject,
} from '../../src/contract/action-contract-closure.js';
import {
  evaluateClosure,
  type ReachabilityInputs,
} from '../../src/contract/reachability/graph.js';
import { AUTHORITY_TOPOLOGY } from '../../tools/conformance/src/authority-topology.js';
import {
  ENFORCEMENT_INSTRUMENTS,
  coversPopulation,
  matchingInstruments,
  runAuthorityCensus,
} from '../../tools/conformance/src/authority-census.js';

const NONE = { kind: 'none' as const, because: 'read-only query has no additional obligations' };

function closedContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requires: NONE,
    ensures: NONE,
    needs: NONE,
    touches: { frame: 'single-machine', resources: NONE },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: NONE,
    ...overrides,
  };
}

function wiringClosed(actionId = 'tool.act'): ReachabilityInputs {
  return {
    surfaceVersion: 'reachability-semantic-separation',
    actions: [{ actionId, tool: 'tool', action: 'act', mutates: false }],
    schemas: [{ actionId }],
    routes: [{ actionId, tool: 'tool' }],
    handlers: [{ tool: 'tool' }],
    owners: [],
    outputs: [{ actionId, outputKinds: ['data'], errorCodes: ['E_X'] }],
    artifacts: [{ actionId }],
    fixtures: [{ actionId }],
    emissions: [],
  };
}

function semanticSubject(
  actionId: string,
  overrides: Partial<ActionContractClosureSubject> = {},
): ActionContractClosureSubject {
  return {
    actionId,
    contract: closedContract(),
    advertised: closedContract(),
    executed: closedContract(),
    ...overrides,
  };
}

function namesOmittedDimension(message: string): boolean {
  return /omitted[- ]dimension|OMITTED_DIMENSION|contract dimension/i.test(message);
}

describe('action-contract reachability separation', () => {
  it('Reachability_MissingSemanticDimension_DoesNotClaimDetection', () => {
    const actionId = 'tool.act';
    const wiring = wiringClosed(actionId);
    const reachability = evaluateClosure(wiring);

    expect(reachability.ok).toBe(true);
    expect(reachability.diagnostics).toEqual([]);
    expect(reachability.diagnostics.some((d) => namesOmittedDimension(d.message))).toBe(false);

    const { requires: _requires, ...withoutRequires } = closedContract();
    const omitted = evaluateActionContractClosure({
      subjects: [semanticSubject(actionId, { contract: withoutRequires })],
    });
    expect(omitted.closed).toBe(false);
    expect(omitted.findings.map((f) => f.code)).toContain('OMITTED_DIMENSION');
    expect(omitted.findings.some((f) => f.dimension === 'requires')).toBe(true);

    const orphan = evaluateActionContractClosure({
      subjects: [
        semanticSubject(actionId, {
          contract: undefined,
          projections: [{ name: 'compiler', contract: closedContract() }],
        }),
      ],
    });
    expect(orphan.closed).toBe(false);
    expect(orphan.findings.map((f) => f.code)).toContain('ORPHAN_PROJECTION');

    const stillWiringClosed = evaluateClosure(wiring);
    expect(stillWiringClosed.ok).toBe(true);
    expect(stillWiringClosed.diagnostics.some((d) => namesOmittedDimension(d.message))).toBe(false);
    expect(
      stillWiringClosed.diagnostics.some((d) => /orphan projection|ORPHAN_PROJECTION/i.test(d.message)),
    ).toBe(false);

    const row = AUTHORITY_TOPOLOGY['action-contract'];
    expect(row.enforceFrom.kind).toBe('already-enforced');
    const claim = row.enforceFrom.kind === 'already-enforced' ? row.enforceFrom.by : '';
    expect(claim).toContain('action-contract-closure.ts');
    expect(claim).not.toContain('contract/reachability/graph.ts');
    expect(matchingInstruments(claim, ENFORCEMENT_INSTRUMENTS).map((i) => i.id)).toEqual([
      'action-contract-closure',
    ]);
    const instrument = ENFORCEMENT_INSTRUMENTS.find((i) => i.id === 'action-contract-closure');
    expect(instrument?.module).toContain('action-contract-closure.ts');
    expect(coversPopulation(instrument?.direction ?? 'authority-to-representation')).toBe(true);
    expect(ENFORCEMENT_INSTRUMENTS.some((i) => i.id === 'p05-05-reachability-census')).toBe(true);

    const census = runAuthorityCensus();
    expect(
      census.findings.some(
        (f) =>
          f.boundary === 'action-contract' &&
          f.hop === 'enforcement' &&
          f.kind === 'stale-exception',
      ),
    ).toBe(false);
  });
});
