/**
 * Kill fixtures: the proof that the closure census can fall.
 *
 * The seeded breaks in `collect.test.ts` change a materialized `ReachabilityInputs` value, so they
 * prove only that the evaluator reacts. Each fixture here mutates a real upstream authority:
 * - route: a copy of a shipped composite router with a routing arm renamed, removed or duplicated.
 * - handler: the real `COMPOSITE_HANDLER_LOADERS` map without one loader, bound by
 *   `buildBindingTable`.
 * - owner: the real `EFFECT_PROVIDERS` map without one provider.
 * - schema, output, fixture: a copy of the shipped `proof-fixtures.json` with one entry changed.
 * - artifact: a copy of the shipped `cli-surface.json` with one command removed or duplicated.
 * - event: the real `EVENT_ANNOTATIONS` catalog without one event.
 *
 * The last suite asserts that the fixtures here kill each hop in `REACHABILITY_HOPS`.
 */
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
import { TOOL_REGISTRY, contractEmissionsOf } from '../../../../src/registry.js';
import { PROOF_FIXTURES_FILE } from '../../../../src/contract/compiler/generate.js';
import { CLI_SURFACE_FILE } from '../../../../src/contract/cli/cli-contract-seam.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const KILLED_HOPS = new Set<ReachabilityHop>();

/** Returns the census for a mutated authority set. */
function censusFor(opts: CollectOptions): ClosureReport {
  return evaluateClosure(collectReachabilityInputs(opts));
}

/** Asserts that the census dropped because of `hop` for `actionId`. Then records the killed hop. */
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

/** The cleanup is best effort. A Windows handle lag must not fail the suite. */
afterAll(() => {
  try {
    rmrf(TMP);
  } catch {
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

  /**
   * The scanner resolves the computed key `[MUTATION_GATE_NAME]` through the import of the router.
   * Thus the test also copies the imported module to the relative path that the router names.
   */
  it('deleting a real key from the shipped orchestrate dispatch TABLE unroutes that action', () => {
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

  /**
   * The workflow router loses `cancel` and the views router gains it. The arm still exists in the
   * tree, but it does not serve `exarchos_workflow.cancel`.
   * The moved arm must also close no action under the views tool.
   */
  it('an arm that MOVED to another composite router leaves its own ActionId unrouted', () => {
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
  /**
   * The test passes the real router sources, so only the owner authority is broken.
   * Without them, the collector throws on the tool-set mismatch, as the next test shows.
   */
  it('a mutating tool with no effect provider loses the owner hop', () => {
    const providers = EFFECT_PROVIDERS.filter((p) => p.tool !== 'exarchos_workflow');
    const report = censusFor({
      compiled: COMPILED,
      providers,
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
  /**
   * The mutation is on the event catalog, not on the registry that declares the emission.
   * The action still declares the event, and the mutated catalog does not hold it.
   * The test first asserts that the action declares the event and that the live catalog holds it.
   */
  it('deleting a declared event from the live catalog breaks the event hop', () => {
    const target = 'exarchos_orchestrate.task_claim';
    const declared = 'task.claimed';

    const taskClaim = (TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate')?.actions ?? [])
      .find((a) => a.name === 'task_claim');
    const declaredHere = contractEmissionsOf(taskClaim ?? {}).some((e) => e.event === declared);
    expect(declaredHere, `${target} no longer declares ${declared}`).toBe(true);
    expect(EVENT_ANNOTATIONS[declared], `${declared} is not in the catalog`).toBeDefined();

    const { [declared]: _removed, ...withoutEvent } = EVENT_ANNOTATIONS;
    const report = censusFor({ compiled: COMPILED, annotations: withoutEvent });
    expectKilled(report, BASELINE, 'event', target);
  });

  /**
   * An action that declares no emission has a `not-applicable` event hop, not a `missing` one.
   * The test also asserts that some action emits, so each arm has a subject.
   */
  it('an action that declares NO emission is not-applicable, not missing', () => {
    const inputs = collectReachabilityInputs({ compiled: COMPILED });
    const pure = inputs.actions.find(
      (a) => !inputs.emissions.some((e) => e.actionId === a.actionId),
    );
    expect(pure, 'every action emits — the not-applicable arm has no subject').toBeDefined();
    if (pure === undefined) return;
    const hop = resolveHops(pure, inputs).find((h) => h.hop === 'event');
    expect(hop?.status).toBe('not-applicable');

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
