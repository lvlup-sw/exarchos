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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import { handleView } from './composite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse `views/composite.ts` and return every action name handled by a
 * `case 'xxx':` arm in the `handleView` switch. Excludes `describe` (the
 * introspection action itself — there's no requirement to introspect the
 * introspector) and the `default` arm (not a dispatched action).
 */
function collectDispatchedActionNames(): string[] {
  const source = readFileSync(resolve(__dirname, 'composite.ts'), 'utf-8');
  const matches = source.matchAll(/case '([a-z_]+)':/g);
  const names = new Set<string>();
  for (const m of matches) {
    if (m[1] === 'describe') continue;
    names.add(m[1]);
  }
  return [...names].sort();
}

describe('ExarchosViewDescribe — registry-vs-dispatch parity (T1, #1446 residue)', () => {
  it('ExarchosViewDescribe_ListsAllSeventeenDispatchedActions', async () => {
    const dispatched = collectDispatchedActionNames();

    // Sanity: composite.ts must dispatch at least the three actions T1 is
    // closing residue on, plus the broader Wave 5 set. If this collapses to
    // zero, the regex needs an update — fail loudly rather than silently.
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched).toContain('session_provenance');
    expect(dispatched).toContain('provenance');
    expect(dispatched).toContain('ideate_readiness');

    const ctx: DispatchContext = {
      stateDir: '/tmp/test-describe-coverage',
      eventStore: new EventStore('/tmp/test-describe-coverage'),
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
