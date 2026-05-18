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
    expect(dispatched).toContain('ideate_readiness');

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
