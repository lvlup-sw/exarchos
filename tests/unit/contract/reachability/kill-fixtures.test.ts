import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectReachabilityInputs,
  type CollectOptions,
} from '../../../../src/contract/reachability/collect.js';
import {
  HOP_AUTHORITIES,
  REACHABILITY_HOPS,
  evaluateClosure,
  resolveHops,
  type ClosureReport,
  type ReachabilityHop,
} from '../../../../src/contract/reachability/graph.js';
import { SOURCE_ROOT, resolveRouterSources, type RouterSource } from '../../../../src/contract/reachability/dispatch-routes.js';
import { EFFECT_PROVIDERS } from '../../../../src/contract/reachability/providers.js';
import { buildBindingTable } from '../../../../src/contract/bindings/binding-table.js';
import { COMPOSITE_HANDLER_LOADERS } from '../../../../src/dispatch/core/dispatch.js';
import { compile, type CompiledContract } from '../../../../src/contract/compiler/compile.js';
import { deriveMetaModel } from '../../../../src/contract/compiler/meta-model.js';
import { EVENT_ANNOTATIONS } from '../../../../src/events/event-annotations.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import { PROOF_FIXTURES_FILE } from '../../../../src/contract/compiler/generate.js';
import { CLI_SURFACE_FILE } from '../../../../src/contract/cli/cli-contract-seam.js';

// ─── KILL FIXTURES — proof that the census can actually FALL ─────────────────
//
// The closure census's headline ("N of N public actions fully closed") is only
// evidence if a genuinely-broken tree makes it DROP. The seeded-break tests in
// `collect.test.ts` mutate a materialized `ReachabilityInputs` object, which
// proves the EVALUATOR reacts — it cannot prove the COLLECTOR would ever
// surface a real break, and it is exactly the proof that a tautological hop
// passes trivially.
//
// Every fixture below mutates a REAL UPSTREAM AUTHORITY instead:
//
//   route     → a COPY of a shipped composite router with a routing arm renamed,
//               removed, or duplicated (the code dispatch actually executes).
//   handler   → the real `COMPOSITE_HANDLER_LOADERS` map with a loader removed,
//               fed through the real `buildBindingTable`.
//   owner     → the real `EFFECT_PROVIDERS` map with a provider removed.
//   schema    → a COPY of the shipped `proof-fixtures.json` with a schema digest
//               tampered.
//   output    → a COPY of the shipped `proof-fixtures.json` with an action's
//               output contract emptied.
//   artifact  → a COPY of the shipped `cli-surface.json` with a command removed.
//   fixture   → a COPY of the shipped `proof-fixtures.json` with an action
//               removed.
//
// The closing test asserts that EVERY hop in `REACHABILITY_HOPS` is covered by
// at least one fixture here — so a future hop cannot be added to the headline
// number without a proof that it can fail.

const KILLED_HOPS = new Set<ReachabilityHop>();

/** Record + return the census for a mutated authority set. */
function censusFor(opts: CollectOptions): ClosureReport {
  return evaluateClosure(collectReachabilityInputs(opts));
}

/** Assert the census DROPPED and that `hop` is why, for `actionId`. */
function expectKilled(report: ClosureReport, baseline: ClosureReport, hop: ReachabilityHop, actionId: string): void {
  expect(report.ok).toBe(false);
  expect(report.totalActions).toBe(baseline.totalActions);
  expect(report.closedActions).toBeLessThan(baseline.closedActions);
  const diag = report.diagnostics.find((d) => d.actionId === actionId && d.hop === hop);
  expect(diag, `expected a ${hop} diagnostic for '${actionId}'`).toBeDefined();
  expect(diag?.message).toContain(actionId);
  KILLED_HOPS.add(hop);
}

let TMP: string;
let COMPILED: CompiledContract;
let BASELINE: ClosureReport;

/** Copy a real file into the scratch tree and hand back the copy's path. */
function scratchCopy(realFile: string, name: string): string {
  const target = path.join(TMP, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(realFile, target);
  return target;
}

/** Copy a real file, apply a text edit, and return the mutated copy's path. */
function mutatedSource(realFile: string, name: string, edit: (text: string) => string): string {
  const target = scratchCopy(realFile, name);
  const before = fs.readFileSync(target, 'utf8');
  const after = edit(before);
  expect(after, `mutation of ${realFile} was a no-op — the fixture would prove nothing`).not.toBe(before);
  fs.writeFileSync(target, after, 'utf8');
  return target;
}

/** Router sources with ONE tool re-pointed at a mutated router copy. */
function routersWith(tool: string, file: string): readonly RouterSource[] {
  return resolveRouterSources().map((s) => (s.tool === tool ? { tool: s.tool, file } : s));
}

// ── Typed JSON mutation helpers (no `any`; `unknown` + guards) ───────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Load a shipped artifact, mutate its `key` array, write the copy, return path. */
function mutatedArtifact(
  realFile: string,
  name: string,
  key: string,
  mutate: (entries: Record<string, unknown>[]) => Record<string, unknown>[],
): string {
  const target = scratchCopy(realFile, name);
  const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${realFile} is not a JSON object`);
  const raw = parsed[key];
  if (!Array.isArray(raw)) throw new Error(`${realFile} has no '${key}' array`);
  const entries = raw.filter(isRecord);
  expect(entries.length).toBe(raw.length);
  const next = mutate(entries.map((e) => ({ ...e })));
  fs.writeFileSync(target, JSON.stringify({ ...parsed, [key]: next }), 'utf8');
  return target;
}

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reachability-kill-'));
  const outcome = compile(deriveMetaModel());
  if (!outcome.ok) throw new Error('live contract compile is blocked — kill fixtures cannot run');
  COMPILED = outcome.output;
  BASELINE = censusFor({ compiled: COMPILED });
});

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // Best effort — a Windows handle lag must not fail the suite.
  }
});

describe('the census baseline is a real number, not a definition', () => {
  it('the untouched live tree is fully closed', () => {
    expect(BASELINE.ok).toBe(true);
    expect(BASELINE.closedActions).toBe(BASELINE.totalActions);
    expect(BASELINE.totalActions).toBeGreaterThan(100);
  });
});

describe('KILL: route — breaking the SHIPPED dispatch wiring drops the census', () => {
  it('renaming a real `case` arm in the shipped workflow router unroutes that action', () => {
    const file = mutatedSource(
      path.join(SOURCE_ROOT, 'workflow', 'composite.ts'),
      'workflow-composite-renamed.ts',
      (text) => text.replace("case 'cancel':", "case 'cancel_RENAMED_BY_DRIFT':"),
    );
    const report = censusFor({
      compiled: COMPILED,
      routerSources: routersWith('exarchos_workflow', file),
    });
    expectKilled(report, BASELINE, 'route', 'exarchos_workflow.cancel');
    expect(report.closedActions).toBe(BASELINE.closedActions - 1);
  });

  it('deleting a real key from the shipped orchestrate dispatch TABLE unroutes that action', () => {
    // The computed key `[MUTATION_GATE_NAME]` is resolved through the router's
    // own import, so the imported module travels with the copy — at the same
    // relative path the router names (`./gates/mutation-adequacy.js`).
    scratchCopy(
      path.join(SOURCE_ROOT, 'verbs', 'gates', 'mutation-adequacy.ts'),
      path.join('gates', 'mutation-adequacy.ts'),
    );
    const file = mutatedSource(
      path.join(SOURCE_ROOT, 'verbs', 'composite.ts'),
      'verbs-composite-dropped.ts',
      (text) => text.replace(/^\s*task_claim:.*$/m, ''),
    );
    const report = censusFor({
      compiled: COMPILED,
      routerSources: routersWith('exarchos_orchestrate', file),
    });
    expectKilled(report, BASELINE, 'route', 'exarchos_orchestrate.task_claim');
    expect(report.closedActions).toBe(BASELINE.closedActions - 1);
  });

  it('a DUPLICATED routing arm is an AMBIGUOUS route, not a silently-accepted one', () => {
    const file = mutatedSource(
      path.join(SOURCE_ROOT, 'sync', 'composite.ts'),
      'sync-composite-duplicated.ts',
      (text) => text.replace("case 'now':", "case 'now':\n    case 'now':"),
    );
    const report = censusFor({ compiled: COMPILED, routerSources: routersWith('exarchos_sync', file) });
    expectKilled(report, BASELINE, 'route', 'exarchos_sync.now');
    expect(report.diagnostics.find((d) => d.hop === 'route')?.kind).toBe('ambiguous');
  });

  it('an arm that MOVED to another composite router leaves its own ActionId unrouted', () => {
    // Cross-tool drift: workflow loses `cancel`, views gains it. The routing arm
    // still exists somewhere in the tree — but it no longer serves
    // `exarchos_workflow.cancel`, and the census must say so.
    const workflowFile = mutatedSource(
      path.join(SOURCE_ROOT, 'workflow', 'composite.ts'),
      'workflow-composite-moved.ts',
      (text) => text.replace("case 'cancel':", "case 'cancel_moved_away':"),
    );
    const viewsFile = mutatedSource(
      path.join(SOURCE_ROOT, 'projections', 'views', 'composite.ts'),
      'views-composite-moved.ts',
      (text) => text.replace("case 'pipeline':", "case 'cancel':\n    case 'pipeline':"),
    );
    const routers = resolveRouterSources().map((s) => {
      if (s.tool === 'exarchos_workflow') return { tool: s.tool, file: workflowFile };
      if (s.tool === 'exarchos_view') return { tool: s.tool, file: viewsFile };
      return s;
    });
    const report = censusFor({ compiled: COMPILED, routerSources: routers });
    expectKilled(report, BASELINE, 'route', 'exarchos_workflow.cancel');
    // The stolen arm did NOT accidentally close anything under its new tool.
    expect(report.actions.some((a) => a.actionId === 'exarchos_view.cancel')).toBe(false);
  });
});

describe('KILL: handler — removing a real dispatch loader drops the census', () => {
  it('a tool whose composite-handler loader is gone unbinds every action on it', () => {
    const { exarchos_event: _dropped, ...survivors } = COMPOSITE_HANDLER_LOADERS;
    const report = censusFor({ compiled: COMPILED, bindings: buildBindingTable(survivors) });
    expectKilled(report, BASELINE, 'handler', 'exarchos_event.append');
    const eventActions = BASELINE.actions.filter((a) => a.tool === 'exarchos_event');
    expect(eventActions.length).toBeGreaterThan(0);
    expect(report.closedActions).toBe(BASELINE.closedActions - eventActions.length);
  });

  it('a DUPLICATE binding for a real tool is an AMBIGUOUS handler', () => {
    const real = buildBindingTable();
    const duplicated = [...real, ...real.filter((b) => b.tool === 'exarchos_sync')];
    const report = censusFor({ compiled: COMPILED, bindings: duplicated });
    expectKilled(report, BASELINE, 'handler', 'exarchos_sync.now');
    expect(report.diagnostics.find((d) => d.hop === 'handler')?.kind).toBe('ambiguous');
  });
});

describe('KILL: owner — removing a real effect provider drops the census', () => {
  it('a mutating tool with no effect provider loses the owner hop', () => {
    const providers = EFFECT_PROVIDERS.filter((p) => p.tool !== 'exarchos_workflow');
    const report = censusFor({
      compiled: COMPILED,
      providers,
      // The real routers still exist — only the OWNER authority was broken.
      routerSources: resolveRouterSources(),
    });
    expect(report.ok).toBe(false);
    expect(report.closedActions).toBeLessThan(BASELINE.closedActions);
    const ownerDiags = report.diagnostics.filter((d) => d.hop === 'owner');
    expect(ownerDiags.length).toBeGreaterThan(0);
    for (const diag of ownerDiags) {
      const action = BASELINE.actions.find((a) => a.actionId === diag.actionId);
      expect(action?.tool).toBe('exarchos_workflow');
      expect(action?.mutates).toBe(true);
    }
    KILLED_HOPS.add('owner');
  });

  it('dropping a provider WITHOUT reconciling dispatch trips the tool-set ratchet', () => {
    const providers = EFFECT_PROVIDERS.filter((p) => p.tool !== 'exarchos_workflow');
    expect(() => collectReachabilityInputs({ compiled: COMPILED, providers })).toThrow(
      /disagree about the composite tool set/,
    );
  });
});

describe('KILL: schema / output / fixture — tampering the SHIPPED proof baseline drops the census', () => {
  it('a shipped input-schema digest that disagrees with the live compile breaks the schema hop', () => {
    const target = 'exarchos_workflow.get';
    const fixturesFile = mutatedArtifact(PROOF_FIXTURES_FILE, 'fixtures-schema.json', 'actions', (entries) =>
      entries.map((e) =>
        e.actionId === target ? { ...e, inputSchemaDigest: `sha256:${'0'.repeat(64)}` } : e,
      ),
    );
    const report = censusFor({ compiled: COMPILED, fixturesFile });
    expectKilled(report, BASELINE, 'schema', target);
    expect(report.closedActions).toBe(BASELINE.closedActions - 1);
  });

  it('an emptied shipped output contract breaks the output hop', () => {
    const target = 'exarchos_view.pipeline';
    const fixturesFile = mutatedArtifact(PROOF_FIXTURES_FILE, 'fixtures-output.json', 'actions', (entries) =>
      entries.map((e) => (e.actionId === target ? { ...e, outputKinds: [] } : e)),
    );
    const report = censusFor({ compiled: COMPILED, fixturesFile });
    expectKilled(report, BASELINE, 'output', target);
    expect(report.closedActions).toBe(BASELINE.closedActions - 1);
  });

  it('a shipped error-family contract that drifts from the live compile breaks the output hop', () => {
    const target = 'exarchos_event.query';
    const fixturesFile = mutatedArtifact(PROOF_FIXTURES_FILE, 'fixtures-errors.json', 'actions', (entries) =>
      entries.map((e) => (e.actionId === target ? { ...e, errorCodes: ['NOT_A_REAL_FAMILY'] } : e)),
    );
    const report = censusFor({ compiled: COMPILED, fixturesFile });
    expectKilled(report, BASELINE, 'output', target);
  });

  it('an action missing from the packaged proof baseline breaks the fixture hop', () => {
    const target = 'exarchos_sync.now';
    const fixturesFile = mutatedArtifact(PROOF_FIXTURES_FILE, 'fixtures-missing.json', 'actions', (entries) =>
      entries.filter((e) => e.actionId !== target),
    );
    const report = censusFor({ compiled: COMPILED, fixturesFile });
    expectKilled(report, BASELINE, 'fixture', target);
    expect(report.closedActions).toBe(BASELINE.closedActions - 1);
  });
});

describe('KILL: artifact — removing a SHIPPED client command drops the census', () => {
  it('an ActionId with no command in the shipped CLI surface breaks the artifact hop', () => {
    const target = 'exarchos_orchestrate.create_pr';
    const cliSurfaceFile = mutatedArtifact(CLI_SURFACE_FILE, 'cli-surface-missing.json', 'commands', (entries) =>
      entries.filter((e) => e.actionId !== target),
    );
    const report = censusFor({ compiled: COMPILED, cliSurfaceFile });
    expectKilled(report, BASELINE, 'artifact', target);
    expect(report.closedActions).toBe(BASELINE.closedActions - 1);
  });

  it('a DUPLICATED shipped command is an AMBIGUOUS artifact', () => {
    const target = 'exarchos_sync.now';
    const cliSurfaceFile = mutatedArtifact(CLI_SURFACE_FILE, 'cli-surface-dup.json', 'commands', (entries) => [
      ...entries,
      ...entries.filter((e) => e.actionId === target),
    ]);
    const report = censusFor({ compiled: COMPILED, cliSurfaceFile });
    expectKilled(report, BASELINE, 'artifact', target);
    expect(report.diagnostics.find((d) => d.hop === 'artifact')?.kind).toBe('ambiguous');
  });
});

describe('KILL: event — an emission the catalog never registered drops the census', () => {
  it('deleting a declared event from the live catalog breaks the event hop', () => {
    // The mutation is on the CATALOG, not on the registry that declares the
    // emission — which is the whole point of the hop. The action still says it
    // emits; the independently-authored table has simply never heard of the
    // event, and nothing else in the census can see that disagreement.
    const target = 'exarchos_orchestrate.task_claim';
    const declared = 'task.claimed';

    // The seed is real: this action really does declare this event today, so the
    // kill below is a removal rather than an assertion about a fixture.
    const declaredHere = (TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')?.actions ?? [])
      .find((a) => a.name === 'task_claim')
      ?.autoEmits?.some((e) => e.event === declared);
    expect(declaredHere, `${target} no longer declares ${declared}`).toBe(true);
    expect(EVENT_ANNOTATIONS[declared], `${declared} is not in the catalog`).toBeDefined();

    const { [declared]: _removed, ...withoutEvent } = EVENT_ANNOTATIONS;
    const report = censusFor({ compiled: COMPILED, annotations: withoutEvent });
    expectKilled(report, BASELINE, 'event', target);
  });

  it('an action that declares NO emission is not-applicable, not missing', () => {
    // The complement, and the reason the kill above is attributable. A read verb
    // declares nothing, so the hop does not apply to it — reporting those as
    // `missing` would make every read a closure break and drown the real one.
    const inputs = collectReachabilityInputs({ compiled: COMPILED });
    const pure = inputs.actions.find(
      (a) => !inputs.emissions.some((e) => e.actionId === a.actionId),
    );
    expect(pure, 'every action emits — the not-applicable arm has no subject').toBeDefined();
    if (pure === undefined) return;
    const hop = resolveHops(pure, inputs).find((h) => h.hop === 'event');
    expect(hop?.status).toBe('not-applicable');

    // ...and the applicable arm is non-empty too, so neither side is asserted
    // over nothing.
    expect(inputs.emissions.length).toBeGreaterThan(0);
  });
});

describe('the anti-tautology ratchet', () => {
  it('EVERY hop counted in the headline census is proven killable by a real-input mutation', () => {
    expect([...KILLED_HOPS].sort()).toEqual([...REACHABILITY_HOPS].sort());
  });

  it('no hop is resolved against the compile pass that supplies the denominator', () => {
    for (const hop of REACHABILITY_HOPS) {
      expect(['runtime', 'shipped-artifact'], `hop '${hop}'`).toContain(HOP_AUTHORITIES[hop]);
    }
    expect(Object.keys(HOP_AUTHORITIES).sort()).toEqual([...REACHABILITY_HOPS].sort());
  });
});
