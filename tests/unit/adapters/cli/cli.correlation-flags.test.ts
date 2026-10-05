// CLI surface of the correlation filters.
//
// The schemas of six telemetry view actions hold `operationId`, `correlationId` and `causationId`.
// `addFlagsFromSchema` derives a kebab-case flag from each optional string field. A schema
// refactor can remove a flag with no other test failure, so this file pins the surface in
// three layers:
//   1. The dispatch arguments for each subcommand and each flag (6 subcommands x 3 flags).
//   2. The option list of each Commander subcommand, which gives a clear message for a missing flag.
//   3. One end-to-end smoke test with the real dispatch and a real `EventStore`.
//
// The CLI surface must mirror the MCP surface: each flag name is the kebab-case of the camelCase
// argument key.
//
// The `dispatch` mock is the default, and the smoke block removes it with `vi.doUnmock`. The
// `cli-format` mock stops table output, and its `toCliResult` still writes the `--json` envelope.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolResult } from '../../../../src/format.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

vi.mock('../../../../src/dispatch/core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({ success: true, data: { mocked: true } }),
  ),
}));

vi.mock('../../../../src/adapters/cli/cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
  toCliResult: vi.fn((env: unknown, format: string) => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    }
  }),
}));

import { buildCli } from '../../../../src/adapters/cli/cli.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { expectedTrustedContext } from '../../../../tools/test-helpers/trusted-context.js';

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

/** The six telemetry view subcommands that take the correlation filters. The CLI alias of `exarchos_view` is `vw`. */
const VIEW_SUBCOMMANDS = [
  'telemetry',
  'delegation_timeline',
  'code_quality',
  'eval_results',
  'quality_correlation',
  'quality_attribution',
] as const;

/** The flag and argument-key pairs. Each flag name must be the kebab-case of its argument key. */
const CORRELATION_FLAGS: ReadonlyArray<{
  flag: `--${string}`;
  argKey: 'operationId' | 'correlationId' | 'causationId';
  value: string;
}> = [
  { flag: '--operation-id', argKey: 'operationId', value: 'op-xyz' },
  { flag: '--correlation-id', argKey: 'correlationId', value: 'cor-abc' },
  { flag: '--causation-id', argKey: 'causationId', value: 'cau-def' },
];

/**
 * One test for each subcommand and flag. The test name holds both, so a failure names the broken cell.
 * A test fails when a schema loses a correlation field, or when `addFlagsFromSchema` stops deriving
 * the flag for an optional string.
 */
describe('CLI correlation filter flags — dispatch-args wiring (#1448 item 4)', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  for (const subcommand of VIEW_SUBCOMMANDS) {
    for (const { flag, argKey, value } of CORRELATION_FLAGS) {
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

/**
 * When a flag is not registered, `parseAsync` gives an `unknown option` error, and the
 * dispatch-arguments tests fail with an unclear message. This test reads the option lists and
 * names every missing subcommand and flag in one run.
 */
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

    expect(missing).toEqual([]);
  });
});

/**
 * The full chain: `parseAsync` on the real Commander program, the real `dispatch`, the real
 * telemetry view handler and a real `EventStore`. The test proves that the handler applies the filter.
 *
 * The block resets modules and runs the real dispatch over SQLite. On the Windows runner the setup
 * and teardown exceed 60 s, so the block skips there. The two faster blocks cover the wiring on Windows.
 */
describe.skipIf(process.platform === 'win32')('CLI correlation filter — end-to-end smoke', () => {
  let tmpDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[];

  /** Removes the file-level `dispatch` mock, so this block runs the real dispatch. */
  beforeEach(async () => {
    vi.doUnmock('../../../../src/dispatch/core/dispatch.js');
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

  /** Registers a `dispatch` factory that returns the real module to later imports. */
  afterEach(async () => {
    stdoutSpy.mockRestore();
    await rmrfAsync(tmpDir);
    vi.doMock('../../../../src/dispatch/core/dispatch.js', async () => {
      const real = await vi.importActual<typeof import('../../../../src/dispatch/core/dispatch.js')>(
        '../../../../src/dispatch/core/dispatch.js',
      );
      return real;
    });
  });

  /**
   * The late imports make `vi.doUnmock` apply to this module subtree. The file-level `buildCli`
   * still calls the mocked `dispatch` from its action callback.
   * The store holds one `tool.completed` event for `cor-X` and one for `cor-Y`. With
   * `--correlation-id cor-X`, the envelope on stdout must hold only `tool_X`.
   */
  it('CliVwTelemetry_CorrelationIdFlag_FiltersTelemetryEventsEndToEnd', async () => {
    const { buildCli: buildCliReal } = await import('../../../../src/adapters/cli/cli.js');
    const { EventStore } = await import('../../../../src/events/store.js');

    const store = new EventStore(tmpDir);
    const TELEMETRY_STREAM = 'telemetry';

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

    const joined = stdoutChunks.join('');
    expect(joined).toContain('"success": true');

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
    expect(tools.map((t) => t.tool)).toEqual(['tool_X']);
    expect(envelope.data!.session?.totalInvocations).toBe(1);
  });
});
