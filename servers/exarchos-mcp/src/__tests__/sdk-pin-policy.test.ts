// ─── #1292 / DR-0 — MCP SDK pin-policy guard ───────────────────────────────
//
// Every `@modelcontextprotocol/*` dependency is intentionally **exact-pinned**
// (no caret/tilde range), so a minor bump is an explicit, reviewed decision
// rather than something `npm install` picks up implicitly. This test guards
// against a future caret/tilde reintroduction on any of them.
//
// Two SDK generations are installed side by side (DR-0):
//
//   • `@modelcontextprotocol/sdk`    — v1 (1.29.0). Still the only generation
//     any source module imports; see the migration-blocker note below.
//   • `@modelcontextprotocol/core`   — v2 protocol types.
//   • `@modelcontextprotocol/server` — v2 server surface. Carries the APIs
//     three later DRs depend on: `createRequestStateCodec` + `inputRequired`
//     (DR-9), `ctx.mcpReq.envelope` (DR-14), and `serveStdio` (DR-9's parity
//     proof). Adding it is additive and independently revertible.
//
// The two generations use DIFFERENT package names, so they coexist in one
// `node_modules` without npm dedupe collapsing them — that is what makes the
// alongside-install safe. It is also what makes mixing them a compile error
// rather than a silent double-protocol-copy; `sdk-v2-type-isolation.test.ts`
// pins that.
//
// Re-scope note: the originating issue (#1292) assumed a `^1.0.0` range and
// proposed swapping to `1.26.x`. That premise was already stale — the v1
// dependency was exact at `1.29.0`. This is therefore a pin-policy
// ratification + guard, not a version swap.
//
// MIGRATION BLOCKER (measured, not assumed — DR-0 task 049): v1 cannot be
// removed yet. v2 2.0.0 deletes the experimental Tasks *store* seam that the
// MCP adapter is built on — there is no `ServerOptions.taskStore`, and no
// `@modelcontextprotocol/sdk/experimental/tasks/interfaces` counterpart for
// `TaskStore` / `CreateTaskOptions` / `isTerminal`. `EventSourcedTaskStore`
// (#1272/#1273) implements that v1 interface, so migrating `adapters/mcp.ts`
// requires designing a replacement first. v1 therefore stays installed and
// exact-pinned until that lands.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → servers/exarchos-mcp
const packageJsonPath = join(here, '..', '..', 'package.json');

/** The v2 packages added by DR-0, alongside (not replacing) the v1 `sdk`. */
const V2_PACKAGES = ['@modelcontextprotocol/core', '@modelcontextprotocol/server'] as const;

/** Exact version (`2.0.0`) or minor-x (`2.0.x`) — no range operators. */
const EXACT_PIN = /^\d+\.\d+\.(\d+|x)$/;

function readDependencies(): Record<string, string> {
  const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (typeof pkg !== 'object' || pkg === null) {
    throw new Error('package.json did not parse to an object');
  }
  const deps = (pkg as { dependencies?: unknown }).dependencies;
  if (typeof deps !== 'object' || deps === null) {
    throw new Error('package.json has no dependencies object');
  }
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range === 'string') out[name] = range;
  }
  return out;
}

function readRange(name: string): string {
  const range = readDependencies()[name];
  expect(range, `${name} must be a declared dependency`).toBeTypeOf('string');
  return range;
}

function expectExactPin(name: string, range: string): void {
  expect(range, `${name} must be exact-pinned, got "${range}"`).toMatch(EXACT_PIN);
  // Explicitly NOT a caret or tilde range — the whole point of the policy.
  expect(range.startsWith('^'), `${name} must not use a caret range`).toBe(false);
  expect(range.startsWith('~'), `${name} must not use a tilde range`).toBe(false);
}

describe('MCP SDK pin policy (#1292, DR-0)', () => {
  it('McpSdkPin_PackageJson_IsExactNotCaretRange', () => {
    expectExactPin('@modelcontextprotocol/sdk', readRange('@modelcontextprotocol/sdk'));
  });

  it('SdkPinPolicy_V2Packages_AreExactPinned', () => {
    // Both v2 packages must be declared...
    const deps = readDependencies();
    for (const name of V2_PACKAGES) {
      expect(deps[name], `${name} must be a declared dependency (DR-0)`).toBeTypeOf(
        'string',
      );
    }

    // ...and each must carry the same exact-pin policy as v1. The rationale is
    // deliberate opt-in to surface changes: v2 is a new major whose surface is
    // still settling, so an implicit `npm install` bump is exactly what the
    // policy exists to prevent.
    for (const name of V2_PACKAGES) {
      expectExactPin(name, deps[name]!);
    }

    // The two generations must stay on DIFFERENT package names — that is what
    // lets them coexist. If a future edit ever points a v2 name at the v1
    // package (or vice versa) the alongside-install premise silently breaks.
    for (const name of V2_PACKAGES) {
      expect(name).not.toBe('@modelcontextprotocol/sdk');
      expect(deps[name]!.startsWith('1.')).toBe(false);
    }
  });

  it('SdkPinPolicy_V1AndV2_CoexistAsDistinctPackages', () => {
    // DR-0's core claim: this is ADDITIVE. v1 must still be declared while any
    // source module still imports it. If a future change drops v1, that is
    // only legitimate once nothing imports it — at which point this
    // expectation should be deleted deliberately, not silently.
    const deps = readDependencies();
    expect(deps['@modelcontextprotocol/sdk']).toBeTypeOf('string');
    expect(deps['@modelcontextprotocol/core']).toBeTypeOf('string');
    expect(deps['@modelcontextprotocol/server']).toBeTypeOf('string');
    expect(deps['@modelcontextprotocol/sdk']!.startsWith('1.')).toBe(true);
  });
});
