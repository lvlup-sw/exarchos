// Wave 3 Task 6 (#1448 item 4) — CLI surface for correlation filters.
//
// PR #1447 added `operationId / correlationId / causationId` to the Zod
// schemas of all 6 telemetry view actions (`telemetry`,
// `delegation_timeline`, `code_quality`, `eval_results`,
// `quality_correlation`, `quality_attribution`). The CLI layer in
// `adapters/cli.ts` generates flags from each action's schema via
// `addFlagsFromSchema` (schema-to-flags.ts), which kebab-cases optional
// string fields. That means the three filter flags should already be
// reachable from the command line — but no test pinned that contract,
// so a future schema refactor (e.g. moving correlation fields into a
// `.merge(...)` mixin or wrapping them in a transform) could silently
// drop the CLI surface without any test failure.
//
// These tests lock the surface in three layers:
//   1. Per-subcommand-per-flag dispatch-args assertions (18 tests:
//      3 flags × 6 subcommands) — the strongest cross-layer guarantee
//      short of subprocess invocation.
//   2. A Commander-program introspection sweep — fails fast and with a
//      clearer message if the flags vanish from the option list.
//   3. One end-to-end smoke that runs the CLI parse with the real
//      dispatch + a real in-process EventStore and asserts the response
//      reflects the correlation filter. This is the cross-layer
//      assertion the task plan calls for: flag → handler → helper →
//      EventStore filter, end to end.
//
// INV-4 (platform-agnosticity): the CLI surface must mirror the MCP
// surface. INV-5d (action discriminator): the flag names are the
// kebab-case of the camelCase arg keys.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Default mock for the unit tests below. The end-to-end smoke test in the
// last describe block UN-mocks dispatch (vi.doUnmock) so it can exercise
// the real handler chain against a real EventStore.
vi.mock('../core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({ success: true, data: { mocked: true } }),
  ),
}));

// Mirror the cli.test.ts mock — avoids real stdout side effects from the
// pretty/table paths while letting --json still emit the envelope for any
// assertion that wants to inspect stdout.
vi.mock('./cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
  toCliResult: vi.fn((env: unknown, format: string) => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    }
  }),
}));

import { buildCli } from './cli.js';
import { dispatch } from '../core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { expectedTrustedContext } from '../test-helpers/trusted-context.js';

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

// The 6 telemetry view subcommands PR #1447 wired correlation filters on.
// The CLI alias for `exarchos_view` is `vw`.
const VIEW_SUBCOMMANDS = [
  'telemetry',
  'delegation_timeline',
  'code_quality',
  'eval_results',
  'quality_correlation',
  'quality_attribution',
] as const;

// Three kebab→camel flag pairs. INV-5d: the flag name MUST be the
// kebab-case of the arg key so the MCP and CLI surfaces are 1:1.
const CORRELATION_FLAGS: ReadonlyArray<{
  flag: `--${string}`;
  argKey: 'operationId' | 'correlationId' | 'causationId';
  value: string;
}> = [
  { flag: '--operation-id', argKey: 'operationId', value: 'op-xyz' },
  { flag: '--correlation-id', argKey: 'correlationId', value: 'cor-abc' },
  { flag: '--causation-id', argKey: 'causationId', value: 'cau-def' },
];

// ─── Layer 1: Per-subcommand × per-flag dispatch-args wiring ────────────────

describe('CLI correlation filter flags — dispatch-args wiring (#1448 item 4)', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  for (const subcommand of VIEW_SUBCOMMANDS) {
    for (const { flag, argKey, value } of CORRELATION_FLAGS) {
      // PascalCase test name embeds both axes so a CI failure points
      // directly at the broken cell (subcommand × flag).
      const subcommandPascal = subcommand
        .split('_')
        .map((s) => s[0].toUpperCase() + s.slice(1))
        .join('');
      const argKeyPascal = argKey[0].toUpperCase() + argKey.slice(1);

      it(`Cli_View${subcommandPascal}_${argKeyPascal}Flag_ProducesCamelCaseArg`, async () => {
        const program = buildCli(ctx);

        await program.parseAsync([
          'node',
          'exarchos',
          'vw',
          subcommand,
          flag,
          value,
          '--json',
        ]);

        // Assert the auto-generated kebab→camel coercion produced the
        // exact arg key the MCP-side handler reads (INV-4 facade
        // equivalence + INV-5d action discriminator). If anyone ever
        // removes the correlation fields from the schemas, or breaks
        // the `addFlagsFromSchema` auto-derivation for optional strings,
        // dispatch would either not be called or be called without
        // `argKey`, and this assertion would fail.
        expect(dispatch).toHaveBeenCalledWith(
          'exarchos_view',
          expect.objectContaining({
            action: subcommand,
            [argKey]: value,
          }),
          expectedTrustedContext(ctx),
        );
      });
    }
  }
});

// ─── Layer 2: Commander introspection sweep ─────────────────────────────────
//
// A safety net for diagnosing why the dispatch-args tests above would fail:
// if the option simply isn't registered on the Commander subcommand at all,
// `parseAsync` would emit an `unknown option` Commander error (not call
// dispatch), and the layer-1 message could be confusing ("expected
// dispatch to have been called"). This layer asserts on the option list
// directly so the failure says exactly what's missing.

describe('CLI correlation filter flags — Commander option registration', () => {
  it('Cli_AllViewSubcommands_RegisterAllThreeCorrelationFlags', () => {
    const program = buildCli(createTestContext());
    const viewCmd = program.commands.find((c) => c.name() === 'vw');
    expect(viewCmd).toBeDefined();

    const missing: string[] = [];

    for (const subcommand of VIEW_SUBCOMMANDS) {
      const subCmd = viewCmd!.commands.find((c) => c.name() === subcommand);
      if (!subCmd) {
        missing.push(`${subcommand} (subcommand not registered)`);
        continue;
      }
      const optionFlags = subCmd.options.map((o) => o.flags);

      for (const { flag } of CORRELATION_FLAGS) {
        if (!optionFlags.some((f) => f.includes(flag))) {
          missing.push(`${subcommand}: missing ${flag}`);
        }
      }
    }

    // Empty array → all 6 subcommands × 3 flags are registered. Non-empty
    // array surfaces every cell that's broken so the operator doesn't have
    // to re-run after each fix.
    expect(missing).toEqual([]);
  });
});

// ─── Layer 3: End-to-end smoke (CLI → handler → helper → EventStore) ────────
//
// Exercises the FULL chain — `parseAsync` on the real Commander program,
// real `dispatch`, real `handleViewTelemetry`, real `EventStore` — to
// confirm the flag's value actually scopes the returned rollup. The unit
// tests above prove the arg makes it to `dispatch`; this confirms the
// handler honors it.

// The end-to-end smoke block resets modules and drives the real CLI dispatch
// over SQLite per test; on the windows-latest runner the setup/teardown
// exceeds 60s. The wiring is covered by the faster dispatch-args + Commander
// blocks above (which run on Windows). (#1620)
describe.skipIf(process.platform === 'win32')('CLI correlation filter — end-to-end smoke', () => {
  let tmpDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[];

  beforeEach(async () => {
    // Clear the per-file dispatch mock for this block; we want the REAL
    // dispatch implementation here.
    vi.doUnmock('../core/dispatch.js');
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-cli-corr-flag-'));
    stdoutChunks = [];
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    await rmrfAsync(tmpDir);
    // Restore the per-file mock for the next describe block. Vitest
    // executes describe blocks in source order within a file, but a
    // beforeEach reset keeps things deterministic regardless.
    vi.doMock('../core/dispatch.js', async () => {
      const real = await vi.importActual<typeof import('../core/dispatch.js')>(
        '../core/dispatch.js',
      );
      return real;
    });
  });

  it('CliVwTelemetry_CorrelationIdFlag_FiltersTelemetryEventsEndToEnd', async () => {
    // Late imports so the `vi.doUnmock` above takes effect for this
    // module subtree. Without re-import, the mocked `dispatch` would
    // still be wired into the `buildCli` action callback.
    const { buildCli: buildCliReal } = await import('./cli.js');
    const { EventStore } = await import('../event-store/store.js');

    const store = new EventStore(tmpDir);
    const TELEMETRY_STREAM = 'telemetry';

    // GIVEN: one tool.completed event stamped cor-X, one stamped cor-Y.
    // Pre-Task-5 (or pre-#1437) a no-filter call would fold both.
    await store.append(TELEMETRY_STREAM, {
      streamId: TELEMETRY_STREAM,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'tool.completed',
      operationId: 'op-X',
      correlationId: 'cor-X',
      data: {
        tool: 'tool_X',
        durationMs: 10,
        responseBytes: 100,
        tokenEstimate: 25,
      },
      schemaVersion: '1.0',
    });
    await store.append(TELEMETRY_STREAM, {
      streamId: TELEMETRY_STREAM,
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: 'tool.completed',
      operationId: 'op-Y',
      correlationId: 'cor-Y',
      data: {
        tool: 'tool_Y',
        durationMs: 50,
        responseBytes: 500,
        tokenEstimate: 200,
      },
      schemaVersion: '1.0',
    });

    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: store,
      enableTelemetry: false,
    };

    // WHEN: the user runs `exarchos vw telemetry --correlation-id cor-X`.
    const program = buildCliReal(ctx);
    await program.parseAsync([
      'node',
      'exarchos',
      'vw',
      'telemetry',
      '--correlation-id',
      'cor-X',
      '--json',
    ]);

    // THEN: the envelope on stdout reflects only the cor-X event. We
    // pluck the JSON envelope, walk down to `data.tools`, and assert
    // tool_Y was excluded — proving the CLI flag's value reached the
    // EventStore-side filter.
    const joined = stdoutChunks.join('');
    expect(joined).toContain('"success": true');

    // The envelope is pretty-printed JSON; locate the top-level object
    // by trimming. There may be extra whitespace/newlines around it.
    const trimmed = joined.trim();
    const envelope = JSON.parse(trimmed) as {
      success: boolean;
      data?: {
        tools?: Array<{ tool: string; invocations: number }>;
        session?: { totalInvocations: number };
      };
    };

    expect(envelope.success).toBe(true);
    expect(envelope.data).toBeDefined();
    const tools = envelope.data!.tools ?? [];
    // Cross-layer assertion: ONLY tool_X must be present.
    expect(tools.map((t) => t.tool)).toEqual(['tool_X']);
    expect(envelope.data!.session?.totalInvocations).toBe(1);
  });
});
