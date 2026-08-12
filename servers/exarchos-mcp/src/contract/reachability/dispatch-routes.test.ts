import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

import {
  DispatchRouteScanError,
  SOURCE_ROOT,
  collectDispatchRoutes,
  extractEqualityBranchActions,
  extractHandlerTableActions,
  extractSwitchCaseActions,
  maskCommentsAndStrings,
  matchingBrace,
  readRouterRoutes,
  resolveRouterSources,
} from './dispatch-routes.js';
import { EFFECT_PROVIDERS } from './providers.js';
import { TOOL_REGISTRY } from '../../registry.js';
import { COMPOSITE_HANDLER_LOADERS } from '../../dispatch/core/dispatch.js';

// ─── The shipped dispatch-route authority ────────────────────────────────────
//
// These pin the scanner against the REAL tree from two directions:
//   • completeness — the route set it reads equals the live registry's action
//     set, per tool (so the `route` hop has a genuine denominator); and
//   • fidelity     — for the one composite that exposes its dispatch table as a
//     RUNTIME value (`orchestrate`'s `ACTION_HANDLER_KEYS`), the scanned set is
//     a superset of that runtime value. A scanner that quietly missed keys (or
//     invented them) fails here rather than inflating closure.

describe('router-source resolution — the tool → shipped router map', () => {
  it('resolves exactly one router file per dispatchable composite tool', () => {
    const sources = resolveRouterSources();
    expect(sources.map((s) => s.tool).sort()).toEqual(Object.keys(COMPOSITE_HANDLER_LOADERS).sort());
    for (const source of sources) {
      expect(fs.existsSync(source.file), `${source.tool} → ${source.file}`).toBe(true);
      expect(source.file.startsWith(SOURCE_ROOT)).toBe(true);
    }
  });

  it('THROWS when the dispatch loader map and the provider map disagree on the tool set', () => {
    const providers = EFFECT_PROVIDERS.filter((p) => p.tool !== 'exarchos_sync');
    expect(() => resolveRouterSources(providers, COMPOSITE_HANDLER_LOADERS)).toThrow(
      DispatchRouteScanError,
    );
    expect(() =>
      resolveRouterSources(EFFECT_PROVIDERS, { ...COMPOSITE_HANDLER_LOADERS, exarchos_ghost: () => null }),
    ).toThrow(/no provider/);
  });
});

describe('the shipped route table covers the live public action surface', () => {
  it('reads exactly the registry action set for every composite tool', () => {
    const routes = collectDispatchRoutes();
    for (const tool of TOOL_REGISTRY) {
      const routed = routes.filter((r) => r.tool === tool.name).map((r) => r.action);
      const declared = tool.actions.map((a) => a.name);
      expect([...routed].sort(), `tool ${tool.name}`).toEqual([...declared].sort());
    }
  });

  it('routes every ActionId exactly once — no duplicate/ambiguous routing arm', () => {
    const routes = collectDispatchRoutes();
    const counts = new Map<string, number>();
    for (const r of routes) counts.set(r.actionId, (counts.get(r.actionId) ?? 0) + 1);
    expect([...counts.entries()].filter(([, n]) => n > 1)).toEqual([]);
    expect(routes.length).toBe(TOOL_REGISTRY.reduce((n, t) => n + t.actions.length, 0));
  });

  it('FIDELITY: the scanned orchestrate table is a superset of the RUNTIME dispatch table', async () => {
    const { ACTION_HANDLER_KEYS } = await import('../../verbs/composite.js');
    const scanned = new Set(
      collectDispatchRoutes()
        .filter((r) => r.tool === 'exarchos_orchestrate')
        .map((r) => r.action),
    );
    expect(ACTION_HANDLER_KEYS.length).toBeGreaterThan(0);
    for (const key of ACTION_HANDLER_KEYS) {
      expect(scanned.has(key), `runtime handler key '${key}' was not scanned`).toBe(true);
    }
    // The COMPUTED dispatch key (`[MUTATION_GATE_NAME]`) is the regression
    // target: a naive key scan drops it silently.
    expect(scanned.has('mutation-adequacy')).toBe(true);
  });

  it('records which routing construct produced each route', () => {
    const routes = collectDispatchRoutes();
    const forms = new Set(routes.map((r) => r.form));
    expect(forms.has('switch-case')).toBe(true);
    expect(forms.has('handler-table')).toBe(true);
    expect(forms.has('equality-branch')).toBe(true);
    // `typeof action === 'string'` is a type guard, never a route.
    expect(routes.some((r) => r.action === 'string')).toBe(false);
  });
});

describe('the scanner reads code, not prose — comments and strings are inert', () => {
  const mask = (s: string): ReturnType<typeof maskCommentsAndStrings> => maskCommentsAndStrings(s);

  it('ignores a case label that appears in a comment or a string literal', () => {
    const src = [
      "// case 'commented_out':",
      "/* case 'blocked_out': */",
      "const doc = \"case 'in_a_string':\";",
      'switch (action) {',
      "  case 'real_one':",
      '    return 1;',
      "  case 'real_two': {",
      '    return 2;',
      '  }',
      '}',
    ].join('\n');
    expect([...extractSwitchCaseActions(src, mask(src))]).toEqual(['real_one', 'real_two']);
  });

  it('ignores case labels of a switch that is not switching on `action`', () => {
    const src = "switch (phase) {\n  case 'design':\n    return 1;\n}\n";
    expect([...extractSwitchCaseActions(src, mask(src))]).toEqual([]);
  });

  it('reads equality branch arms but not the `typeof action` type guard', () => {
    const src = [
      "if (typeof action === 'string') { /* guard */ }",
      "if (action === 'onboard') return onboard();",
      "if (args.action === 'not_a_route') return null;",
    ].join('\n');
    expect([...extractEqualityBranchActions(src, mask(src))]).toEqual(['onboard']);
  });

  it('reads quoted, bare and computed handler-table keys and skips nested values', () => {
    const file = `${SOURCE_ROOT}/verbs/composite.ts`;
    const src = [
      'const T: Readonly<Record<string, ActionHandler>> = {',
      '  bare_key: adapt(handleBare),',
      "  'quoted-key': adapt(handleQuoted, { nested_not_a_key: 1 }),",
      '  [MUTATION_GATE_NAME]: adapt(handleComputed),',
      '};',
    ].join('\n');
    expect([...extractHandlerTableActions(src, mask(src), file)]).toEqual([
      'bare_key',
      'quoted-key',
      'mutation-adequacy',
    ]);
  });

  it('ignores a Record whose value type is not a handler', () => {
    const src = 'const T: Readonly<Record<string, string>> = {\n  not_a_route: "x",\n};';
    expect([...extractHandlerTableActions(src, mask(src), 'unused')]).toEqual([]);
  });

  it('matchingBrace throws on an unterminated block', () => {
    const src = 'switch (action) {\n';
    expect(() => matchingBrace(src, src.indexOf('{'), mask(src))).toThrow(DispatchRouteScanError);
  });
});

describe('the scanner FAILS LOUD rather than under-reporting', () => {
  it('throws when a composite router module is missing', () => {
    expect(() => readRouterRoutes({ tool: 'exarchos_ghost', file: `${SOURCE_ROOT}/ghost/composite.ts` })).toThrow(
      /not found/,
    );
  });

  it('throws when a router carries no recognizable routing construct', () => {
    expect(() => readRouterRoutes({ tool: 'exarchos_workflow', file: `${SOURCE_ROOT}/registry.ts` })).toThrow(
      /no recognizable routing construct/,
    );
  });

  it('throws when a computed dispatch key cannot be resolved to a literal', () => {
    const file = `${SOURCE_ROOT}/verbs/composite.ts`;
    const src = 'const T: Readonly<Record<string, ActionHandler>> = {\n  [NOT_IMPORTED_ANYWHERE]: adapt(h),\n};';
    expect(() => extractHandlerTableActions(src, maskCommentsAndStrings(src), file)).toThrow(
      /has no matching import/,
    );
  });
});
