/**
 * Compares the action sets that the CLI and the MCP server build from `getFullRegistry()`.
 *
 * The tests run the real builders, `buildCli` and `createMcpServer`.
 * The CLI builds a subcommand for each action of each tool.
 * The MCP server registers each tool that is not `hidden`, so only the CLI reaches a hidden tool.
 * An action that one surface builds and the other surface does not build is drift.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getFullRegistry } from '../../src/registry.js';
import { buildCli } from '../../src/adapters/cli/cli.js';
import { EventStore } from '../../src/events/store.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';

vi.mock('../../src/workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/workflow/state-store.js')>();
  return {
    ...original,
    configureStateStoreBackend: vi.fn(),
  };
});

/**
 * A minimal context for `buildCli`, which reads only the structure of the registry.
 * Only a dispatched handler reads `eventStore`, so an empty object is sufficient.
 */
function cliContext(): DispatchContext {
  return {
    stateDir: '/tmp/registration-parity',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

/** Returns the string members of a `z.enum` field. It reads `options` first, then `_def.entries`. */
function enumValues(field: z.ZodType | undefined): string[] {
  if (!field) return [];
  const opts = (field as unknown as { options?: unknown }).options;
  if (Array.isArray(opts)) return opts as string[];
  const entries = (field as unknown as { _def?: { entries?: Record<string, string> } })._def
    ?.entries;
  return entries ? Object.values(entries) : [];
}

/** Returns the action names in the `Actions: a, b, c` line of a `slimDescription`. */
function advertisedActions(slim: string | undefined): string[] {
  if (!slim) return [];
  const m = slim.match(/Actions:\s*([^\n]+)/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const registry = getFullRegistry();

/** Maps each tool name to its action names in the registry. */
const registryActions = new Map<string, Set<string>>(
  registry.map((t) => [t.name, new Set(t.actions.map((a) => a.name))]),
);

/** Maps each top-level CLI command name, such as `wf`, to its registry tool name. */
const cliToolNameToRegistry = new Map<string, string>(
  registry.map((t) => [t.cli?.alias ?? t.name.replace(/^exarchos_/, ''), t.name]),
);

/**
 * Maps each tool name to a map from CLI subcommand name to action name.
 * The subcommand name is the `cli.alias` of the action when the action has one.
 */
const cliSubToActionName = new Map<string, Map<string, string>>(
  registry.map((t) => [
    t.name,
    new Map(t.actions.map((a) => [a.cli?.alias ?? a.name, a.name])),
  ]),
);

/**
 * Builds the real Commander tree and returns the action names of each tool.
 * It skips each top-level command that is not a registry tool.
 */
function enumerateCliActions(): Map<string, Set<string>> {
  const program = buildCli(cliContext());
  const out = new Map<string, Set<string>>();
  for (const toolCmd of program.commands) {
    const toolName = cliToolNameToRegistry.get(toolCmd.name());
    if (!toolName) continue;
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

/**
 * Runs `createMcpServer` and returns the `action` enum of each registered `exarchos_` tool.
 * `createMcpServer` skips a hidden tool, so the result has no entry for it.
 * The spy on `registerTool` needs the class that production constructs, which is `V2_MCP_SERVER_CLASS`.
 */
async function enumerateMcpRegisteredActions(): Promise<Map<string, Set<string>>> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registration-parity-'));
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir: tmpDir, eventStore, enableTelemetry: false };

  const { V2_MCP_SERVER_CLASS } = await import('../../src/contract/sdk/seam.js');
  const spy = vi.spyOn(V2_MCP_SERVER_CLASS.prototype, 'registerTool');
  const out = new Map<string, Set<string>>();
  try {
    const { createMcpServer } = await import('../../src/adapters/mcp/mcp.js');
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

  /**
   * The CLI must build each registry action of each tool, hidden tools included.
   * The MCP server must register the same actions for a visible tool, and no hidden tool.
   * Thus the only actions that the CLI builds and MCP does not register belong to the hidden tools.
   */
  it('registration_PluginVsCliActionList_NoDrift', () => {
    const hiddenToolNames = registry.filter((t) => t.hidden).map((t) => t.name);

    for (const tool of registry) {
      const canonical = registryActions.get(tool.name)!;
      const cliSet = cliActions.get(tool.name) ?? new Set<string>();

      expect(sorted(cliSet), `CLI action set for ${tool.name}`).toEqual(sorted(canonical));

      const mcpSet = mcpActions.get(tool.name) ?? new Set<string>();
      if (tool.hidden) {
        expect(mcpSet.size, `${tool.name} is hidden and must not be MCP-registered`).toBe(0);
      } else {
        expect(sorted(mcpSet), `MCP action set for ${tool.name}`).toEqual(sorted(canonical));
      }
    }

    for (const [toolName, mcpSet] of mcpActions) {
      const cliSet = cliActions.get(toolName) ?? new Set<string>();
      for (const action of mcpSet) {
        expect(cliSet.has(action), `MCP action ${toolName}.${action} absent from CLI`).toBe(true);
      }
    }

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

  /** `deliveryPath` is a parameter of `rehydrate`, so the CLI must build a `--delivery-path` flag for it. */
  it('registration_B6FlaggedActions_ExistInBothSurfaces', () => {
    expect(cliActions.get('exarchos_workflow')?.has('rehydrate')).toBe(true);
    expect(mcpActions.get('exarchos_workflow')?.has('rehydrate')).toBe(true);

    for (const action of ['worktrees', 'ps', 'invariants_effective']) {
      expect(cliActions.get('exarchos_view')?.has(action), `CLI missing view.${action}`).toBe(true);
      expect(mcpActions.get('exarchos_view')?.has(action), `MCP missing view.${action}`).toBe(true);
    }

    const program = buildCli(cliContext());
    const wf = program.commands.find((c) => c.name() === 'wf');
    const rehydrate = wf?.commands.find((c) => c.name() === 'rehydrate');
    const flagLongs = rehydrate?.options.map((o) => o.long) ?? [];
    expect(flagLongs).toContain('--delivery-path');
  });

  /**
   * Each action that the `Actions:` line of a `slimDescription` names must be a registry action.
   * The reverse is not a requirement, because that line can be a subset of the actions.
   */
  it('advertisedActions_AllDispatchable_NoPhantom', () => {
    for (const tool of registry) {
      const advertised = advertisedActions(tool.slimDescription);
      const built = registryActions.get(tool.name)!;
      const phantom = advertised.filter((a) => !built.has(a));
      expect(phantom, `${tool.name} advertises actions that are not built`).toEqual([]);
    }
  });
});
