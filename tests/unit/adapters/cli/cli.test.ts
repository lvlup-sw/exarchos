// Tests for the CLI adapter: the command tree of `buildCli`, the exit codes, `runCli`, and the
// relation between the CLI and the compiled contract.
//
// File-wide mocks:
// - `dispatch` records calls, so no real handler runs.
// - `cli-format` stops table and tree output. A `vi.mock` factory replaces the whole module, so
//   the mock supplies a `toCliResult` that writes the `--json` envelope to stdout, as production does.
// - The SDK seam mock is partial. It stubs only `createV2StdioServerTransport`, the stdio transport
//   of the `mcp` sub-command, because a real transport takes the stdio streams of the test process.
//   `adapters/mcp/mcp.ts` also imports the seam, and the real-handler block needs its real
//   `createV2McpServer`.
// - `schema-introspection`, `adapters/mcp/mcp.js` and the install-skills bridge are plain stubs.
//
// The real-handler block is last in the file, because it resets the module registry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ToolResult } from '../../../../src/format.js';

vi.mock('../../../../src/dispatch/core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({
      success: true,
      data: { mocked: true },
    }),
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

vi.mock('../../../../src/adapters/cli/schema-introspection.js', () => ({
  listSchemas: vi.fn(() => [
    {
      tool: 'exarchos_workflow',
      hidden: false,
      actions: [
        { name: 'init', description: 'Initialize a new workflow' },
        { name: 'get', description: 'Read workflow state' },
      ],
    },
    {
      tool: 'exarchos_sync',
      hidden: true,
      actions: [{ name: 'now', description: 'Trigger immediate sync' }],
    },
  ]),
  resolveSchemaRef: vi.fn(() => ({
    type: 'object',
    properties: { featureId: { type: 'string' } },
  })),
}));

vi.mock('../../../../src/adapters/mcp/mcp.js', () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn(async () => {}),
  })),
}));

vi.mock('../../../../src/contract/sdk/seam.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/contract/sdk/seam.js')>();
  return { ...actual, createV2StdioServerTransport: vi.fn(() => ({})) };
});

import {
  buildCli,
  commanderErrorToResult,
  createCliDispatchContext,
  runCli,
  CLI_EXIT_CODES,
  CLI_PROMOTED_ACTION_IDS,
} from '../../../../src/adapters/cli/cli.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import { TOOL_REGISTRY, getFullRegistry } from '../../../../src/registry.js';
import type { CompositeTool } from '../../../../src/registry.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { CommanderError } from 'commander';
import {
  auditCliContract,
  collectDeviationAnnotations,
  compileForCli,
  deriveCliSurface,
  runDeviationLedgerCensus,
  scanDispatchSites,
  AUTHORIZED_DISPATCH_PROJECTIONS,
  CLI_CONTRACT_DEVIATIONS,
  CONTRACT_PROJECTIONS,
  type CliCommand,
  type ContractDeviation,
  type DeviationAnnotationSite,
  type DispatchSite,
} from '../../../../src/contract/cli/cli-contract-seam.js';
import {
  contractActionIds,
  invokeContractAction,
  UnknownContractActionError,
} from '../../../../src/contract/cli/generated-client.js';
import { CONTRACT_EXIT_CODES, exitCodeForError } from '../../../../src/contract/error-families.js';
import { spawnAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

describe('buildCli', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  it('BuildCli_RegistersAllToolGroups', () => {
    const program = buildCli(ctx);
    const commandNames = program.commands.map((c) => c.name());

    expect(commandNames).toContain('wf');
    expect(commandNames).toContain('ev');
    expect(commandNames).toContain('orch');
    expect(commandNames).toContain('vw');
    expect(commandNames).toContain('sy');
  });

  /** The `get` action has the CLI alias `status`. `transition` is the phase-mutation action, and no `set` action exists. */
  it('BuildCli_GeneratesActionSubcommands', () => {
    const program = buildCli(ctx);
    const workflowCmd = program.commands.find((c) => c.name() === 'wf');
    const actionNames = workflowCmd?.commands.map((c) => c.name()) ?? [];

    expect(actionNames).toContain('init');
    expect(actionNames).toContain('status');
    expect(actionNames).toContain('transition');
    expect(actionNames).toContain('cancel');
    expect(actionNames).toContain('cleanup');
    expect(actionNames).toContain('reconcile');
    expect(actionNames).not.toContain('set');
  });

  /** Each tool group uses its `cli.alias`, or its name without the `exarchos_` prefix. */
  it('BuildCli_UsesCliAlias_WhenProvided', () => {
    const program = buildCli(ctx);
    const commandNames = program.commands.map((c) => c.name());

    for (const tool of TOOL_REGISTRY) {
      const expectedName = tool.cli?.alias ?? tool.name.replace(/^exarchos_/, '');
      expect(commandNames).toContain(expectedName);
    }
  });

  it('BuildCli_ActionDispatchesCorrectly', async () => {
    const program = buildCli(ctx);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync([
      'node',
      'exarchos',
      'wf',
      'init',
      '--feature-id',
      'test-feature',
      '--workflow-type',
      'feature',
    ]);

    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_workflow',
      expect.objectContaining({
        action: 'init',
        featureId: 'test-feature',
        workflowType: 'feature',
      }),
      expect.objectContaining({
        ...ctx,
        callerIdentity: expect.objectContaining({
          kind: 'local-operator',
          role: 'operator',
        }),
      }),
    );

    stdoutSpy.mockRestore();
  });

  it('BuildCli_TrustedContext_ReplacesPreexistingCallerIdentity', () => {
    const trusted = createCliDispatchContext({
      ...ctx,
      callerIdentity: {
        subjectId: 'forged',
        kind: 'mcp-session',
        role: 'agent',
      },
    });

    expect(trusted.callerIdentity).toMatchObject({
      kind: 'local-operator',
      role: 'operator',
    });
    expect(trusted.callerIdentity?.subjectId).toMatch(/^local:[0-9a-f]{32}$/);
    expect(trusted.callerIdentity?.subjectId).not.toBe('forged');
  });

  /** The CLI writes the envelope as multi-line JSON, so the text holds `"success": true` with a space after the colon. */
  it('BuildCli_JsonFlag_OutputsRawJson', async () => {
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync([
      'node',
      'exarchos',
      'wf',
      'init',
      '--feature-id',
      'test-feature',
      '--workflow-type',
      'feature',
      '--json',
    ]);

    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('"success": true'),
    );

    stdoutSpy.mockRestore();
  });

  const FOLLOW_ACTION_CLI_NAMES: ReadonlyArray<{ readonly action: string; readonly cliName: string }> = [
    { action: 'workflow_status', cliName: 'workflow_status' },
    { action: 'shepherd_status', cliName: 'shepherd_status' },
    { action: 'pipeline', cliName: 'ls' },
    { action: 'convergence', cliName: 'convergence' },
    { action: 'delegation_timeline', cliName: 'delegation_timeline' },
  ];

  for (const { action, cliName } of FOLLOW_ACTION_CLI_NAMES) {
    /**
     * Each action in `VIEW_FOLLOW_ACTIONS` registers `--follow` on its `vw` subcommand.
     * Only `pipeline` has a CLI alias (`ls`), so the table maps each action name to its subcommand name.
     */
    it(`BuildCli_ViewFollow_${action}_RegistersFollowFlag`, () => {
      const program = buildCli(ctx);
      const viewCmd = program.commands.find((c) => c.name() === 'vw');
      expect(viewCmd, 'exarchos vw tool group not registered').toBeDefined();
      const actionCmd = viewCmd?.commands.find((c) => c.name() === cliName);
      expect(
        actionCmd,
        `exarchos vw ${cliName} subcommand not registered (action.name: ${action})`,
      ).toBeDefined();

      const optionFlags = actionCmd?.options.map((o) => o.flags) ?? [];
      expect(
        optionFlags.some((f) => f.includes('--follow')),
        `exarchos vw ${cliName} must register --follow (action.name '${action}' belongs in VIEW_FOLLOW_ACTIONS)`,
      ).toBe(true);
    });
  }

  /** Negative control: `vw tasks` is a one-shot view outside `VIEW_FOLLOW_ACTIONS`, so it must not register `--follow`. */
  it('BuildCli_ViewFollow_NonFollowAction_DoesNotRegisterFollowFlag', () => {
    const program = buildCli(ctx);
    const viewCmd = program.commands.find((c) => c.name() === 'vw');
    const tasksCmd = viewCmd?.commands.find((c) => c.name() === 'tasks');
    expect(tasksCmd, 'exarchos vw tasks subcommand not registered').toBeDefined();
    const optionFlags = tasksCmd?.options.map((o) => o.flags) ?? [];
    expect(optionFlags.some((f) => f.includes('--follow'))).toBe(false);
  });
});

describe('schema command', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  it('SchemaCommand_NoArgs_ListsAllActions', async () => {
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'schema']);

    const output = stdoutSpy.mock.calls.map(([s]) => s).join('');
    expect(output).toContain('exarchos_workflow');
    expect(output).toContain('init');

    stdoutSpy.mockRestore();
  });

  /**
   * The CLI schema listing keeps hidden tools such as `exarchos_sync` and marks each one `(hidden)`.
   * The MCP `tools/list` omits them, and that difference is intended.
   */
  it('SchemaCommand_NoArgs_MarksHiddenTools', async () => {
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'schema']);

    const output = stdoutSpy.mock.calls.map(([s]) => s).join('');
    expect(output).toMatch(/^exarchos_workflow:$/m);
    expect(output).toMatch(/^exarchos_sync \(hidden\):$/m);

    stdoutSpy.mockRestore();
  });

  it('SchemaCommand_InvalidRef_PrintsErrorGracefully', async () => {
    const { resolveSchemaRef } = await import('../../../../src/adapters/cli/schema-introspection.js');
    vi.mocked(resolveSchemaRef).mockImplementationOnce(() => {
      throw new Error('Unknown schema ref: "bogus.ref"');
    });

    const program = buildCli(ctx);

    await program.parseAsync(['node', 'exarchos', 'schema', 'bogus.ref']);

    const { printError } = await import('../../../../src/adapters/cli/cli-format.js');
    expect(printError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'INVALID_SCHEMA_REF',
        message: expect.stringContaining('bogus.ref'),
      }),
    );
  });

  it('SchemaCommand_WithRef_PrintsJsonSchema', async () => {
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'schema', 'workflow.init']);

    const output = stdoutSpy.mock.calls.map(([s]) => s).join('');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('type', 'object');
    expect(parsed).toHaveProperty('properties');

    stdoutSpy.mockRestore();
  });
});

describe('mcp command', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  it('McpCommand_Exists', () => {
    const program = buildCli(ctx);
    const commandNames = program.commands.map((c) => c.name());

    expect(commandNames).toContain('mcp');
  });
});

/** The `version` subcommand and the `--version` flag both print the `version` field of the repository `package.json`. */
describe('version subcommand', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  function readPkgVersion(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '../../../../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw).version as string;
  }

  it('VersionSubcommand_PrintsPackageJsonVersion_NotHardcodedLiteral', async () => {
    const program = buildCli(ctx);
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });

    await program.parseAsync(['node', 'exarchos', 'version']);

    const expected = readPkgVersion();
    const printed = writes.join('').trim();
    expect(printed).toBe(expected);

    stdoutSpy.mockRestore();
  });

  it('VersionSubcommand_MatchesProgramVersionFlag', async () => {
    const program = buildCli(ctx);
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });

    await program.parseAsync(['node', 'exarchos', 'version']);
    const subcommandOutput = writes.join('').trim();
    const programVersion = program.version();

    expect(subcommandOutput).toBe(programVersion);

    stdoutSpy.mockRestore();
  });
});

/**
 * `init` is a rename stub. It prints `renamed → use 'exarchos onboard'`, exits non-zero, and
 * dispatches nothing.
 */
describe('init command (DR-5 rename stub)', () => {
  let ctx: DispatchContext;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('InitCommand_IsRenameStub_DoesNotDispatch', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init']);

    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
    expect(dispatch).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it('InitCommand_PrintsRenameMessage_PointingAtOnboard', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init']);

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/renamed/i);
    expect(written).toContain("exarchos onboard");

    stderrSpy.mockRestore();
  });

  /** The stub accepts the legacy `--runtime` flag and ignores it. */
  it('InitCommand_WithRuntimeFlag_StillStubsAndDoesNotDispatch', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init', '--runtime', 'copilot']);

    const { dispatch } = await import('../../../../src/dispatch/core/dispatch.js');
    expect(dispatch).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it('InitCommand_ExitsNonZero_NotCommandNotFound', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init']);

    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    stderrSpy.mockRestore();
  });
});

/**
 * These tests pin how the CLI adapter maps a `ToolResult` to an exit code.
 * Parity tests import `CLI_EXIT_CODES` directly.
 */
describe('CLI exit-code mapping (DR-3)', () => {
  let ctx: DispatchContext;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('CLI_ExitCodesTable_IsExported', async () => {
    const { CLI_EXIT_CODES } = await import('../../../../src/adapters/cli/cli.js');

    expect(CLI_EXIT_CODES).toEqual({
      SUCCESS: 0,
      INVALID_INPUT: 1,
      HANDLER_ERROR: 2,
      UNCAUGHT_EXCEPTION: 3,
    });
  });

  /**
   * `--json` writes the envelope, which wraps `data` and adds `next_actions`, `_meta` and `_perf`.
   * `cli-format.test.ts` tests those fields directly, so this test uses `toMatchObject`.
   */
  it('CliInvocation_SuccessCase_Returns0AndStructuredPayload', async () => {
    vi.mocked(dispatch).mockResolvedValueOnce({
      success: true,
      data: { featureId: 'test-feature', phase: 'init' },
    });

    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync([
      'node',
      'exarchos',
      'wf',
      'init',
      '--feature-id',
      'test-feature',
      '--workflow-type',
      'feature',
      '--json',
    ]);

    expect(process.exitCode ?? 0).toBe(0);

    const stdoutText = stdoutSpy.mock.calls.map(([s]) => s).join('');
    const parsed = JSON.parse(stdoutText.trim());
    expect(parsed).toMatchObject({
      success: true,
      data: { featureId: 'test-feature', phase: 'init' },
      next_actions: [],
    });

    stdoutSpy.mockRestore();
  });

  /** An invalid `workflowType` fails the Zod validation of the action schema in the CLI, before dispatch. */
  it('CliInvocation_InvalidInput_Returns1WithInvalidInputCode', async () => {
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync([
      'node',
      'exarchos',
      'wf',
      'init',
      '--feature-id',
      'valid-id',
      '--workflow-type',
      'BOGUS',
      '--json',
    ]);

    expect(process.exitCode).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();

    const stdoutText = stdoutSpy.mock.calls.map(([s]) => s).join('');
    const parsed = JSON.parse(stdoutText.trim()) as {
      success: boolean;
      error?: { code: string; message: string };
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error?.code).toBe('INVALID_INPUT');
    expect(typeof parsed.error?.message).toBe('string');
    expect(parsed.error?.message.length).toBeGreaterThan(0);

    stdoutSpy.mockRestore();
  });

  it('CliInvocation_HandlerReportedError_Returns2WithErrorCode', async () => {
    vi.mocked(dispatch).mockResolvedValueOnce({
      success: false,
      error: {
        code: 'INVALID_TRANSITION',
        message: 'cannot transition from init to done',
      },
    });

    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync([
      'node',
      'exarchos',
      'wf',
      'init',
      '--feature-id',
      'test-feature',
      '--workflow-type',
      'feature',
      '--json',
    ]);

    expect(process.exitCode).toBe(2);

    const stdoutText = stdoutSpy.mock.calls.map(([s]) => s).join('');
    const parsed = JSON.parse(stdoutText.trim()) as {
      success: boolean;
      error?: { code: string; message: string };
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error?.code).toBe('INVALID_TRANSITION');
    expect(parsed.error?.message).toContain('init to done');

    stdoutSpy.mockRestore();
  });

  /** The message of the exception must appear in the error result. */
  it('CliInvocation_UncaughtException_Returns3', async () => {
    vi.mocked(dispatch).mockImplementationOnce(async () => {
      throw new Error('boom: unexpected runtime failure');
    });

    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync([
      'node',
      'exarchos',
      'wf',
      'init',
      '--feature-id',
      'test-feature',
      '--workflow-type',
      'feature',
      '--json',
    ]);

    expect(process.exitCode).toBe(3);

    const stdoutText = stdoutSpy.mock.calls.map(([s]) => s).join('');
    const parsed = JSON.parse(stdoutText.trim()) as {
      success: boolean;
      error?: { code: string; message: string };
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error?.message).toContain('boom');

    stdoutSpy.mockRestore();
  });
});

/**
 * The set of Commander codes that map to INVALID_INPUT is explicit. A Commander upgrade can add
 * a validation code, and a code outside the set maps to UNCAUGHT_EXCEPTION.
 * `commander.conflictingOption` comes from the option-conflict check of Commander.
 * `commander.invalidOptionArgument` is an older code that a custom argument parser can still throw.
 */
describe('commanderErrorToResult mapping table (F-024-CMDR)', () => {
  const invalidInputCodes: ReadonlyArray<string> = [
    'commander.missingMandatoryOptionValue',
    'commander.missingArgument',
    'commander.optionMissingArgument',
    'commander.invalidArgument',
    'commander.unknownCommand',
    'commander.unknownOption',
    'commander.excessArguments',
    'commander.invalidOptionArgument',
    'commander.conflictingOption',
  ];

  for (const code of invalidInputCodes) {
    /** The result keeps the Commander message, so the user sees which option or command failed. */
    it(`CommanderErrorMapping_${code}_MapsToInvalidInput`, () => {
      const err = new CommanderError(1, code, `synthetic error for ${code}`);
      const { result, exitCode } = commanderErrorToResult(err);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
      expect(result.error?.message).toContain('synthetic error');
    });
  }

  it('CommanderErrorMapping_HelpAndVersion_MapsToSuccess', () => {
    for (const code of ['commander.helpDisplayed', 'commander.help', 'commander.version']) {
      const err = new CommanderError(0, code, 'help or version');
      const { result, exitCode } = commanderErrorToResult(err);
      expect(result.success).toBe(true);
      expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    }
  });

  /** A code outside both sets maps to UNCAUGHT_EXCEPTION, so the user can tell it from a validation error. */
  it('CommanderErrorMapping_UnknownCode_MapsToUncaughtException', () => {
    const err = new CommanderError(1, 'commander.fabricatedCode', 'unknown signal');
    const { result, exitCode } = commanderErrorToResult(err);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNCAUGHT_EXCEPTION');
    expect(exitCode).toBe(CLI_EXIT_CODES.UNCAUGHT_EXCEPTION);
  });

  /**
   * Every `--json` failure path must write the same envelope shape: a handler error, a validation
   * error and a Commander parse error. A raw `ToolResult` has no `_meta` or `_perf`, so the test
   * looks for those fields after an unknown-option error.
   */
  it('RunCli_CommanderErrorJsonPath_EmitsEnvelopeShape', async () => {
    const program = buildCli(createTestContext());
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runCli(program, [
      'node',
      'exarchos',
      'wf',
      'init',
      '--feature-id',
      'test-feature',
      '--workflow-type',
      'feature',
      '--definitely-not-a-flag',
      '--json',
    ]);

    const calls = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(calls).toContain('"success": false');
    expect(calls).toContain('"error"');
    expect(calls).toContain('"_meta"');
    expect(calls).toContain('"_perf"');
    stdoutSpy.mockRestore();
  });
});

vi.mock('../../../../src/lifecycle/install-skills-bridge.js', () => ({
  runInstallSkills: vi.fn(async () => {}),
}));

/**
 * `install-skills` is a rename stub. The verb stays registered, so the user gets the rename
 * message and not the unknown-command error of Commander.
 * `cli-install-skills.test.ts` covers the stub. This block asserts only that the verb exists and
 * never calls the bridge.
 */
describe('install-skills subcommand (DR-5 rename stub)', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  it('cli_InstallSkillsSubcommand_StillRegistered_ForRenameMessage', () => {
    const program = buildCli(ctx);
    const installSkillsCmd = program.commands.find(
      (c) => c.name() === 'install-skills',
    );
    expect(installSkillsCmd).toBeDefined();
    const helpText = installSkillsCmd?.description() ?? '';
    expect(helpText.toLowerCase()).toContain('renamed');
    expect(helpText).toContain('onboard');
  });

  /** The stub exits with HANDLER_ERROR and never calls the bridge, also with the legacy `--agent` flag. */
  it('cli_InstallSkillsSubcommand_NeverDispatchesToBridge', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    await program.parseAsync([
      'node',
      'exarchos',
      'install-skills',
      '--agent',
      'claude',
    ]);

    const { runInstallSkills } = await import(
      '../../../../src/lifecycle/install-skills-bridge.js'
    );
    expect(runInstallSkills).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    process.exitCode = originalExitCode;
    stderrSpy.mockRestore();
  });
});

/**
 * Returns the path of the compiled host binary, or null when no build exists.
 * It uses `fileURLToPath`, because `URL().pathname` gives `/C:/...` on Windows, which breaks `path.resolve`.
 */
function findHostBinary(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'linux'
        ? 'linux'
        : process.platform === 'win32'
          ? 'windows'
          : null;
  if (!platform) return null;
  const ext = platform === 'windows' ? '.exe' : '';
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..');
  const candidate = path.join(repoRoot, 'dist', 'bin', `exarchos-${platform}-${arch}${ext}`);
  return fs.existsSync(candidate) ? candidate : null;
}

const SMOKE_BINARY = findHostBinary();

/**
 * An end-to-end probe of the compiled binary at `dist/bin/exarchos-<os>-<arch>`. The block skips
 * when the binary is absent.
 * `install-skills --help` must exit 0 and show the verb with the rename hint. Thus the stub and
 * its description are present in the output of `bun build --compile`.
 */
describe.skipIf(!SMOKE_BINARY)(
  'install-skills binary smoke (DR-5 rename stub)',
  () => {
    let homeTmp: string;
    let stateTmp: string;

    beforeEach(() => {
      homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-T18-home-'));
      stateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-T18-state-'));
    });

    /** Best-effort cleanup. The value of the smoke test is the spawn assertion, so the hook ignores a cleanup error. */
    afterEach(() => {
      try {
        rmrf(homeTmp);
        rmrf(stateTmp);
      } catch {
      }
    });

    it('cli_InstallSkillsBinary_HelpAgainstTempHome_ExitsZero', async () => {
      if (!SMOKE_BINARY) throw new Error('binary check should have skipped');
      const result = await spawnAsync(SMOKE_BINARY, ['install-skills', '--help'], {
        timeout: 30_000,
        env: { ...process.env, HOME: homeTmp, WORKFLOW_STATE_DIR: stateTmp },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('install-skills');
      expect(result.stdout.toLowerCase()).toContain('renamed');
      expect(result.stdout).toContain('onboard');
    });
  },
);

/**
 * The generic promotion mechanism and its collision guard, over the real registry and CLI wiring.
 * `registryWithTopLevel` clones the real registry and stamps `cli.topLevel` on one action. The
 * schema, the description and the dispatch wiring of that action stay real.
 * `buildCli` must hoist the action to a top-level command with the code path and the Zod schema
 * of the subcommand.
 */
describe('CLI top-level promotion (DR-7)', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  function registryWithTopLevel(
    toolName: string,
    actionName: string,
    topLevel: string,
  ): readonly CompositeTool[] {
    return getFullRegistry().map((tool) =>
      tool.name !== toolName
        ? tool
        : {
            ...tool,
            actions: tool.actions.map((action) =>
              action.name !== actionName
                ? action
                : { ...action, cli: { ...action.cli, topLevel } },
            ),
          },
    );
  }

  /**
   * Promotes the real `exarchos_view` `ps` action to a top-level `ps`. The hoisted command has the
   * same flags as `vw ps` and dispatches the same tool and action.
   * `--scope` is the witness for a schema-derived flag. The schema does not declare `probe`, so
   * neither form shows `--probe`.
   */
  it('Promotion_TopLevelStamp_CommandRegisteredAndDispatches', async () => {
    const registry = registryWithTopLevel('exarchos_view', 'ps', 'ps');
    const program = buildCli(ctx, { registry });

    const topLevelNames = program.commands.map((c) => c.name());
    expect(topLevelNames).toContain('ps');

    const topLevelPs = program.commands.find((c) => c.name() === 'ps');
    const vwPs = program.commands
      .find((c) => c.name() === 'vw')
      ?.commands.find((c) => c.name() === 'ps');
    expect(topLevelPs, 'top-level ps not registered').toBeDefined();
    expect(vwPs, 'vw ps subcommand not registered').toBeDefined();
    const topLevelFlags = (topLevelPs?.options ?? []).map((o) => o.flags).sort();
    const subFlags = (vwPs?.options ?? []).map((o) => o.flags).sort();
    expect(topLevelFlags).toEqual(subFlags);
    expect(topLevelFlags.some((f) => f.includes('--scope'))).toBe(true);
    expect(topLevelFlags.some((f) => f.includes('--probe'))).toBe(false);
    expect(subFlags.some((f) => f.includes('--probe'))).toBe(false);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await program.parseAsync(['node', 'exarchos', 'ps']);
    stdoutSpy.mockRestore();

    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_view',
      expect.objectContaining({ action: 'ps' }),
      expect.objectContaining({
        ...ctx,
        callerIdentity: expect.objectContaining({ kind: 'local-operator' }),
      }),
    );
  });

  /**
   * A `topLevel` name that collides with a top-level command makes `buildCli` throw, before any
   * argv parse or command action. `wf` is the name of the workflow group and `workflow` is its alias.
   * A name with no collision must not throw, so the guard rejects only collisions.
   */
  it('Promotion_CollidingName_FailsRegistrationNotRuntime', () => {
    const collideName = registryWithTopLevel('exarchos_view', 'ps', 'wf');
    expect(() => buildCli(ctx, { registry: collideName })).toThrow(
      /topLevel 'wf'.*collides with the existing top-level command 'wf'/,
    );

    const collideAlias = registryWithTopLevel('exarchos_view', 'ps', 'workflow');
    expect(() => buildCli(ctx, { registry: collideAlias })).toThrow(
      /topLevel 'workflow'.*collides with the existing top-level command/,
    );

    const noCollide = registryWithTopLevel('exarchos_view', 'ps', 'ps');
    expect(() => buildCli(ctx, { registry: noCollide })).not.toThrow();

    expect(dispatch).not.toHaveBeenCalled();
  });

  /** A promotion must not change the `<tool> <action>` form: `vw ps` still registers and dispatches. */
  it('Promotion_SubcommandForm_StillWorks', async () => {
    const registry = registryWithTopLevel('exarchos_view', 'ps', 'ps');
    const program = buildCli(ctx, { registry });

    const vwCmd = program.commands.find((c) => c.name() === 'vw');
    const vwPs = vwCmd?.commands.find((c) => c.name() === 'ps');
    expect(vwPs, 'vw ps subcommand missing after promotion').toBeDefined();

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await program.parseAsync(['node', 'exarchos', 'vw', 'ps']);
    stdoutSpy.mockRestore();

    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_view',
      expect.objectContaining({ action: 'ps' }),
      expect.objectContaining({
        ...ctx,
        callerIdentity: expect.objectContaining({ kind: 'local-operator' }),
      }),
    );
  });
});

/** A synthetic deviating module for the ledger kill arms (no live counterpart). */
const FIXTURE_DEVIANT_MODULE = 'cli-commands/fixture-direct-dispatch.ts';

/**
 * A fully governed synthetic ledger row. The live ledger is empty, so the kill arms run the census
 * against this row. Thus the arms stay active for the next candidate deviation.
 */
function fixtureDeviation(): ContractDeviation {
  return {
    id: 'fixture-direct-dispatch',
    module: FIXTURE_DEVIANT_MODULE,
    invariant: 'INV-2',
    kind: 'direct-dispatch-path',
    owner: 'exarchos',
    rationale:
      'Synthetic kill-arm fixture: a hypothetical module importing the runtime dispatch value.',
    retirement: 'The fixture module stops importing the runtime dispatch value.',
    tracking: 'DR-25 · adapters/cli.test.ts kill-arm fixture',
    expires: '2099-12-31',
  };
}

/** The fixture row with the fields of `patch` overridden, for the kill arms. */
function mutateDeviation(patch: Partial<ContractDeviation>): ContractDeviation[] {
  return [{ ...fixtureDeviation(), ...patch }];
}

/** The live projection sites PLUS the fixture's synthetic dispatch site. */
function fixtureSites(): DispatchSite[] {
  return [...CONTRACT_PROJECTIONS.map((module) => ({ module })), { module: FIXTURE_DEVIANT_MODULE }];
}

/** The acknowledgement that the synthetic module exports. It agrees with the fixture row. */
function fixtureAnnotations(): DeviationAnnotationSite[] {
  const row = fixtureDeviation();
  return [
    {
      module: FIXTURE_DEVIANT_MODULE,
      annotation: {
        invariant: row.invariant,
        module: row.module,
        owner: row.owner,
        expires: row.expires,
      },
    },
  ];
}

/**
 * The CLI is a generated client of the compiled contract, so it equals the MCP surface by
 * construction. The CLI adapter does not import the runtime `dispatch`. The only CLI-side
 * dispatch site is `contract/cli/generated-client.ts`, a contract projection.
 * The deviation ledger is empty, so the ledger kill arms run against a synthetic fixture row.
 */
describe('DR-25: CLI api-action dispatch path is generated, and the deviation is retired', () => {
  /**
   * Every live dispatch site is a contract projection, and the generated client is the only
   * CLI-side site. No deviation admits a site: the live ledger is empty, no module exports an
   * acknowledgement, and the full live census reports nothing.
   */
  it('Cli_ApiAction_HasNoDirectDispatchPath', async () => {
    const sites = await scanDispatchSites();
    const moduleNames = sites.map((s) => s.module);
    expect(moduleNames).not.toContain('adapters/cli.ts');
    expect(moduleNames).toContain('contract/cli/generated-client.ts');
    expect(moduleNames).toContain('adapters/mcp/mcp.ts');
    expect([...moduleNames].sort()).toEqual([...AUTHORIZED_DISPATCH_PROJECTIONS].sort());
    expect(CONTRACT_PROJECTIONS).toContain('contract/cli/generated-client.ts');

    expect(CLI_CONTRACT_DEVIATIONS).toEqual([]);
    const annotations = await collectDeviationAnnotations();
    expect(annotations).toEqual([]);
    expect(runDeviationLedgerCensus(sites, CLI_CONTRACT_DEVIATIONS, annotations)).toEqual([]);

    const audit = await auditCliContract();
    expect(audit.diagnostics).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  /**
   * The ledger holds no row, and the adapter has no dispatch site.
   * A new row for the module path `adapters/cli.ts` covers no live site, so the census reports
   * `STALE_DEVIATION`. Thus the ledger cannot admit the direct path again unless the import returns.
   */
  it('CliDeviation_LedgerIsEmpty_AndTheRetiredRowCannotQuietlyReturn', async () => {
    expect(CLI_CONTRACT_DEVIATIONS).toEqual([]);
    const sites = await scanDispatchSites();
    expect(sites.map((s) => s.module)).not.toContain('adapters/cli.ts');

    const resurrected = runDeviationLedgerCensus(
      sites,
      mutateDeviation({ id: 'cli-direct-dispatch', module: 'adapters/cli.ts' }),
      fixtureAnnotations(),
    );
    expect(resurrected.map((d) => d.code)).toContain('STALE_DEVIATION');
  });

  /**
   * Every arm runs against the synthetic fixture row and fabricated sites. The baseline passes
   * first, so each failing arm comes from its one mutation.
   * The arms cover a missing row, a second bypass, a past or malformed expiry, and a blank owner
   * or rationale. They also cover a stale row, a missing or different site acknowledgement, and a
   * module in both lists.
   * A ledger row governs one named module, so the second bypass stays unacknowledged.
   */
  it('CliDeviation_EveryWayTheRecordCouldRot_FailsClosed', () => {
    const sites = fixtureSites();
    const annotations = fixtureAnnotations();
    const codes = (diags: readonly { readonly code: string }[]): string[] =>
      diags.map((d) => d.code);
    expect(runDeviationLedgerCensus(sites, [fixtureDeviation()], annotations)).toEqual([]);

    const unrecorded = runDeviationLedgerCensus(sites, [], annotations);
    expect(unrecorded).toContainEqual(
      expect.objectContaining({
        code: 'UNACKNOWLEDGED_INV2_DEVIATION',
        module: FIXTURE_DEVIANT_MODULE,
      }),
    );

    const planted = runDeviationLedgerCensus(
      [...sites, { module: 'cli-commands/rogue-direct-dispatch.ts' }],
      [fixtureDeviation()],
      annotations,
    );
    expect(planted).toContainEqual(
      expect.objectContaining({
        code: 'UNACKNOWLEDGED_INV2_DEVIATION',
        module: 'cli-commands/rogue-direct-dispatch.ts',
      }),
    );

    expect(
      codes(runDeviationLedgerCensus(sites, mutateDeviation({ expires: '2020-01-01' }), annotations)),
    ).toContain('EXPIRED_DEVIATION');

    expect(
      codes(runDeviationLedgerCensus(sites, mutateDeviation({ expires: 'when-generated' }), annotations)),
    ).toContain('UNGOVERNED_DEVIATION');

    expect(
      runDeviationLedgerCensus(sites, mutateDeviation({ owner: '  ' }), annotations),
    ).toContainEqual(expect.objectContaining({ code: 'UNGOVERNED_DEVIATION', field: 'owner' }));

    expect(
      runDeviationLedgerCensus(sites, mutateDeviation({ rationale: '' }), annotations),
    ).toContainEqual(expect.objectContaining({ code: 'UNGOVERNED_DEVIATION', field: 'rationale' }));

    expect(
      codes(
        runDeviationLedgerCensus(
          sites.filter((s) => s.module !== FIXTURE_DEVIANT_MODULE),
          [fixtureDeviation()],
          annotations,
        ),
      ),
    ).toContain('STALE_DEVIATION');

    const unannotated: DeviationAnnotationSite[] = [
      { module: FIXTURE_DEVIANT_MODULE, annotation: undefined },
    ];
    expect(
      codes(runDeviationLedgerCensus(sites, [fixtureDeviation()], unannotated)),
    ).toContain('DEVIATION_ANNOTATION_MISMATCH');

    const [agreeing] = fixtureAnnotations();
    const drifted: DeviationAnnotationSite[] = [
      {
        module: FIXTURE_DEVIANT_MODULE,
        annotation: { ...agreeing!.annotation!, expires: '2098-01-01' },
      },
    ];
    expect(
      codes(runDeviationLedgerCensus(sites, [fixtureDeviation()], drifted)),
    ).toContain('DEVIATION_ANNOTATION_MISMATCH');

    expect(
      codes(
        runDeviationLedgerCensus(sites, [fixtureDeviation()], annotations, new Date(), [
          ...CONTRACT_PROJECTIONS,
          FIXTURE_DEVIANT_MODULE,
        ]),
      ),
    ).toContain('CONFLICTING_DEVIATION');
  });
});

/**
 * An ActionId is dispatchable only when the compiled contract holds it. These tests run over the
 * file-wide mocked `dispatch`. They pin how the seam addresses an action: it verifies the id,
 * splits it, and builds the dispatch payload.
 * The real-handler block at the end of the file covers handler behavior.
 */
describe('DR-25: generated client addresses only compiled contract actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The loop reads the promoted ids from `CLI_PROMOTED_ACTION_IDS`, so the test holds no count.
   * Each `<tool>.<action>` id of the registry must also be in the compiled surface. Thus a renamed
   * or removed action fails here, and not at runtime as an `UNKNOWN_ACTION` error.
   * The id set of the production seam must equal the derived surface.
   */
  it('Cli_EveryAddressedActionId_ExistsInDerivedSurface', async () => {
    const surfaceIds = new Set(
      deriveCliSurface(compileForCli()).commands.map((c) => c.actionId),
    );

    for (const actionId of Object.values(CLI_PROMOTED_ACTION_IDS)) {
      expect(surfaceIds.has(actionId), `${actionId} missing from the derived surface`).toBe(true);
    }

    for (const tool of getFullRegistry()) {
      for (const action of tool.actions) {
        const actionId = `${tool.name}.${action.name}`;
        expect(
          surfaceIds.has(actionId),
          `${actionId} is registered on the CLI but the contract does not compile it`,
        ).toBe(true);
      }
    }

    expect([...(await contractActionIds())].sort()).toEqual([...surfaceIds].sort());
  });

  /**
   * An unknown id gives a typed error envelope with the stable code `UNKNOWN_ACTION`, and no throw.
   * An escaped exception ends the compiled binary with exit 3. The dispatch core gives the same
   * code for an action that it cannot route, and `exitCodeForError` maps the code to HANDLER_ERROR.
   * The message names the id, because the cause is build drift and not user input. Nothing dispatches.
   */
  it('GeneratedClient_UnknownActionId_FailsLoud_WithoutDispatching', async () => {
    const result = await invokeContractAction(
      'exarchos_workflow.no_such_action',
      {},
      createTestContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_ACTION');
    expect(result.error?.message).toContain('exarchos_workflow.no_such_action');
    expect(result.error?.message).toContain('compiled contract surface');
    expect(new UnknownContractActionError('exarchos_workflow.no_such_action').message).toBe(
      result.error?.message,
    );
    expect(exitCodeForError(result.error?.code)).toBe(CONTRACT_EXIT_CODES.HANDLER_ERROR);
    expect(dispatch).not.toHaveBeenCalled();
  });

  /** The tool and the action come from the verified id. The payload has the shape `{ action, ...args }` that the shared handler expects. */
  it('GeneratedClient_SplitsVerifiedActionId_AndDispatchesTheContractPayload', async () => {
    const ctx = createTestContext();
    const result = await invokeContractAction('exarchos_workflow.get', { featureId: 'wcfix' }, ctx);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_workflow',
      { action: 'get', featureId: 'wcfix' },
      ctx,
    );
    expect(result).toEqual({ success: true, data: { mocked: true } });
  });
});

/**
 * The agreement proof in `contract/cli/differential-fixtures.test.ts` mocks `dispatch`, so it
 * shows only that two renderers agree on a value from the test. This block uses the real graph:
 * - the real `dispatch` over a real `EventStore`, with the registered `exarchos_workflow` handler
 * - the CLI through the real Commander tree and the production generated client
 * - the MCP side through the real `createMcpServer` over a real transport pair, so the
 *   output-schema check and `toMcpResult` also run
 * Both calls come from one compiled-contract descriptor.
 *
 * `vi.mock` is file-wide, so the block gets the real graph with `doUnmock`, `resetModules` and
 * dynamic imports. It is last in the file, because the reset must not disturb the earlier suites.
 */
describe('DR-25: generated CLI client agrees with MCP through a real handler', () => {
  /**
   * One compiled action, `exarchos_workflow.get`, drives both seams, so the two calls cannot
   * address different actions. The test pins the required flags, so a new required input fails here.
   *
   * Twin 1 is the success path. Twin 2 is the failure path, where two adapters drift most.
   * Each comparison drops only `_perf`, a wall-clock value, on top of the `normalize` defaults.
   * Anti-vacuity: the data is real workflow state, which the mocked `dispatch` cannot return,
   * because it returns `{ mocked: true }`. The call count of the mock also does not change.
   *
   * The CLI exit code must equal `exitCodeForError`, the contract authority. The last probe calls
   * the generated client directly: a compiled id reaches the handler, and an unknown id gives
   * `UNKNOWN_ACTION`.
   */
  it('Cli_GeneratedClient_AgreesWithMcpViaRealHandler', async () => {
    const mockedDispatchCallsBefore = vi.mocked(dispatch).mock.calls.length;
    vi.doUnmock('../../../../src/dispatch/core/dispatch.js');
    vi.doUnmock('../../../../src/adapters/cli/cli-format.js');
    vi.doUnmock('../../../../src/adapters/mcp/mcp.js');
    vi.resetModules();

    const { buildCli: realBuildCli } = await import('../../../../src/adapters/cli/cli.js');
    const { dispatch: realDispatch } = await import('../../../../src/dispatch/core/dispatch.js');
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
    const { EventStore } = await import('../../../../src/events/store.js');
    const { normalize } = await import('../../parity-harness.js');
    const { makeTempDir, rmrfAsync } = await import('../../../../tools/test-helpers/temp-dir.js');
    const {
      createV2Client,
      createV2LinkedTransportPair,
      connectV2Client,
      connectV2Server,
    } = await import('../../../../src/contract/sdk/seam.js');

    const surface = deriveCliSurface(compileForCli());
    const command: CliCommand | undefined = surface.commands.find(
      (c) => c.actionId === 'exarchos_workflow.get',
    );
    expect(command, 'exarchos_workflow.get missing from the generated CLI surface').toBeDefined();
    if (!command) return;

    const [mcpTool] = command.actionId.split('.');
    const requiredFlags = command.flags.filter((f) => f.required).map((f) => f.name);
    expect(requiredFlags).toEqual(['feature-id']);

    const stateDir = makeTempDir('inv2-real-handler-');
    const realCtx = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
    } as unknown as DispatchContext;

    const savedExitCode = process.exitCode;
    let client: ReturnType<typeof createV2Client> | undefined;
    let server: ReturnType<typeof createMcpServer> | undefined;

    const callCliSeam = async (
      featureId: string,
    ): Promise<{ envelope: Record<string, unknown>; exitCode: number }> => {
      const program = realBuildCli(realCtx);
      const chunks: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
          return true;
        });
      process.exitCode = undefined;
      try {
        await program.parseAsync([
          'node',
          'exarchos',
          command.group,
          command.commandName,
          `--${requiredFlags[0]}`,
          featureId,
          '--json',
        ]);
      } finally {
        stdoutSpy.mockRestore();
      }
      const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
      process.exitCode = undefined;
      const text = chunks.join('');
      const firstBrace = text.indexOf('{');
      expect(firstBrace, `CLI emitted no JSON envelope: ${text}`).toBeGreaterThanOrEqual(0);
      return {
        envelope: JSON.parse(text.slice(firstBrace)) as Record<string, unknown>,
        exitCode,
      };
    };

    try {
      const featureId = 'inv2-real-handler';
      const seeded = await realDispatch(
        'exarchos_workflow',
        { action: 'init', featureId, workflowType: 'feature' },
        realCtx,
      );
      expect(seeded.success, JSON.stringify(seeded.error)).toBe(true);

      server = createMcpServer(realCtx);
      const [clientTransport, serverTransport] = createV2LinkedTransportPair();
      client = createV2Client({ name: 'inv2-agreement-probe', version: '0.0.0' });
      await Promise.all([
        connectV2Server(server, serverTransport),
        connectV2Client(client, clientTransport),
      ]);

      const callMcpSeam = async (id: string) =>
        client!.callTool({ name: mcpTool!, arguments: { action: command.action, featureId: id } });

      const stripVolatile = { dropKeys: new Set(['_perf']) };

      const cliOk = await callCliSeam(featureId);
      const mcpOk = await callMcpSeam(featureId);

      const okData = cliOk.envelope.data as Record<string, unknown>;
      expect(okData.featureId).toBe(featureId);
      expect(okData.phase).toBe('plan');
      expect(okData.workflowType).toBe('feature');
      expect(okData).not.toHaveProperty('mocked');
      expect(vi.mocked(dispatch).mock.calls.length).toBe(mockedDispatchCallsBefore);

      expect(normalize(cliOk.envelope, stripVolatile)).toEqual(
        normalize(mcpOk.structuredContent, stripVolatile),
      );
      expect(cliOk.exitCode).toBe(CONTRACT_EXIT_CODES.SUCCESS);
      expect(mcpOk.isError).toBe(false);

      const missingId = 'inv2-real-handler-absent';
      const cliErr = await callCliSeam(missingId);
      const mcpErr = await callMcpSeam(missingId);

      expect(cliErr.envelope.success).toBe(false);
      const errorCode = (cliErr.envelope.error as Record<string, unknown>).code as string;
      expect(errorCode).toBe('STATE_NOT_FOUND');

      expect(normalize(cliErr.envelope, stripVolatile)).toEqual(
        normalize(mcpErr.structuredContent, stripVolatile),
      );
      expect(mcpErr.isError).toBe(true);
      expect(cliErr.exitCode).toBe(exitCodeForError(errorCode));
      expect(cliErr.exitCode).not.toBe(CONTRACT_EXIT_CODES.SUCCESS);

      const generatedClient = await import('../../../../src/contract/cli/generated-client.js');
      const direct = await generatedClient.invokeContractAction(
        command.actionId,
        { featureId },
        realCtx,
      );
      expect(direct.success).toBe(true);
      expect((direct.data as Record<string, unknown>).featureId).toBe(featureId);
      const unaddressable = await generatedClient.invokeContractAction(
        'exarchos_workflow.not_a_compiled_action',
        {},
        realCtx,
      );
      expect(unaddressable.success).toBe(false);
      expect(unaddressable.error?.code).toBe('UNKNOWN_ACTION');
      expect(unaddressable.error?.message).toMatch(/not part of the compiled contract surface/);
    } finally {
      process.exitCode = savedExitCode;
      if (client) await client.close();
      if (server) await server.close();
      await rmrfAsync(stateDir);
    }
  });
});