// ─── Lifecycle-verb three-path CLI parity (DR-7 / DR-8, task-015) ────────────
//
// Task-014 shipped the generic top-level-promotion MECHANISM (`cli.topLevel` +
// the `adapters/cli.ts` hoist loop + its build-time collision guard). Task-015
// STAMPS the four lifecycle reads/writes onto it and proves the promotion is
// carrier-transparent:
//
//   ps      → `exarchos ps`        (== `exarchos vw ps`)
//   wait    → `exarchos wait`      (== `exarchos vw wait`)
//   export  → `exarchos export`    (== `exarchos vw export`)
//   inspect → `exarchos describe`  (== `exarchos vw inspect`)  ← name re-map
//
// The `inspect → describe` re-map is deliberate: `describe` is the natural
// top-level verb for "project one workflow", and it does NOT collide with the
// schema-introspection `describe`, which is a per-tool ACTION subcommand
// (`vw describe`, `wf describe`), NEVER a top-level command. The task-014 hoist
// guard re-checks the whole top-level namespace at build time; the parity test
// below exercises that the four promotions register without a collision throw.
//
// Three assertions ride here:
//   1. THREE-PATH PARITY — each promoted verb returns a BYTE-IDENTICAL
//      ToolResult across the MCP tool-call, the `vw <verb>` subcommand, and the
//      top-level `<verb>` command. All three route through the ONE stubbed
//      `exarchos_view` composite handler (fixed clock injected for `wait`'s
//      `waitedMs`), so a divergence can only come from carrier-specific arg
//      parsing or exit/emit handling — exactly what DR-7 must not introduce.
//   2. EXIT-CODE MAP (DR-7) — the generic `errorCode→exitCode` table:
//      WAIT_TIMEOUT→17, WAIT_FAILED→18, success→0.
//   3. VISIBLE COMPOSITE COUNT — promotion adds top-level CLI VERBS, never new
//      composite TOOLS; the visible count stays 4 (INV-5d). Cites the existing
//      `registry.test.ts` fence `Registry_VisibleToolCount_UnchangedByPhaseKind`.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CommanderError } from 'commander';

import { EventStore } from '../events/store.js';
import type { DispatchContext, CompositeHandler } from '../core/dispatch.js';
import { stubCompositeHandler } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import { TOOL_REGISTRY, type ToolAction } from '../registry.js';
import {
  buildCli,
  applyExitOverrideRecursively,
  resolveExitCode,
  ERROR_CODE_EXIT_CODES,
  CLI_EXIT_CODES,
} from '../adapters/cli.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../__tests__/parity-harness.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

import { handleViewPs } from '../projections/views/lifecycle/ps.js';
import { handleViewWait, type WaitDeps } from '../projections/views/lifecycle/wait.js';
import { handleViewInspect } from '../projections/views/lifecycle/inspect.js';
import { handleViewExport } from '../projections/views/lifecycle/export.js';

// ─── Deterministic injected deps (fixed clock → wait `waitedMs` folds to 0) ──

/** Fixed monotone clock so the `wait` deadline arithmetic is byte-stable. */
const VIEW_DEPS: WaitDeps = { now: () => 1_000 };

// ─── The four promoted verbs, their fixtures, and their expected top-level names ─
//
// `topLevelExpected` is what the promotion MUST stamp; the test reads the ACTUAL
// stamp from the registry (registry-driven) and asserts it equals this, so a
// dropped or mis-typed `cli.topLevel` fails here rather than silently skipping a
// path. Fixtures are chosen to be side-effect-free and byte-deterministic:
//   - ps `{}`             — pure read of an empty store (no probe, no age).
//   - wait until:'idle'   — resolves immediately on an empty store; fixed clock.
//   - inspect/export cold — an unknown featureId → workflowExists:false, ZERO
//     events, no file write (the CB-2 no-phantom-stream guarantee).
interface VerbSpec {
  readonly action: string;
  readonly topLevelExpected: string;
  readonly flags: Record<string, unknown>;
}

const VERBS: readonly VerbSpec[] = [
  { action: 'ps', topLevelExpected: 'ps', flags: {} },
  { action: 'wait', topLevelExpected: 'wait', flags: { until: 'idle', timeoutMs: 1_000 } },
  { action: 'inspect', topLevelExpected: 'describe', flags: { featureId: 'nonexistent-parity-feature' } },
  { action: 'export', topLevelExpected: 'export', flags: { featureId: 'nonexistent-parity-feature' } },
];

// ─── Stub: route every promoted verb through the lifecycle handler with the ──
// injected deterministic deps, so all three carriers fold identical output.
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

// ─── Arm + normalization helpers ─────────────────────────────────────────────

async function createContext(prefix: string): Promise<{ stateDir: string; ctx: DispatchContext }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, ctx: { stateDir, eventStore, enableTelemetry: false } };
}

/**
 * Strip wall-clock / telemetry / tmp-path fields so two carriers are byte-equal.
 *
 * `_meta` is deliberately KEPT in the comparison: it carries the handler-stamped
 * `_meta.workflowExists` (the CB-2 cold-probe guarantee) and any economy stamps,
 * which are exactly the kind of carrier-visible payload this parity suite must
 * prove identical across the three paths. Only the genuinely nondeterministic
 * dispatch-correlation members (`operationId` / `correlationId` / `causationId`
 * — freshly minted UUIDs per dispatch) are neutralized via `uuidKeys`, and only
 * the telemetry-derived `_perf` block is dropped (mirrors the finer-grained
 * sibling `readonly-cap-parity.test.ts`).
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

// ─── Top-level `exarchos <verb>` caller ──────────────────────────────────────
//
// Mirrors the shared harness `callCli` (same stdout capture + first-`{` JSON
// slice + exit-code read-back) but drives the ROOT-LEVEL promoted command —
// `['node','exarchos', <verb>, ...flags, '--json']` — with NO tool-alias/action
// prefix. That is the third invocation path DR-7 introduces; the harness's
// `callCli` only speaks the `<alias> <action>` subcommand shape.
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

// ─── DR-8 shared-field SoT grep-assert (setup) ───────────────────────────────
//
// Proves the parity below is not accidental: all four verbs (007 ps / 008
// inspect / 010 wait / 013 export) bind their shared filter/limit/output fields
// from ONE `schema-fields.ts` SoT, so the flattened `exarchos_view` registration
// cannot drift a shared field's base type apart across verbs. The binding seam
// is `registry.ts` (where the four action schemas reference the imported
// `lifecycle*Field` / `followField` shapes); reading that source and asserting
// the import + each verb's binding is the load-bearing DR-8 check.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_SRC = readFileSync(path.join(HERE, '..', 'registry.ts'), 'utf8');

function assertSharedSchemaFieldsSoT(): void {
  // The SoT import itself.
  expect(
    REGISTRY_SRC.includes(`from './projections/views/lifecycle/schema-fields.js'`),
    'registry.ts must import the shared lifecycle schema-fields SoT',
  ).toBe(true);

  // Each promoted verb binds at least one shared field from that SoT.
  const bindings: Readonly<Record<string, string>> = {
    ps: 'scope: lifecycleScopeField', // 007
    inspect: 'follow: followField', // 008 (+ limit: lifecycleLimitField)
    wait: 'operation: lifecycleOperationField', // 010
    export: 'output: lifecycleOutputField', // 013
  };
  for (const [verb, needle] of Object.entries(bindings)) {
    expect(
      REGISTRY_SRC.includes(needle),
      `${verb} (task-0${verb === 'ps' ? '07' : verb === 'inspect' ? '08' : verb === 'wait' ? '10' : '13'}) must bind the shared schema-fields SoT via \`${needle}\``,
    ).toBe(true);
  }
}

// ─── Three-path parity ───────────────────────────────────────────────────────

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

  it('Parity_EachPromotedVerb_ByteIdenticalToolResultAcrossThreePaths', async () => {
    // Setup: DR-8 shared-field SoT grep-assert (007/008/010/013).
    assertSharedSchemaFieldsSoT();

    restores.push(stubCompositeHandler('exarchos_view', viewStub));

    for (const { action, topLevelExpected, flags } of VERBS) {
      // The promotion stamp is registry-driven, not hardcoded here: read the
      // ACTUAL `cli.topLevel` and assert it equals the expected top-level name.
      const actual = viewAction(action).cli?.topLevel;
      expect(actual, `${action} must carry a cli.topLevel stamp`).toBe(topLevelExpected);

      // One shared empty-store context: every fixture is side-effect-free, so the
      // three carriers read identical state (and the stub's fixed clock removes
      // the only wall-clock variance, `wait.waitedMs`).
      const { stateDir, ctx } = await createContext(`lifecycle-parity-${action}-`);
      cleanups.push(stateDir);

      // Path 1 — MCP tool-call.
      const mcp = await harnessCallMcp(ctx, 'exarchos_view', { action, ...flags });
      // Path 2 — `vw <verb>` subcommand.
      const { result: sub, exitCode: subExit } = await harnessCallCli(ctx, 'vw', action, flags);
      // Path 3 — top-level `<verb>` (the DR-7 promotion; `describe` for inspect).
      const { result: top, exitCode: topExit } = await callTopLevel(ctx, topLevelExpected, flags);

      const nMcp = normalize(mcp);
      const nSub = normalize(sub);
      const nTop = normalize(top);

      // Byte-identical across ALL THREE carriers (deep-equal + stringified).
      expect(nSub, `${action}: subcommand ≡ MCP`).toEqual(nMcp);
      expect(nTop, `${action}: top-level ≡ MCP`).toEqual(nMcp);
      expect(JSON.stringify(nTop), `${action}: top-level byte-equal MCP`).toEqual(
        JSON.stringify(nMcp),
      );
      expect(JSON.stringify(nSub), `${action}: subcommand byte-equal top-level`).toEqual(
        JSON.stringify(nTop),
      );

      // The read-only fixtures all succeed → exit 0 on both CLI carriers.
      expect(subExit, `${action}: subcommand exit`).toBe(0);
      expect(topExit, `${action}: top-level exit`).toBe(0);
    }
  });

  // ─── DR-7 exit-code map (presentation only) ────────────────────────────────

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

  it('ExitCodeMap_Success_0', () => {
    const result: ToolResult = { success: true, data: { ok: true } };
    expect(resolveExitCode(result)).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(resolveExitCode(result)).toBe(0);
    // The two DR-7 exit codes sit above the generic 0-3 band so they never alias
    // SUCCESS / INVALID_INPUT / HANDLER_ERROR / UNCAUGHT_EXCEPTION.
    expect(ERROR_CODE_EXIT_CODES.WAIT_TIMEOUT).toBeGreaterThan(3);
    expect(ERROR_CODE_EXIT_CODES.WAIT_FAILED).toBeGreaterThan(3);
    // A code NOT in the map keeps the pre-DR-7 mapping (additive, not a rewrite).
    expect(resolveExitCode({ success: false, error: { code: 'INVALID_INPUT', message: 'x' } })).toBe(
      CLI_EXIT_CODES.INVALID_INPUT,
    );
    expect(resolveExitCode({ success: false, error: { code: 'SOME_OTHER', message: 'x' } })).toBe(
      CLI_EXIT_CODES.HANDLER_ERROR,
    );
  });

  // ─── Visible composite count fence (INV-5d) ────────────────────────────────

  it('Registry_VisibleCompositeCount_RemainsFour', () => {
    // Extends the `registry.test.ts` fence `Registry_VisibleToolCount_
    // UnchangedByPhaseKind`: promoting the four lifecycle verbs to TOP-LEVEL CLI
    // commands must add zero visible composite TOOLS — the promotion is a
    // `cli.topLevel` stamp on existing exarchos_view ACTIONS, not a new tool.
    const visible = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visible.length).toBe(4);
    expect(visible.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    // `exarchos_sync` stays the sole hidden composite — total unchanged at 5.
    expect(TOOL_REGISTRY).toHaveLength(5);

    // The four promoted verbs remain ACTIONS on exarchos_view (INV-5d), each
    // carrying a `cli.topLevel` stamp — never new composites.
    for (const { action, topLevelExpected } of VERBS) {
      expect(viewAction(action).cli?.topLevel).toBe(topLevelExpected);
    }
  });
});
