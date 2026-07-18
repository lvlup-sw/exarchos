import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getFullRegistry } from './registry.js';
import { buildCli } from './adapters/cli.js';
import { EventStore } from './event-store/store.js';
import { rmrfAsync } from './test-helpers/temp-dir.js';
import type { DispatchContext } from './core/dispatch.js';

// ─── B-6 (DR-11): plugin-registration ↔ CLI action parity ────────────────────
//
// Both facades derive their action set from `getFullRegistry()` — the MCP
// adapter registers one tool per NON-hidden composite tool (its `action`
// discriminator enum), while the CLI builder emits one subcommand per action
// of EVERY tool. The single documented asymmetry is `CompositeTool.hidden`:
// hidden tools (today only `exarchos_sync`) are CLI-reachable for operators /
// scripts but excluded from MCP `tools/list` so they don't consume model
// context (mcp.ts:`if (tool.hidden) continue;`, triaged as intentional in
// bug #1218).
//
// These tests drive the REAL builders (`buildCli` + `createMcpServer`) and pin
// the two surfaces against each other so any future drift — an action
// advertised/registered by one facade but not built into the other — fails
// CI. They also codify the B-6 audit finding: `rehydrate`/`deliveryPath`,
// `worktrees`/`ps`/`invariants_effective` now exist in the CLI build.

// The mcp adapter configures the state-store backend at server construction;
// stub it so `createMcpServer` stays a pure registration probe (mirrors
// mcp.test.ts).
vi.mock('./workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./workflow/state-store.js')>();
  return {
    ...original,
    configureStateStoreBackend: vi.fn(),
  };
});

/** Minimal context for `buildCli` — it reads registry STRUCTURE at build time; the
 * eventStore is only dereferenced by per-action handlers at dispatch time. */
function cliContext(): DispatchContext {
  return {
    stateDir: '/tmp/registration-parity',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

/** Extract the string members of a `z.enum([...])` field across Zod-v4 shapes. */
function enumValues(field: z.ZodType | undefined): string[] {
  if (!field) return [];
  const opts = (field as unknown as { options?: unknown }).options;
  if (Array.isArray(opts)) return opts as string[];
  const entries = (field as unknown as { _def?: { entries?: Record<string, string> } })._def
    ?.entries;
  return entries ? Object.values(entries) : [];
}

/** Parse the "Actions: a, b, c" advertisement out of a tool's slimDescription. */
function advertisedActions(slim: string | undefined): string[] {
  if (!slim) return [];
  const m = slim.match(/Actions:\s*([^\n]+)/);
  if (!m) return [];
  return m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const registry = getFullRegistry();

/** toolName → canonical Set(action.name) straight from the registry. */
const registryActions = new Map<string, Set<string>>(
  registry.map((t) => [t.name, new Set(t.actions.map((a) => a.name))]),
);

/** CLI top-level command name (e.g. `wf`) → registry tool name (`exarchos_workflow`). */
const cliToolNameToRegistry = new Map<string, string>(
  registry.map((t) => [t.cli?.alias ?? t.name.replace(/^exarchos_/, ''), t.name]),
);

/** toolName → (CLI subcommand name → canonical action.name). Accounts for
 * action-level `cli.alias` (e.g. `get`→`status`, `pipeline`→`ls`). */
const cliSubToActionName = new Map<string, Map<string, string>>(
  registry.map((t) => [
    t.name,
    new Map(t.actions.map((a) => [a.cli?.alias ?? a.name, a.name])),
  ]),
);

/** Drive the real Commander tree and reduce it to toolName → Set(action.name). */
function enumerateCliActions(): Map<string, Set<string>> {
  const program = buildCli(cliContext());
  const out = new Map<string, Set<string>>();
  for (const toolCmd of program.commands) {
    const toolName = cliToolNameToRegistry.get(toolCmd.name());
    if (!toolName) continue; // top-level convenience commands (schema, mcp, doctor, …)
    const subMap = cliSubToActionName.get(toolName)!;
    const set = new Set<string>();
    for (const sub of toolCmd.commands) {
      const actionName = subMap.get(sub.name());
      if (actionName) set.add(actionName);
    }
    out.set(toolName, set);
  }
  return out;
}

/** Drive the real MCP registration path and capture each registered tool's
 * `action` discriminator enum → toolName → Set(action.name). Hidden tools are
 * skipped by `createMcpServer`, so they never appear here. */
async function enumerateMcpRegisteredActions(): Promise<Map<string, Set<string>>> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registration-parity-'));
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir: tmpDir, eventStore, enableTelemetry: false };

  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const spy = vi.spyOn(McpServer.prototype, 'registerTool');
  const out = new Map<string, Set<string>>();
  try {
    const { createMcpServer } = await import('./adapters/mcp.js');
    createMcpServer(ctx);
    for (const call of spy.mock.calls) {
      const toolName = call[0] as string;
      if (!toolName.startsWith('exarchos_')) continue;
      const cfg = call[1] as { inputSchema?: z.ZodObject<z.ZodRawShape> };
      const actionField = cfg.inputSchema?.shape?.action as z.ZodType | undefined;
      out.set(toolName, new Set(enumValues(actionField)));
    }
  } finally {
    spy.mockRestore();
    await eventStore.close?.();
    await rmrfAsync(tmpDir);
  }
  return out;
}

const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe('plugin-registration ↔ CLI action parity (B-6, DR-11)', () => {
  let cliActions: Map<string, Set<string>>;
  let mcpActions: Map<string, Set<string>>;

  beforeEach(async () => {
    cliActions = enumerateCliActions();
    mcpActions = await enumerateMcpRegisteredActions();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registration_PluginVsCliActionList_NoDrift', () => {
    const hiddenToolNames = registry.filter((t) => t.hidden).map((t) => t.name);

    for (const tool of registry) {
      const canonical = registryActions.get(tool.name)!;
      const cliSet = cliActions.get(tool.name) ?? new Set<string>();

      // The CLI builds a subcommand for every action of every tool — hidden
      // tools included (operator/script reachability).
      expect(sorted(cliSet), `CLI action set for ${tool.name}`).toEqual(sorted(canonical));

      const mcpSet = mcpActions.get(tool.name) ?? new Set<string>();
      if (tool.hidden) {
        // Documented exception: hidden tools are NEVER MCP-registered.
        expect(mcpSet.size, `${tool.name} is hidden and must not be MCP-registered`).toBe(0);
      } else {
        // Visible tools: plugin registration and CLI expose the identical
        // action set — no drift in either direction.
        expect(sorted(mcpSet), `MCP action set for ${tool.name}`).toEqual(sorted(canonical));
      }
    }

    // No plugin-registered action is missing from the CLI surface.
    for (const [toolName, mcpSet] of mcpActions) {
      const cliSet = cliActions.get(toolName) ?? new Set<string>();
      for (const action of mcpSet) {
        expect(cliSet.has(action), `MCP action ${toolName}.${action} absent from CLI`).toBe(true);
      }
    }

    // The ONLY CLI-exclusive actions belong to hidden tools (the documented
    // intentional exception) — a CLI-only action on a VISIBLE tool is drift.
    const cliOnly: string[] = [];
    for (const [toolName, cliSet] of cliActions) {
      const mcpSet = mcpActions.get(toolName) ?? new Set<string>();
      for (const action of cliSet) {
        if (!mcpSet.has(action)) cliOnly.push(`${toolName}.${action}`);
      }
    }
    const expectedCliOnly = hiddenToolNames.flatMap((name) =>
      [...registryActions.get(name)!].map((a) => `${name}.${a}`),
    );
    expect(cliOnly.sort()).toEqual(expectedCliOnly.sort());
  });

  it('registration_B6FlaggedActions_ExistInBothSurfaces', () => {
    // rehydrate — exarchos_workflow (visible on both facades)
    expect(cliActions.get('exarchos_workflow')?.has('rehydrate')).toBe(true);
    expect(mcpActions.get('exarchos_workflow')?.has('rehydrate')).toBe(true);

    // worktrees / ps / invariants_effective — exarchos_view (visible on both)
    for (const action of ['worktrees', 'ps', 'invariants_effective']) {
      expect(cliActions.get('exarchos_view')?.has(action), `CLI missing view.${action}`).toBe(true);
      expect(mcpActions.get('exarchos_view')?.has(action), `MCP missing view.${action}`).toBe(true);
    }

    // deliveryPath — a `rehydrate` param — surfaces as a CLI flag in the build.
    const program = buildCli(cliContext());
    const wf = program.commands.find((c) => c.name() === 'wf');
    const rehydrate = wf?.commands.find((c) => c.name() === 'rehydrate');
    const flagLongs = rehydrate?.options.map((o) => o.long) ?? [];
    expect(flagLongs).toContain('--delivery-path');
  });

  it('advertisedActions_AllDispatchable_NoPhantom', () => {
    // Every action named in a tool's slimDescription "Actions:" advertisement
    // MUST correspond to a real, dispatchable action. The reverse is NOT
    // required — the advertisement is a deliberately curated, token-economy
    // subset that points at describe(actions) for the full list. This guard
    // is the direct B-6 "advertised but not built" tripwire.
    for (const tool of registry) {
      const advertised = advertisedActions(tool.slimDescription);
      const built = registryActions.get(tool.name)!;
      const phantom = advertised.filter((a) => !built.has(a));
      expect(phantom, `${tool.name} advertises actions that are not built`).toEqual([]);
    }
  });
});
