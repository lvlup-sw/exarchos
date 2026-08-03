import { describe, it, expect, beforeAll } from 'vitest';
import {
  collectReachabilityInputs,
  readPackagedFixtureActionIds,
  LIVE_CLOSURE_EXCEPTIONS,
} from './collect.js';
import {
  buildReachabilityGraph,
  evaluateClosure,
  type ActionNode,
  type ReachabilityHop,
  type ReachabilityInputs,
} from './graph.js';

// ─── The EXIT PROOF, over the REAL tree ──────────────────────────────────────
//
// (a) every public action achieves complete closure; and (b)–(f) the five seeded
// break classes each fail closure with a diagnostic naming the real action and
// the broken hop, plus handler/owner AMBIGUITY. Seeds are applied to the LIVE
// materialized inputs, so a diagnostic names an actual ActionId — this is the
// capstone's headline finding, not a synthetic fixture.

let LIVE: ReachabilityInputs;

beforeAll(() => {
  LIVE = collectReachabilityInputs();
});

const findMutating = (inputs: ReachabilityInputs): ActionNode => {
  const a = inputs.actions.find((x) => x.mutates);
  if (!a) throw new Error('expected at least one mutating action in the live tree');
  return a;
};
const findPure = (inputs: ReachabilityInputs): ActionNode => {
  const a = inputs.actions.find((x) => !x.mutates);
  if (!a) throw new Error('expected at least one pure action in the live tree');
  return a;
};

function hopStatus(inputs: ReachabilityInputs, actionId: string, hop: ReachabilityHop): string {
  const report = evaluateClosure(inputs);
  return report.actions.find((a) => a.actionId === actionId)?.hops.find((h) => h.hop === hop)?.status ?? '<none>';
}

describe('(a) live reachability — every public action is fully closed', () => {
  it('closes 100% of public actions with zero diagnostics and no governed exceptions', () => {
    const report = evaluateClosure(LIVE);
    expect(LIVE.actions.length).toBeGreaterThan(100); // the real contract surface
    expect(report.totalActions).toBe(LIVE.actions.length);
    expect(report.closedActions).toBe(report.totalActions);
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
    // The honesty invariant: the live tree needs NO closure exceptions.
    expect(LIVE_CLOSURE_EXCEPTIONS).toEqual([]);
    expect(report.honouredExceptions).toEqual([]);
  });

  it('the built graph reports fullyClosed with every action carrying one complete path', () => {
    const graph = buildReachabilityGraph(LIVE);
    expect(graph.summary.fullyClosed).toBe(true);
    expect(graph.summary.closedActions).toBe(graph.summary.totalActions);
    expect(graph.actions.every((a) => a.closed)).toBe(true);
  });

  it('the packaged-fixture set (checked-in baseline) covers every live action', () => {
    const packaged = new Set(readPackagedFixtureActionIds());
    for (const action of LIVE.actions) {
      expect(packaged.has(action.actionId)).toBe(true);
    }
  });
});

describe('(b)-(f) seeded breaks on the REAL tree each fail closure, naming the action + hop', () => {
  it('(b) a seeded MISSING ROUTE fails the routed action at the route hop', () => {
    const target = findMutating(LIVE);
    const seeded: ReachabilityInputs = {
      ...LIVE,
      routes: LIVE.routes.filter((r) => r.actionId !== target.actionId),
    };
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    const diag = report.diagnostics.find((d) => d.actionId === target.actionId && d.hop === 'route');
    expect(diag?.kind).toBe('missing');
    expect(diag?.message).toContain(target.actionId);
  });

  it('(c) a seeded MISSING HANDLER fails every action on that tool at the handler hop', () => {
    const target = findMutating(LIVE);
    const seeded: ReachabilityInputs = {
      ...LIVE,
      handlers: LIVE.handlers.filter((h) => h.tool !== target.tool),
    };
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, target.actionId, 'handler')).toBe('missing');
    const diag = report.diagnostics.find((d) => d.actionId === target.actionId && d.hop === 'handler');
    expect(diag?.kind).toBe('missing');
  });

  it('(d) a seeded MISSING OWNER fails only the mutating actions of that tool', () => {
    const target = findMutating(LIVE);
    const seeded: ReachabilityInputs = {
      ...LIVE,
      owners: LIVE.owners.filter((o) => o.tool !== target.tool),
    };
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, target.actionId, 'owner')).toBe('missing');
    // Every owner-hop diagnostic names a MUTATING action — pure actions are unaffected.
    const ownerDiags = report.diagnostics.filter((d) => d.hop === 'owner');
    expect(ownerDiags.length).toBeGreaterThan(0);
    expect(
      ownerDiags.every((d) => LIVE.actions.find((x) => x.actionId === d.actionId)?.mutates === true),
    ).toBe(true);
  });

  it('(e) a seeded MISSING OUTPUT contract fails the action at the output hop', () => {
    const target = findMutating(LIVE);
    const seeded: ReachabilityInputs = {
      ...LIVE,
      outputs: LIVE.outputs.map((o) =>
        o.actionId === target.actionId ? { actionId: o.actionId, outputKinds: [], errorCodes: [] } : o,
      ),
    };
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, target.actionId, 'output')).toBe('missing');
  });

  it('(f) a seeded MISSING FIXTURE fails the action at the packaged-fixture hop', () => {
    const target = findMutating(LIVE);
    const seeded: ReachabilityInputs = {
      ...LIVE,
      fixtures: LIVE.fixtures.filter((f) => f.actionId !== target.actionId),
    };
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, target.actionId, 'fixture')).toBe('missing');
  });
});

describe('ambiguity on the REAL tree is a closure failure', () => {
  it('a duplicate handler binding for a tool makes its actions AMBIGUOUS', () => {
    const target = findMutating(LIVE);
    const seeded: ReachabilityInputs = { ...LIVE, handlers: [...LIVE.handlers, { tool: target.tool }] };
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, target.actionId, 'handler')).toBe('ambiguous');
  });

  it('a duplicate effect owner for a tool makes its mutating actions AMBIGUOUS', () => {
    const target = findMutating(LIVE);
    const seeded: ReachabilityInputs = {
      ...LIVE,
      owners: [...LIVE.owners, { tool: target.tool, owner: 'second-owner' }],
    };
    const report = evaluateClosure(seeded);
    expect(report.ok).toBe(false);
    expect(hopStatus(seeded, target.actionId, 'owner')).toBe('ambiguous');
  });

  it('a pure action is unaffected by an owner ambiguity on its tool', () => {
    const pure = findPure(LIVE);
    const seeded: ReachabilityInputs = {
      ...LIVE,
      owners: [...LIVE.owners, { tool: pure.tool, owner: 'second-owner' }],
    };
    expect(hopStatus(seeded, pure.actionId, 'owner')).toBe('not-applicable');
  });
});
