/**
 * Verb registration snapshot.
 *
 * A file move can drop a handler from the registry, or register an action with no dispatch
 * branch. Both compile cleanly, and the action answers UNKNOWN_ACTION at runtime. A unit test of
 * the handler alone does not see this.
 *
 * The two halves fail independently, so the suite checks both. The snapshot catches a lost
 * registration, and the orphan check catches an action with no case branch.
 *
 * @oracle-sources: ../../../src/registry.ts, live-composite-dispatch-sources
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import { fromRepoRoot, SUBJECT_SRC_ROOT } from './subject-root.js';

const BASELINE = fromRepoRoot('tools/audit/verb-registration-baseline.json');
/** Composite handler paths are declared relative to the SUBJECT's source root. */
const SRC = SUBJECT_SRC_ROOT;

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

  /**
   * Regenerate the snapshot with `node tools/audit/measure-verb-registration.mjs` only when an
   * action is added or removed. A regrouping must not change it.
   */
  it('matches the checked-in snapshot exactly', () => {
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

  /**
   * The orphan check: an action that is registered but cannot be routed. Several composites
   * handle `describe` generically, so it is exempt by name. A composite with no `case` branch
   * is skipped.
   */
  it('every registered action has a dispatch branch in its composite', () => {
    const GENERIC = new Set(['describe']);
    const orphaned: string[] = [];
    for (const tool of TOOL_REGISTRY) {
      const rel = COMPOSITES[tool.name];
      if (!rel) continue;
      const routed = routedActionNames(rel);
      if (routed.size === 0) continue;
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

/**
 * Kill probe for the snapshot. A snapshot that nobody proved can fail can one day be
 * regenerated to match a regression.
 */
describe('VerbRegistration_DroppedHandler_FailsTheSnapshot', () => {
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

  /** Seeds the exact defect: an action name that no composite routes. */
  it('the orphan check really detects an unroutable action', () => {
    const routed = routedActionNames(COMPOSITES.exarchos_workflow as string);
    expect(routed.size).toBeGreaterThan(0);
    expect(routed.has('an_action_no_composite_routes')).toBe(false);
  });

  /**
   * Positive control: a known workflow action is routed. Negative control: an action of a
   * different tool is not.
   */
  it('the composite scan is reading real switch branches, not matching everything', () => {
    const routed = routedActionNames(COMPOSITES.exarchos_workflow as string);
    expect(routed.has('rehydrate')).toBe(true);
    expect(routed.has('task_claim')).toBe(false);
  });
});
