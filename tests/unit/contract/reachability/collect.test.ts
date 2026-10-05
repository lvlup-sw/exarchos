/**
 * The closure evaluator over the real tree. Each public action must reach complete closure over
 * the live materialized inputs. Each of the five seeded break classes must fail closure, and so
 * must a handler or owner ambiguity. Each diagnostic must name the action and the hop.
 *
 * The seeds change the materialized `ReachabilityInputs` value, so they prove only that the
 * evaluator reacts to a break. They do not prove that the collector can surface one.
 * `kill-fixtures.test.ts` mutates the real upstream authorities and gives that proof.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  collectReachabilityInputs,
  readPackagedFixtureActionIds,
  LIVE_CLOSURE_EXCEPTIONS,
} from '../../../../src/contract/reachability/collect.js';
import { declared, none } from '../../../../src/registry/action-contract.js';
import type { BuiltinCompositeTool } from '../../../../src/registry.js';
import {
  buildReachabilityGraph,
  evaluateClosure,
  type ActionNode,
  type ReachabilityHop,
  type ReachabilityInputs,
} from '../../../../src/contract/reachability/graph.js';

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
  /**
   * The exception register `LIVE_CLOSURE_EXCEPTIONS` is empty. A stale entry is a diagnostic, and
   * the test asserts that there are no diagnostics. A new entry must also join the pinned list
   * here, by action and hop.
   */
  it('closes 100% of public actions with zero diagnostics and no governed exceptions', () => {
    const report = evaluateClosure(LIVE);
    expect(LIVE.actions.length).toBeGreaterThan(100);
    expect(report.totalActions).toBe(LIVE.actions.length);
    expect(report.closedActions).toBe(report.totalActions);
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
    expect(
      LIVE_CLOSURE_EXCEPTIONS.map((e) => `${e.actionId}#${e.hop}`).sort(),
    ).toEqual([]);
    expect(report.honouredExceptions).toEqual(LIVE_CLOSURE_EXCEPTIONS);
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

describe('(b)-(f) seeded breaks on the MATERIALIZED inputs each fail closure, naming the action + hop', () => {
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

describe('ambiguity in the materialized inputs is a closure failure', () => {
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

describe('event hop declared-side authority', () => {
  const contract = {
    requires: none('probe'),
    ensures: none('probe'),
    needs: none('probe'),
    touches: { frame: 'single-machine' as const, resources: none('probe') },
    executionAuthority: { kind: 'local' as const },
    replay: { kind: 'safe-repeat' as const },
    emissions: declared({
      event: 'workflow.started',
      condition: 'always' as const,
      owner: 'workflow',
      role: 'primary' as const,
    }),
  };

  it('collects nested contract emissions and ignores sibling autoEmits', () => {
    const registry = [
      {
        name: 'exarchos_probe',
        description: 'emission-authority probe',
        actions: [
          {
            name: 'run',
            autoEmits: [
              { event: 'gate.executed', condition: 'always', owner: 'sibling', role: 'primary' },
            ],
            actionContract: contract,
          },
          {
            name: 'silent',
            autoEmits: [
              { event: 'gate.executed', condition: 'always', owner: 'sibling', role: 'primary' },
            ],
            actionContract: { ...contract, emissions: none('reasoned silence') },
          },
        ],
      },
    ] as unknown as readonly BuiltinCompositeTool[];

    const inputs = collectReachabilityInputs({ registry });
    const probe = inputs.emissions.filter((row) => row.actionId.startsWith('exarchos_probe.'));
    expect(probe).toEqual([
      { actionId: 'exarchos_probe.run', event: 'workflow.started', registered: true },
    ]);
    expect(probe.some((row) => row.event === 'gate.executed')).toBe(false);
  });
});
