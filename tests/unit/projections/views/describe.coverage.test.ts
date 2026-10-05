// Tests that the `exarchos_view` registry and the action switch in `projections/views/composite.ts` hold the same actions.
// The dispatch core refuses a routed action that has no registration, and `describe` cannot return its schema.
// A registered action with no `case` arm returns `UNKNOWN_ACTION` at runtime.
// The tests parse `composite.ts` for the `case` arms, so a new arm with no registration fails here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import { handleView } from '../../../../src/projections/views/composite.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Returns the sorted action names of the `case` arms in the view action switch of `composite.ts`, without `describe`.
 * The regex starts at the `handleView` declaration, takes the first `switch (action)` block after it, and stops at the `default:` arm.
 * `default:` is a stable end marker, because a closing brace also ends each inner block.
 */
function collectDispatchedActionNames(): string[] {
  const source = readFileSync(resolve(__dirname, '../../../../src/projections/views/composite.ts'), 'utf-8');
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
 * Returns the sorted action names registered on `exarchos_view`, without `describe`.
 * `describe` is registered and routed, but it is the introspection action, not a view.
 * Both collectors drop it, so the two sets compare on equal terms.
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

/**
 * The routed set must equal the registered set, apart from `describe`.
 * A registered action with no `case` arm can pass its unit tests, which call the handler directly.
 * At runtime, that action returns `UNKNOWN_ACTION`.
 */
describe('ExarchosView — registry↔dispatch EQUALITY guard (DR-4/DR-7, view DOA fence)', () => {
  /**
   * Both sets must be non-empty and must hold `ps`, `wait` and `worktrees`, because two empty sets are equal.
   * The test then checks each direction separately, so the failure message names the action and the missing side.
   */
  it('ViewActions_MatchCompositeHandlers_InSync', () => {
    const routed = collectDispatchedActionNames();
    const registered = collectRegisteredViewActionNames();

    expect(routed.length).toBeGreaterThan(0);
    expect(registered.length).toBeGreaterThan(0);
    for (const name of ['ps', 'wait', 'worktrees']) {
      expect(routed, `handleView must route '${name}'`).toContain(name);
      expect(
        registered,
        `exarchos_view must register '${name}'`,
      ).toContain(name);
    }

    const registeredNotRouted = registered.filter((n) => !routed.includes(n));
    expect(
      registeredNotRouted,
      `View action(s) registered on exarchos_view but NOT routed by handleView ` +
        `(would ship DOA → UNKNOWN_ACTION): [${registeredNotRouted.join(', ')}]. ` +
        `Add a matching 'case' arm in views/composite.ts.`,
    ).toEqual([]);

    const routedNotRegistered = routed.filter((n) => !registered.includes(n));
    expect(
      routedNotRegistered,
      `View action(s) routed by handleView but NOT registered on exarchos_view ` +
        `(Zod validation skipped + invisible to describe): ` +
        `[${routedNotRegistered.join(', ')}]. ` +
        `Add it to TOOL_REGISTRY.viewActions in src/registry.ts.`,
    ).toEqual([]);

    expect(routed).toEqual(registered);
  });
});

describe('ExarchosViewDescribe — registry-vs-dispatch parity (T1, #1446 residue)', () => {
  let tempStateDir: string;

  beforeEach(() => {
    tempStateDir = mkdtempSync(join(tmpdir(), 'exarchos-describe-coverage-'));
  });

  afterEach(() => {
    rmrf(tempStateDir);
  });

  /**
   * The dispatched set must hold `session_provenance` and `provenance`, so an empty parse cannot pass.
   * `describe` returns `UNKNOWN_ACTION` for the first unregistered name, so one missing registration fails the call.
   * The key check is a superset check: the registry must cover each dispatched name.
   */
  it('ExarchosViewDescribe_ListsAllSeventeenDispatchedActions', async () => {
    const dispatched = collectDispatchedActionNames();

    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched).toContain('session_provenance');
    expect(dispatched).toContain('provenance');

    const ctx: DispatchContext = {
      stateDir: tempStateDir,
      eventStore: new EventStore(tempStateDir),
      enableTelemetry: false,
    };

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

    for (const name of dispatched) {
      expect(
        describedNames,
        `Registry is missing dispatched view action '${name}'. ` +
          `Add it to TOOL_REGISTRY.viewActions in src/registry.ts.`,
      ).toContain(name);
    }
  });
});
