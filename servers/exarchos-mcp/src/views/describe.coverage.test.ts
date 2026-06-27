// ─── T1 (#1446 residue) — Describe coverage parity ──────────────────────────
//
// Pins the registry-vs-dispatch parity contract for `exarchos_view`. Every
// action dispatched through `views/composite.ts` MUST be registered in
// `TOOL_REGISTRY.viewActions`. Without this parity:
//   1. Per-action Zod validation at `core/dispatch.ts:801` is silently
//      skipped for the unregistered action (DR-5 hole).
//   2. `exarchos_view describe` cannot surface the action's schema — the
//      handler reads schemas from the registry, so unregistered actions
//      are invisible to introspection.
//
// The test parses `composite.ts` to collect the dispatched action names from
// the switch statement (the dispatched-surface source of truth), then calls
// `exarchos_view { action: 'describe', actions: [<all>] }` and asserts each
// dispatched name resolves to a describe entry. The dynamic discovery means
// adding a new view action to composite.ts without registering it surfaces
// here immediately.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import { TOOL_REGISTRY } from '../registry.js';
import { handleView } from './composite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse `views/composite.ts` and return every action name handled by a
 * `case 'xxx':` arm inside the `handleView` switch (NOT case arms anywhere
 * else in the file — `composite.ts` includes other helper switches whose
 * cases must not pollute the action surface). Excludes `describe` (the
 * introspection action itself).
 *
 * The regex first isolates the `handleView` body up to its closing brace,
 * then locates the `switch (action) {...}` block within it, then collects
 * `case '...':` literals from that block only. Tightened in response to a
 * CodeRabbit nit on #1450 — the previous loose `[a-z_]+` regex against the
 * full file could have picked up unrelated case arms.
 */
function collectDispatchedActionNames(): string[] {
  const source = readFileSync(resolve(__dirname, 'composite.ts'), 'utf-8');
  // Anchor on `switch (action) {` opening through the switch's `default:`
  // arm — `default:` inside a switch is a deterministic terminator that
  // doesn't collide with inner block close braces. Falling back to a body-
  // wide regex would risk picking up case arms from helper switches
  // declared elsewhere in the same file.
  const switchMatch = source.match(
    /export\s+async\s+function\s+handleView[\s\S]*?switch\s*\(\s*action\s*\)\s*\{([\s\S]*?)default\s*:/,
  );
  if (!switchMatch || switchMatch[1] === undefined) {
    throw new Error(
      'collectDispatchedActionNames: could not locate handleView action switch (or its default arm) in views/composite.ts',
    );
  }
  const switchBody = switchMatch[1];
  const matches = switchBody.matchAll(/case\s+'([^']+)'\s*:/g);
  const names = new Set<string>();
  for (const m of matches) {
    const name = m[1];
    if (name === undefined || name === 'describe') continue;
    names.add(name);
  }
  return [...names].sort();
}

/**
 * Registered view-action names on `exarchos_view`, EXCLUDING `describe`.
 *
 * `describe` is the introspection action itself: it is BOTH registered (via
 * `makeDescribeAction` in TOOL_REGISTRY.viewActions) AND routed (a
 * `case 'describe':` arm in `handleView`), but `collectDispatchedActionNames`
 * deliberately omits it because it is not a materialized-view action. To put
 * the routed surface and the registered surface on equal footing for the
 * equality guard, we drop `describe` from BOTH sides. This is the view-side
 * analogue of the orchestrate guard's documented `SPECIAL_ACTIONS` skip-set
 * (`registry.test.ts` → `OrchestrateActions_MatchCompositeHandlers_InSync`) —
 * the one intentional exception to set equality.
 */
function collectRegisteredViewActionNames(): string[] {
  const view = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
  if (!view) {
    throw new Error(
      'collectRegisteredViewActionNames: exarchos_view composite not found in TOOL_REGISTRY',
    );
  }
  return view.actions
    .map((a) => a.name)
    .filter((n) => n !== 'describe')
    .sort();
}

// ─── View-side EQUALITY guard (DR-4 / DR-7 — close the view DOA hole) ────────
//
// The pre-existing `describe.coverage` test above is a SUPERSET guard:
// "registry COVERS the dispatched surface" (registered ⊇ routed). That shape
// lets a view action be registered-but-UNROUTED — registered in
// TOOL_REGISTRY.viewActions with NO `case` arm in `handleView` — ship Dead On
// Arrival: every call falls through to `default` → UNKNOWN_ACTION at runtime,
// while the action's own unit tests (which call the underlying handler
// directly) stay green. This is exactly the class of bug the orchestrate twin
// (`OrchestrateActions_MatchCompositeHandlers_InSync`) was added to fence after
// `onboard` shipped registered-but-unrouted.
//
// This guard upgrades the contract to EQUALITY: the set of view actions routed
// by the `handleView` switch (source-parsed via the same tightened regex the
// coverage test uses) MUST equal the set registered on `exarchos_view`, modulo
// the single documented `describe` exception. It turns red in BOTH directions —
// a registered-but-unrouted action AND a routed-but-unregistered action.
describe('ExarchosView — registry↔dispatch EQUALITY guard (DR-4/DR-7, view DOA fence)', () => {
  it('ViewActions_MatchCompositeHandlers_InSync', () => {
    const routed = collectDispatchedActionNames(); // case arms (minus describe)
    const registered = collectRegisteredViewActionNames(); // registry (minus describe)

    // Sanity: both surfaces must be non-empty, and must include the WLM
    // operational-core liveness reads (`ps` / `wait`, Task 004) plus the
    // foundation read (`worktrees`, Task 008). If a future regex/registry edit
    // collapses either set to zero this fails loudly rather than passing
    // vacuously (two empty sets are trivially equal).
    expect(routed.length).toBeGreaterThan(0);
    expect(registered.length).toBeGreaterThan(0);
    for (const name of ['ps', 'wait', 'worktrees']) {
      expect(routed, `handleView must route '${name}'`).toContain(name);
      expect(
        registered,
        `exarchos_view must register '${name}'`,
      ).toContain(name);
    }

    // Direction 1 — registered-but-UNROUTED (the DOA hole the superset test
    // cannot see). A view action in the registry with no `case` arm in
    // handleView would dispatch to UNKNOWN_ACTION at runtime.
    const registeredNotRouted = registered.filter((n) => !routed.includes(n));
    expect(
      registeredNotRouted,
      `View action(s) registered on exarchos_view but NOT routed by handleView ` +
        `(would ship DOA → UNKNOWN_ACTION): [${registeredNotRouted.join(', ')}]. ` +
        `Add a matching 'case' arm in views/composite.ts.`,
    ).toEqual([]);

    // Direction 2 — routed-but-UNREGISTERED. Per-action Zod validation in the
    // dispatch core is silently skipped and the action is invisible to
    // `describe`. (The superset test already covers this direction; the
    // equality guard re-pins it so one test owns the full contract.)
    const routedNotRegistered = routed.filter((n) => !registered.includes(n));
    expect(
      routedNotRegistered,
      `View action(s) routed by handleView but NOT registered on exarchos_view ` +
        `(Zod validation skipped + invisible to describe): ` +
        `[${routedNotRegistered.join(', ')}]. ` +
        `Add it to TOOL_REGISTRY.viewActions in src/registry.ts.`,
    ).toEqual([]);

    // Belt-and-suspenders: the two surfaces are identical sets.
    expect(routed).toEqual(registered);
  });
});

describe('ExarchosViewDescribe — registry-vs-dispatch parity (T1, #1446 residue)', () => {
  let tempStateDir: string;

  beforeEach(() => {
    tempStateDir = mkdtempSync(join(tmpdir(), 'exarchos-describe-coverage-'));
  });

  afterEach(() => {
    rmSync(tempStateDir, { recursive: true, force: true });
  });

  it('ExarchosViewDescribe_ListsAllSeventeenDispatchedActions', async () => {
    const dispatched = collectDispatchedActionNames();

    // Sanity: composite.ts must dispatch at least the three actions T1 is
    // closing residue on, plus the broader Wave 5 set. If this collapses to
    // zero, the regex needs an update — fail loudly rather than silently.
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched).toContain('session_provenance');
    expect(dispatched).toContain('provenance');

    const ctx: DispatchContext = {
      stateDir: tempStateDir,
      eventStore: new EventStore(tempStateDir),
      enableTelemetry: false,
    };

    // Drive the public introspection surface end-to-end. `handleDescribe`
    // returns UNKNOWN_ACTION on the first unregistered name in `args.actions`,
    // so a single missing entry fails this assertion with a clear message
    // naming the offending action.
    const result = await handleView(
      { action: 'describe', actions: dispatched },
      ctx,
    );

    expect(
      result.success,
      `describe(actions=[${dispatched.join(',')}]) must succeed; ` +
        `got error: ${JSON.stringify(result.error ?? {})}`,
    ).toBe(true);

    const data = result.data as Record<string, unknown>;
    const describedNames = Object.keys(data);

    // Every dispatched name MUST appear as a key in describe's response.
    // Superset assertion (rather than equality) so additions to the
    // registry don't break this test — the contract is "registry covers
    // dispatched surface", not "they are identical sets".
    for (const name of dispatched) {
      expect(
        describedNames,
        `Registry is missing dispatched view action '${name}'. ` +
          `Add it to TOOL_REGISTRY.viewActions in src/registry.ts.`,
      ).toContain(name);
    }
  });
});
