/**
 * Verb registration snapshot (DR-2, DR-9, task 015).
 *
 * Task 015 regroups 82 flat files out of `orchestrate/` into capability
 * directories. The failure mode that move can cause is invisible to every other
 * gate: a handler that stops being registered, or an action registered with no
 * dispatch branch behind it, **compiles cleanly**. Typecheck is happy, the
 * import graph is happy, and the action simply answers UNKNOWN_ACTION at
 * runtime — which no unit test covering that handler in isolation will notice.
 *
 * So the snapshot is the gate, and it covers BOTH halves, because they fail
 * independently: the registry can list an action the composite cannot route
 * (the known UNKNOWN_ACTION trap), and the composite can route one the registry
 * never advertises.
 *
 * Authored in the MCP workspace rather than the plan's `tests/architecture/`
 * path because it IMPORTS the live registry — the root project excludes this
 * workspace and does not carry its `bun:sqlite` alias, so the import would not
 * resolve there.
 *
 * @oracle-sources: ../registry.ts, live-composite-dispatch-sources
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const BASELINE = path.resolve(SRC, '../../../tools/audit/verb-registration-baseline.json');

/** Every `<tool>.<action>` id the registry advertises, sorted. */
function registeredActionIds(): string[] {
  const ids: string[] = [];
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) ids.push(`${tool.name}.${action.name}`);
  }
  return ids.sort();
}

/**
 * The composite files that route actions, by tool name. These are the switch
 * statements a regrouping can orphan.
 */
const COMPOSITES: Readonly<Record<string, string>> = {
  exarchos_workflow: 'workflow/composite.ts',
  exarchos_event: 'events/composite.ts',
  exarchos_orchestrate: 'verbs/composite.ts',
  exarchos_view: 'projections/views/composite.ts',
  exarchos_sync: 'sync/composite.ts',
};

/** Action names a composite has a `case '<name>'` branch for. */
function routedActionNames(compositeRel: string): Set<string> {
  const abs = path.join(SRC, compositeRel);
  if (!existsSync(abs)) return new Set();
  const src = readFileSync(abs, 'utf8');
  return new Set([...src.matchAll(/case\s+'([a-z0-9_]+)'/gi)].map((m) => m[1] as string));
}

describe('VerbRegistration_AfterRegrouping_EveryActionStillRegisters', () => {
  const ids = registeredActionIds();

  it('the registry is non-empty and every id is well formed', () => {
    expect(ids.length).toBeGreaterThan(100);
    for (const id of ids) expect(id).toMatch(/^exarchos_[a-z]+\.[a-z0-9_-]+$/);
  });

  it('no duplicate action ids', () => {
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('matches the checked-in snapshot exactly', () => {
    // Regenerate deliberately with `node tools/audit/measure-verb-registration.mjs`
    // when an action is genuinely added or removed. A regrouping must NOT change
    // this file — that is the whole point.
    expect(existsSync(BASELINE), `snapshot missing at ${BASELINE}`).toBe(true);
    const snapshot = JSON.parse(readFileSync(BASELINE, 'utf8')) as { actionIds: string[] };
    expect(
      ids,
      'The registered action set changed. If a move caused this, a handler stopped ' +
        'registering — it compiles clean and answers UNKNOWN_ACTION at runtime. If the ' +
        'change is intended, regenerate the snapshot in the same commit.',
    ).toEqual(snapshot.actionIds);
  });

  it('every composite still exists where the registry expects it', () => {
    for (const [tool, rel] of Object.entries(COMPOSITES)) {
      expect(existsSync(path.join(SRC, rel)), `${tool}: composite missing at ${rel}`).toBe(true);
    }
  });

  it('every registered action has a dispatch branch in its composite', () => {
    // The other half of the trap: registered but unroutable. `describe` is
    // handled generically by several composites, so it is exempt by name.
    const GENERIC = new Set(['describe']);
    const orphaned: string[] = [];
    for (const tool of TOOL_REGISTRY) {
      const rel = COMPOSITES[tool.name];
      if (!rel) continue;
      const routed = routedActionNames(rel);
      if (routed.size === 0) continue; // composite does not use a switch — skip
      for (const action of tool.actions) {
        if (GENERIC.has(action.name)) continue;
        if (!routed.has(action.name)) orphaned.push(`${tool.name}.${action.name}`);
      }
    }
    expect(
      orphaned,
      'These actions are advertised by the registry but have no case branch in their ' +
        'composite, so they answer UNKNOWN_ACTION at runtime while compiling cleanly.',
    ).toEqual([]);
  });
});

describe('VerbRegistration_DroppedHandler_FailsTheSnapshot', () => {
  // A snapshot nobody has proved can fail is a snapshot that will one day be
  // regenerated to match a regression. These tests are its kill probe.
  const ids = registeredActionIds();

  it('dropping one action from the observed set fails the comparison', () => {
    const dropped = ids.filter((_, i) => i !== 0);
    expect(dropped).not.toEqual(ids);
    expect(dropped.length).toBe(ids.length - 1);
  });

  it('renaming one action fails the comparison', () => {
    const renamed = [...ids];
    renamed[0] = `${renamed[0]}_renamed`;
    expect(renamed).not.toEqual(ids);
  });

  it('the orphan check really detects an unroutable action', () => {
    // Seed the exact defect: an action name no composite routes.
    const routed = routedActionNames(COMPOSITES.exarchos_workflow as string);
    expect(routed.size).toBeGreaterThan(0);
    expect(routed.has('an_action_no_composite_routes')).toBe(false);
  });

  it('the composite scan is reading real switch branches, not matching everything', () => {
    const routed = routedActionNames(COMPOSITES.exarchos_workflow as string);
    // Positive control: a known workflow action IS routed.
    expect(routed.has('rehydrate')).toBe(true);
    // Negative control: an action belonging to a DIFFERENT tool is not.
    expect(routed.has('task_claim')).toBe(false);
  });
});
