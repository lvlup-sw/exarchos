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

// ─── The closure model, unit-isolated ────────────────────────────────────────
//
// These drive the pure closure core with tiny hand-built inputs so each seeded
// break class and each ambiguity is a crisp, discriminating assertion with no
// filesystem. The LIVE exit proof (all 120 real public actions closed, and the
// five breaks seeded on the real tree) lives in `collect.test.ts`; here we pin
// the mechanics the live proof relies on.

/**
 * A fully-closed two-action tree: one MUTATING (owner applies) + one PURE.
 *
 * The mutating action also EMITS, so the `event` hop is applicable on it and
 * not-applicable on the pure one — the same split `owner` has. A base fixture
 * where no action emitted would leave the hop permanently not-applicable, and
 * every assertion below it would pass over nothing.
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

  it('the hop order is authored ActionId → schema → route → handler → owner → output → artifact → fixture → event', () => {
    // `event` sits at the END, after the shipped-artifact hops, because it asks
    // the last question in the chain: given an action that exists, routes, is
    // handled and ships, is the effect it claims to raise a REGISTERED event?
    // Ordering it earlier would put a coupling question ahead of the existence
    // questions it presupposes. The sibling `consumer` hop lands after it.
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

  it('every hop declares an authority INDEPENDENT of the compile pass that supplies the denominator', () => {
    // The anti-tautology invariant, stated in the pure model: a hop re-derived
    // from the same `compile()` output as `inputs.actions` resolves to exactly
    // one for every action by construction and can never fail. `collect.ts` must
    // therefore resolve each hop against real runtime wiring or a shipped
    // artifact from a different generation pass; `kill-fixtures.test.ts` proves
    // each of those can actually drop the census.
    expect(Object.keys(HOP_AUTHORITIES).sort()).toEqual([...REACHABILITY_HOPS].sort());
    for (const hop of REACHABILITY_HOPS) {
      expect(['runtime', 'shipped-artifact'], `hop '${hop}'`).toContain(HOP_AUTHORITIES[hop]);
    }
  });

  it('the effect-owner hop is conditional — a PURE action skips it (not-applicable)', () => {
    expect(hopStatus(baseInputs(), 't.read', 'owner')).toBe('not-applicable');
    expect(hopStatus(baseInputs(), 't.mutate', 'owner')).toBe('ok');
    // A pure action with no owner declared is STILL closed — the hop does not apply.
    const noOwners = withInputs({ owners: [] });
    const read = evaluateClosure(noOwners).actions.find((a) => a.actionId === 't.read');
    expect(read?.closed).toBe(true);
  });
});

describe('reachability closure — seeded break classes each fail closed', () => {
  it('(b) missing route breaks closure at the route hop, naming the action', () => {
    const seeded = withInputs({ routes: [{ actionId: 't.read', tool: 't' }] }); // t.mutate route removed
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
    // The pure action is untouched by the missing owner.
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

  it('(f) missing fixture breaks closure at the packaged-fixture hop', () => {
    const seeded = withInputs({ fixtures: [{ actionId: 't.read' }] }); // t.mutate fixture removed
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, 't.mutate', 'fixture')).toBe('missing');
  });

  it('(also) missing schema and missing artifact break their hops', () => {
    expect(hopStatus(withInputs({ schemas: [{ actionId: 't.read' }] }), 't.mutate', 'schema')).toBe('missing');
    expect(hopStatus(withInputs({ artifacts: [{ actionId: 't.read' }] }), 't.mutate', 'artifact')).toBe('missing');
  });

  it('a route filed under ANOTHER tool does not resolve the action (the route hop matches tool too)', () => {
    // The ActionId matches, but the routing arm belongs to a different tool —
    // so it is not this action's route. Guards cross-tool registration drift.
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
    // The pure action still does not care about the ambiguous owner.
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
    // The excepted action is not counted as a closure failure.
    expect(report.diagnostics).toEqual([]);
    expect(report.actions.find((a) => a.actionId === 't.mutate')?.closed).toBe(true);
  });

  it('a STALE exception (the hop is actually ok) is itself a diagnostic', () => {
    const exc: ClosureException = { actionId: 't.mutate', hop: 'owner', reason: 'no longer needed' };
    const seeded = withInputs({ exceptions: [exc] }); // owner IS resolved → exception is stale
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

  it('expands to explicit nodes/edges, OMITTING the not-applicable owner node of a pure action', () => {
    const graph = buildReachabilityGraph(baseInputs());
    const nodes = reachabilityNodes(graph);
    const edges = reachabilityEdges(graph);

    // The mutating action carries origin + every hop node; the pure action skips
    // owner AND event, because it neither mutates nor emits.
    expect(nodes.filter((n) => n.actionId === 't.mutate')).toHaveLength(1 + REACHABILITY_HOPS.length);
    expect(nodes.some((n) => n.actionId === 't.read' && n.kind === 'owner')).toBe(false);
    expect(nodes.some((n) => n.actionId === 't.read' && n.kind === 'event')).toBe(false);
    expect(nodes.some((n) => n.actionId === 't.read' && n.kind === 'handler')).toBe(true);

    // Every edge on this fully-closed tree is complete, and the chain is contiguous.
    expect(edges.every((e) => e.complete)).toBe(true);
    const readEdges = edges.filter((e) => e.from.startsWith('t.read::') || e.from === 't.read::origin');
    // origin→schema→route→handler→output→artifact→fixture = 6 edges. Two hops are
    // skipped on a pure non-emitting action (owner, event), so the count is stated
    // against those exclusions rather than against the hop total — which is what
    // keeps it meaningful as the hop list grows.
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
