/**
 * Unit tests for the pure closure model. Small hand-built inputs give one assertion for each
 * seeded break class and each ambiguity, with no filesystem access.
 * `collect.test.ts` holds the proof over the live tree.
 */
import { describe, it, expect } from 'vitest';
import {
  HOP_AUTHORITIES,
  REACHABILITY_HOPS,
  buildReachabilityGraph,
  evaluateClosure,
  reachabilityEdges,
  reachabilityNodes,
  resolveHops,
  serializeReachabilityGraph,
  type ClosureException,
  type ReachabilityHop,
  type ReachabilityInputs,
} from '../../../../src/contract/reachability/graph.js';

/**
 * A fully closed tree with two actions: one mutating action and one pure action.
 *
 * The mutating action also emits, so the `event` hop applies to it and not to the pure action,
 * like the `owner` hop. If no action emits, the hop never applies and its assertions check nothing.
 */
function baseInputs(): ReachabilityInputs {
  return {
    surfaceVersion: '1.0.0',
    actions: [
      { actionId: 't.mutate', tool: 't', action: 'mutate', mutates: true },
      { actionId: 't.read', tool: 't', action: 'read', mutates: false },
    ],
    schemas: [{ actionId: 't.mutate' }, { actionId: 't.read' }],
    routes: [
      { actionId: 't.mutate', tool: 't' },
      { actionId: 't.read', tool: 't' },
    ],
    handlers: [{ tool: 't' }],
    owners: [{ tool: 't', owner: 't-fs' }],
    outputs: [
      { actionId: 't.mutate', outputKinds: ['baseline'], errorCodes: ['E_X'] },
      { actionId: 't.read', outputKinds: ['baseline'], errorCodes: ['E_X'] },
    ],
    artifacts: [{ actionId: 't.mutate' }, { actionId: 't.read' }],
    fixtures: [{ actionId: 't.mutate' }, { actionId: 't.read' }],
    emissions: [
      { actionId: 't.mutate', event: 't.happened', registered: true },
    ],
    exceptions: [],
  };
}

/** Return a shallow clone with one hop-input array replaced. */
function withInputs(patch: Partial<ReachabilityInputs>): ReachabilityInputs {
  return { ...baseInputs(), ...patch };
}

function hopStatus(inputs: ReachabilityInputs, actionId: string, hop: ReachabilityHop): string {
  const report = evaluateClosure(inputs);
  const action = report.actions.find((a) => a.actionId === actionId);
  const res = action?.hops.find((h) => h.hop === hop);
  return res?.status ?? '<none>';
}

describe('reachability closure — the complete path', () => {
  it('a fully-wired tree closes every public action with no diagnostics', () => {
    const report = evaluateClosure(baseInputs());
    expect(report.ok).toBe(true);
    expect(report.totalActions).toBe(2);
    expect(report.closedActions).toBe(2);
    expect(report.diagnostics).toEqual([]);
    expect(report.actions.every((a) => a.closed)).toBe(true);
  });

  /**
   * `event` is the last hop. It asks if the event that an action claims to raise is registered.
   * That question assumes the answers of the existence hops before it.
   */
  it('the hop order is authored ActionId → schema → route → handler → owner → output → artifact → fixture → event', () => {
    expect([...REACHABILITY_HOPS]).toEqual([
      'schema',
      'route',
      'handler',
      'owner',
      'output',
      'artifact',
      'fixture',
      'event',
    ]);
  });

  /**
   * A hop that reads the `compile()` output behind `inputs.actions` resolves to one for each action
   * and cannot fail. Each hop must name a runtime authority or a shipped-artifact authority.
   * `kill-fixtures.test.ts` proves that each authority can fail the census.
   */
  it('every hop declares an authority INDEPENDENT of the compile pass that supplies the denominator', () => {
    expect(Object.keys(HOP_AUTHORITIES).sort()).toEqual([...REACHABILITY_HOPS].sort());
    for (const hop of REACHABILITY_HOPS) {
      expect(['runtime', 'shipped-artifact'], `hop '${hop}'`).toContain(HOP_AUTHORITIES[hop]);
    }
  });

  /** A pure action with no declared owner is still closed, because the hop does not apply. */
  it('the effect-owner hop is conditional — a PURE action skips it (not-applicable)', () => {
    expect(hopStatus(baseInputs(), 't.read', 'owner')).toBe('not-applicable');
    expect(hopStatus(baseInputs(), 't.mutate', 'owner')).toBe('ok');
    const noOwners = withInputs({ owners: [] });
    const read = evaluateClosure(noOwners).actions.find((a) => a.actionId === 't.read');
    expect(read?.closed).toBe(true);
  });
});

describe('reachability closure — seeded break classes each fail closed', () => {
  /** The seeded routes hold only `t.read`, so `t.mutate` has no route. */
  it('(b) missing route breaks closure at the route hop, naming the action', () => {
    const seeded = withInputs({ routes: [{ actionId: 't.read', tool: 't' }] });
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    const diag = report.diagnostics.find((d) => d.actionId === 't.mutate' && d.hop === 'route');
    expect(diag?.kind).toBe('missing');
    expect(diag?.message).toContain('route');
    expect(report.actions.find((a) => a.actionId === 't.mutate')?.closed).toBe(false);
  });

  it('(c) missing handler breaks closure at the handler hop', () => {
    const seeded = withInputs({ handlers: [] });
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((d) => d.hop === 'handler' && d.kind === 'missing')).toBe(true);
    expect(hopStatus(seeded, 't.mutate', 'handler')).toBe('missing');
  });

  it('(d) missing owner breaks closure ONLY for the mutating action', () => {
    const seeded = withInputs({ owners: [] });
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    const ownerDiags = report.diagnostics.filter((d) => d.hop === 'owner');
    expect(ownerDiags).toHaveLength(1);
    expect(ownerDiags[0]?.actionId).toBe('t.mutate');
    expect(ownerDiags[0]?.kind).toBe('missing');
    expect(report.actions.find((a) => a.actionId === 't.read')?.closed).toBe(true);
  });

  it('(e) missing output (empty contract) breaks closure at the output hop', () => {
    const seeded = withInputs({
      outputs: [
        { actionId: 't.mutate', outputKinds: [], errorCodes: [] },
        { actionId: 't.read', outputKinds: ['baseline'], errorCodes: ['E_X'] },
      ],
    });
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, 't.mutate', 'output')).toBe('missing');
    expect(report.diagnostics.some((d) => d.actionId === 't.mutate' && d.hop === 'output')).toBe(true);
  });

  /** The seeded fixtures hold only `t.read`, so `t.mutate` has no fixture. */
  it('(f) missing fixture breaks closure at the packaged-fixture hop', () => {
    const seeded = withInputs({ fixtures: [{ actionId: 't.read' }] });
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, 't.mutate', 'fixture')).toBe('missing');
  });

  it('(also) missing schema and missing artifact break their hops', () => {
    expect(hopStatus(withInputs({ schemas: [{ actionId: 't.read' }] }), 't.mutate', 'schema')).toBe('missing');
    expect(hopStatus(withInputs({ artifacts: [{ actionId: 't.read' }] }), 't.mutate', 'artifact')).toBe('missing');
  });

  /**
   * The ActionId matches, but the routing arm belongs to a different tool.
   * This guards against registration drift across tools.
   */
  it('a route filed under ANOTHER tool does not resolve the action (the route hop matches tool too)', () => {
    const seeded = withInputs({
      routes: [
        { actionId: 't.mutate', tool: 'other_tool' },
        { actionId: 't.read', tool: 't' },
      ],
    });
    expect(hopStatus(seeded, 't.mutate', 'route')).toBe('missing');
    expect(hopStatus(seeded, 't.read', 'route')).toBe('ok');
  });
});

describe('reachability closure — ambiguity is a closure failure, not just absence', () => {
  it('two handlers for the same tool is an AMBIGUOUS handler hop', () => {
    const seeded = withInputs({ handlers: [{ tool: 't' }, { tool: 't' }] });
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, 't.mutate', 'handler')).toBe('ambiguous');
    const diag = report.diagnostics.find((d) => d.hop === 'handler');
    expect(diag?.kind).toBe('ambiguous');
    expect(diag?.message).toContain('AMBIGUOUS');
  });

  it('two owners for the same tool is an AMBIGUOUS owner hop (mutating action)', () => {
    const seeded = withInputs({
      owners: [
        { tool: 't', owner: 't-fs' },
        { tool: 't', owner: 't-net' },
      ],
    });
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, 't.mutate', 'owner')).toBe('ambiguous');
    expect(report.actions.find((a) => a.actionId === 't.read')?.closed).toBe(true);
  });
});

describe('reachability closure — governed exceptions are a two-way ratchet', () => {
  it('a HONOURED exception admits a genuinely-broken hop without failing closure', () => {
    const exc: ClosureException = { actionId: 't.mutate', hop: 'owner', reason: 'owner deferred to P0X' };
    const seeded = withInputs({ owners: [], exceptions: [exc] });
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(true);
    expect(report.honouredExceptions).toEqual([exc]);
    expect(report.diagnostics).toEqual([]);
    expect(report.actions.find((a) => a.actionId === 't.mutate')?.closed).toBe(true);
  });

  /** The owner hop resolves, so the exception for it is stale. */
  it('a STALE exception (the hop is actually ok) is itself a diagnostic', () => {
    const exc: ClosureException = { actionId: 't.mutate', hop: 'owner', reason: 'no longer needed' };
    const seeded = withInputs({ exceptions: [exc] });
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    const diag = report.diagnostics.find((d) => d.kind === 'stale-exception');
    expect(diag?.actionId).toBe('t.mutate');
    expect(diag?.hop).toBe('owner');
  });
});

describe('reachability graph — deterministic artifact + explicit nodes/edges', () => {
  it('builds byte-identically from identical inputs and records the closure summary', () => {
    const a = buildReachabilityGraph(baseInputs());
    const b = buildReachabilityGraph(baseInputs());
    expect(serializeReachabilityGraph(a)).toBe(serializeReachabilityGraph(b));
    expect(a.contentDigest).toBe(b.contentDigest);
    expect(a.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.summary).toEqual({
      totalActions: 2,
      closedActions: 2,
      fullyClosed: true,
      mutatingActions: 1,
      exceptionCount: 0,
    });
  });

  /**
   * The mutating action has the origin node and one node for each hop. The pure action has no
   * `owner` node and no `event` node, because it does not mutate and does not emit.
   * The edge count of the pure action is the hop count minus those two skipped hops.
   * Thus the assertion stays correct when the hop list grows.
   */
  it('expands to explicit nodes/edges, OMITTING the not-applicable owner node of a pure action', () => {
    const graph = buildReachabilityGraph(baseInputs());
    const nodes = reachabilityNodes(graph);
    const edges = reachabilityEdges(graph);

    expect(nodes.filter((n) => n.actionId === 't.mutate')).toHaveLength(1 + REACHABILITY_HOPS.length);
    expect(nodes.some((n) => n.actionId === 't.read' && n.kind === 'owner')).toBe(false);
    expect(nodes.some((n) => n.actionId === 't.read' && n.kind === 'event')).toBe(false);
    expect(nodes.some((n) => n.actionId === 't.read' && n.kind === 'handler')).toBe(true);

    expect(edges.every((e) => e.complete)).toBe(true);
    const readEdges = edges.filter((e) => e.from.startsWith('t.read::') || e.from === 't.read::origin');
    const skippedOnPureRead = 2;
    expect(readEdges).toHaveLength(REACHABILITY_HOPS.length - skippedOnPureRead);
  });

  it('a broken hop marks that edge (and the downstream edge) incomplete', () => {
    const seeded = withInputs({ owners: [] });
    const graph = buildReachabilityGraph(seeded);
    const edges = reachabilityEdges(graph).filter((e) => e.to.startsWith('t.mutate::'));
    const ownerEdge = edges.find((e) => e.hop === 'owner');
    expect(ownerEdge?.complete).toBe(false);
  });
});

describe('resolveHops — direct resolver counts', () => {
  it('counts one resolver per hop for a fully-wired mutating action', () => {
    const action = baseInputs().actions[0]!;
    const hops = resolveHops(action, baseInputs());
    expect(hops.every((h) => h.resolverCount === 1)).toBe(true);
    expect(hops.every((h) => h.status === 'ok')).toBe(true);
  });
});
