/**
 * Three-path CLI parity for the four lifecycle verbs that `cli.topLevel` promotes to top-level
 * commands:
 *
 *   ps      → `exarchos ps`        (same as `exarchos vw ps`)
 *   wait    → `exarchos wait`      (same as `exarchos vw wait`)
 *   export  → `exarchos export`    (same as `exarchos vw export`)
 *   inspect → `exarchos describe`  (same as `exarchos vw inspect`)
 *
 * `inspect` maps to `describe` on purpose. The schema `describe` is a per-tool action subcommand,
 * never a top-level command, so the names do not collide.
 *
 * Each verb returns a byte-identical ToolResult through the MCP tool call, the `vw <verb>`
 * subcommand and the top-level command. The exit-code map gives 17 for WAIT_TIMEOUT, 18 for
 * WAIT_FAILED and 0 for success. The visible composite tool count stays 4.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CommanderError } from 'commander';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { TOOL_REGISTRY, type ToolAction } from '../../../../src/registry.js';
import {
  buildCli,
  applyExitOverrideRecursively,
  resolveExitCode,
  ERROR_CODE_EXIT_CODES,
  CLI_EXIT_CODES,
} from '../../../../src/adapters/cli/cli.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../../../tests/unit/parity-harness.js';
import { createMcpDispatchContext } from '../../../../src/adapters/mcp/mcp.js';
import { buildDefaultProcessResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../test-helpers/temp-dir.js';

import { handleViewPs } from '../../../../src/projections/views/lifecycle/ps.js';
import { handleViewWait, type WaitDeps } from '../../../../src/projections/views/lifecycle/wait.js';
import { handleViewInspect } from '../../../../src/projections/views/lifecycle/inspect.js';
import { handleViewExport } from '../../../../src/projections/views/lifecycle/export.js';

/** Fixed monotone clock so the `wait` deadline arithmetic is byte-stable. */
const VIEW_DEPS: WaitDeps = { now: () => 1_000 };

/**
 * A promoted verb, its fixture flags and the top-level name that the promotion must stamp. The
 * suite reads the actual `cli.topLevel` stamp from the registry and asserts that it equals
 * `topLevelExpected`. So a dropped or wrong stamp fails, and no path is skipped.
 */
interface VerbSpec {
  readonly action: string;
  readonly topLevelExpected: string;
  readonly flags: Record<string, unknown>;
}

/**
 * The fixtures have no side effects and are byte-deterministic. `ps` reads an empty store, and
 * `wait` with `until: 'idle'` resolves at once on it. `inspect` and `export` probe an unknown
 * featureId, which gives `workflowExists: false`, zero events and no file write.
 */
const VERBS: readonly VerbSpec[] = [
  { action: 'ps', topLevelExpected: 'ps', flags: {} },
  { action: 'wait', topLevelExpected: 'wait', flags: { until: 'idle', timeoutMs: 1_000 } },
  { action: 'inspect', topLevelExpected: 'describe', flags: { featureId: 'nonexistent-parity-feature' } },
  { action: 'export', topLevelExpected: 'export', flags: { featureId: 'nonexistent-parity-feature' } },
];

/**
 * Routes each promoted verb to its lifecycle handler with the fixed deps, so the three carriers
 * give identical output.
 */
const viewStub: CompositeHandler = async (args, ctx): Promise<ToolResult> => {
  const { action, ...rest } = args;
  switch (action) {
    case 'ps':
      return handleViewPs(rest, ctx, VIEW_DEPS);
    case 'wait':
      return handleViewWait(rest, ctx, VIEW_DEPS);
    case 'inspect':
      return handleViewInspect(rest, ctx);
    case 'export':
      return handleViewExport(rest, ctx);
    default:
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `lifecycle-verbs parity stub: unexpected view action "${String(action)}"`,
        },
      };
  }
};

/**
 * The shared context of the three carriers, provisioned as the real process entrypoint does.
 *
 * The `capabilityResolver` matters. Admission checks the `needs` of an action against the caller
 * subject. Without a resolver, the MCP arm is an anonymous caller, and `export` (which needs
 * `fs:read` and `fs:write`) is denied. `buildCli` stamps its own local-operator identity, so the
 * denial reads as a carrier divergence. The resolver keeps the subject equal across the arms.
 */
async function createContext(prefix: string): Promise<{ stateDir: string; ctx: DispatchContext }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return {
    stateDir,
    ctx: {
      stateDir,
      eventStore,
      enableTelemetry: false,
      capabilityResolver: buildDefaultProcessResolver(),
    },
  };
}

/**
 * The context of the MCP arm, with the session identity that the MCP adapter stamps. The CLI arm
 * gets its local-operator identity from `buildCli`. Without this mirror, the two arms differ in
 * caller identity for a reason that the carrier does not control.
 */
function mcpContext(ctx: DispatchContext): DispatchContext {
  return createMcpDispatchContext(ctx, {
    sessionId: 'lifecycle-parity-session',
    clientInfo: { name: 'lifecycle-parity', version: '0.0.0' },
  });
}

/**
 * Removes wall-clock, telemetry and temp-path fields, so two carriers are byte-equal.
 *
 * `_meta` stays in the comparison, because it carries `_meta.workflowExists` and economy stamps
 * that the carriers must agree on. Only the per-dispatch UUIDs in `uuidKeys` are neutralized, and
 * only the telemetry `_perf` block is dropped.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    tmpPathPlaceholder: '<TMP>',
    uuidKeys: new Set(['operationId', 'correlationId', 'causationId']),
    dropKeys: new Set(['_perf']),
  });
}

/** The lifecycle-verb action descriptor from `exarchos_view`. */
function viewAction(name: string): ToolAction {
  const view = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view');
  const action = view?.actions.find((a) => a.name === name);
  if (!action) throw new Error(`test setup: exarchos_view has no '${name}' action`);
  return action;
}

/**
 * Calls the promoted top-level command `exarchos <verb> ...flags --json`, with no tool alias or
 * action prefix. It captures stdout, parses JSON from the first `{` and reads the exit code, as
 * the shared harness `callCli` does. `callCli` speaks only the `<alias> <action>` shape.
 */
async function callTopLevel(
  ctx: DispatchContext,
  topLevelName: string,
  flags: Record<string, unknown>,
): Promise<{ result: unknown; exitCode: number }> {
  const program = buildCli(ctx);
  applyExitOverrideRecursively(program);

  const capturedStdout: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    capturedStdout.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  const savedExitCode = process.exitCode;
  process.exitCode = undefined;

  const argv: string[] = ['node', 'exarchos', topLevelName];
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined) continue;
    const kebab = key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    if (typeof value === 'boolean') {
      argv.push(value ? `--${kebab}` : `--no-${kebab}`);
    } else if (typeof value === 'object' && value !== null) {
      argv.push(`--${kebab}`, JSON.stringify(value));
    } else {
      argv.push(`--${kebab}`, String(value));
    }
  }
  argv.push('--json');

  try {
    await program.parseAsync(argv);
  } catch (err) {
    process.exitCode = savedExitCode;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (err instanceof CommanderError) {
      throw new Error(`top-level '${topLevelName}' raised CommanderError: ${err.message}`);
    }
    throw err;
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = savedExitCode;

  const stdoutText = capturedStdout.join('').trim();
  const firstBrace = stdoutText.indexOf('{');
  if (firstBrace < 0) {
    throw new Error(`top-level '${topLevelName}' produced non-JSON stdout: ${stdoutText}`);
  }
  return { result: JSON.parse(stdoutText.slice(firstBrace)), exitCode };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = path.join(HERE, '../../../../src/registry');

/**
 * The registry modules, concatenated. The action lists are split per family, so a check pinned to
 * one file stops seeing the bindings that it asserts.
 */
function readRegistrySources(dir = REGISTRY_DIR): string {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) return readRegistrySources(abs);
      return e.name.endsWith('.ts') ? readFileSync(abs, 'utf8') : '';
    })
    .join('\n');
}

const REGISTRY_SRC = readRegistrySources();

/**
 * Proves that the parity is not accidental. The four verbs bind their shared fields from one
 * source, `projections/views/lifecycle/schema-fields.ts`. So a shared field keeps one base type in
 * the flattened `exarchos_view` registration.
 *
 * The corpus length is asserted first, so an unread corpus fails. The import is matched on its
 * trailing segment, because the `../` depth varies by module. Each verb must bind at least one
 * shared field.
 */
function assertSharedSchemaFieldsSoT(): void {
  expect(REGISTRY_SRC.length, 'the registry source corpus is empty').toBeGreaterThan(10_000);

  expect(
    REGISTRY_SRC.includes(`projections/views/lifecycle/schema-fields.js'`),
    'the registry must import the shared lifecycle schema-fields SoT',
  ).toBe(true);

  const bindings: Readonly<Record<string, string>> = {
    ps: 'scope: lifecycleScopeField',
    inspect: 'follow: followField',
    wait: 'operation: lifecycleOperationField',
    export: 'output: lifecycleOutputField',
  };
  for (const [verb, needle] of Object.entries(bindings)) {
    expect(
      REGISTRY_SRC.includes(needle),
      `${verb} (task-0${verb === 'ps' ? '07' : verb === 'inspect' ? '08' : verb === 'wait' ? '10' : '13'}) must bind the shared schema-fields SoT via \`${needle}\``,
    ).toBe(true);
  }
}

describe('lifecycle-verb three-path CLI parity (DR-7 / DR-8, task-015)', () => {
  let cleanups: string[] = [];
  let restores: Array<() => void> = [];

  afterEach(async () => {
    for (const r of restores) r();
    restores = [];
    for (const dir of cleanups) await rmrfAsync(dir);
    cleanups = [];
    vi.restoreAllMocks();
  });

  /**
   * The shared-field check runs first. For each verb, the suite reads the actual `cli.topLevel`
   * stamp from the registry. The three carriers share one empty-store context, and the fixed clock
   * removes the only wall-clock variance, `wait.waitedMs`. The three results must be deep-equal and
   * byte-equal, and both CLI carriers must exit 0.
   */
  it('Parity_EachPromotedVerb_ByteIdenticalToolResultAcrossThreePaths', async () => {
    assertSharedSchemaFieldsSoT();

    restores.push(stubCompositeHandler('exarchos_view', viewStub));

    for (const { action, topLevelExpected, flags } of VERBS) {
      const actual = viewAction(action).cli?.topLevel;
      expect(actual, `${action} must carry a cli.topLevel stamp`).toBe(topLevelExpected);

      const { stateDir, ctx } = await createContext(`lifecycle-parity-${action}-`);
      cleanups.push(stateDir);

      const mcp = await harnessCallMcp(mcpContext(ctx), 'exarchos_view', { action, ...flags });
      const { result: sub, exitCode: subExit } = await harnessCallCli(ctx, 'vw', action, flags);
      const { result: top, exitCode: topExit } = await callTopLevel(ctx, topLevelExpected, flags);

      const nMcp = normalize(mcp);
      const nSub = normalize(sub);
      const nTop = normalize(top);

      expect(nSub, `${action}: subcommand ≡ MCP`).toEqual(nMcp);
      expect(nTop, `${action}: top-level ≡ MCP`).toEqual(nMcp);
      expect(JSON.stringify(nTop), `${action}: top-level byte-equal MCP`).toEqual(
        JSON.stringify(nMcp),
      );
      expect(JSON.stringify(nSub), `${action}: subcommand byte-equal top-level`).toEqual(
        JSON.stringify(nTop),
      );

      expect(subExit, `${action}: subcommand exit`).toBe(0);
      expect(topExit, `${action}: top-level exit`).toBe(0);
    }
  });

  it('ExitCodeMap_WaitTimeout_17', () => {
    const result: ToolResult = { success: false, error: { code: 'WAIT_TIMEOUT', message: 'expired' } };
    expect(resolveExitCode(result)).toBe(17);
    expect(ERROR_CODE_EXIT_CODES.WAIT_TIMEOUT).toBe(17);
  });

  it('ExitCodeMap_WaitFailed_18', () => {
    const result: ToolResult = { success: false, error: { code: 'WAIT_FAILED', message: 'terminal reached' } };
    expect(resolveExitCode(result)).toBe(18);
    expect(ERROR_CODE_EXIT_CODES.WAIT_FAILED).toBe(18);
  });

  /**
   * The wait exit codes are above the generic 0 to 3 band, so they never alias a generic code. A
   * code that is not in the map keeps its generic mapping.
   */
  it('ExitCodeMap_Success_0', () => {
    const result: ToolResult = { success: true, data: { ok: true } };
    expect(resolveExitCode(result)).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(resolveExitCode(result)).toBe(0);
    expect(ERROR_CODE_EXIT_CODES.WAIT_TIMEOUT).toBeGreaterThan(3);
    expect(ERROR_CODE_EXIT_CODES.WAIT_FAILED).toBeGreaterThan(3);
    expect(resolveExitCode({ success: false, error: { code: 'INVALID_INPUT', message: 'x' } })).toBe(
      CLI_EXIT_CODES.INVALID_INPUT,
    );
    expect(resolveExitCode({ success: false, error: { code: 'SOME_OTHER', message: 'x' } })).toBe(
      CLI_EXIT_CODES.HANDLER_ERROR,
    );
  });

  /**
   * The promotion is a `cli.topLevel` stamp on `exarchos_view` actions, so it adds no visible
   * composite tool. `exarchos_sync` is the only hidden composite. This case extends the
   * `Registry_VisibleToolCount_UnchangedByPhaseKind` fence in `registry.test.ts`.
   */
  it('Registry_VisibleCompositeCount_RemainsFour', () => {
    const visible = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visible.length).toBe(4);
    expect(visible.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    expect(TOOL_REGISTRY).toHaveLength(5);

    for (const { action, topLevelExpected } of VERBS) {
      expect(viewAction(action).cli?.topLevel).toBe(topLevelExpected);
    }
  });
});
