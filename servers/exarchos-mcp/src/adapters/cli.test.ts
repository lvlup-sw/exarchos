import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ToolResult } from '../format.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock dispatch to capture calls without invoking real handlers
vi.mock('../core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({
      success: true,
      data: { mocked: true },
    }),
  ),
}));

// Mock cli-format to avoid real stdout writes (table/tree paths). The
// `toCliResult` mock mirrors the real impl for the `--json` path so
// stdout assertions still see envelope JSON — without the mock entry,
// `emitResult`'s `toCliResult(toEnvelope(result), 'json')` call fails
// with "No 'toCliResult' export is defined on the './cli-format.js' mock"
// because vi.mock() factories REPLACE the module rather than extending it.
vi.mock('./cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
  toCliResult: vi.fn((env: unknown, format: string) => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    }
  }),
}));

// Mock schema-introspection
vi.mock('./schema-introspection.js', () => ({
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

// Mock MCP adapter and transport for mcp command test
vi.mock('./mcp.js', () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn(async () => {}),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(() => ({})),
}));

// ─── Test Imports ────────────────────────────────────────────────────────────

import { buildCli, commanderErrorToResult, runCli, CLI_EXIT_CODES } from './cli.js';
import { dispatch } from '../core/dispatch.js';
import { TOOL_REGISTRY, getFullRegistry } from '../registry.js';
import type { CompositeTool } from '../registry.js';
import type { DispatchContext } from '../core/dispatch.js';
import { CommanderError } from 'commander';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

// ─── Task 11: CLI Command Tree Generator ─────────────────────────────────────

describe('buildCli', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  it('BuildCli_RegistersAllToolGroups', () => {
    // Arrange & Act
    const program = buildCli(ctx);
    const commandNames = program.commands.map((c) => c.name());

    // Assert — all 5 tools registered with their CLI aliases
    expect(commandNames).toContain('wf');
    expect(commandNames).toContain('ev');
    expect(commandNames).toContain('orch');
    expect(commandNames).toContain('vw');
    expect(commandNames).toContain('sy');
  });

  it('BuildCli_GeneratesActionSubcommands', () => {
    // Arrange & Act
    const program = buildCli(ctx);
    const workflowCmd = program.commands.find((c) => c.name() === 'wf');
    const actionNames = workflowCmd?.commands.map((c) => c.name()) ?? [];

    // Assert — workflow actions (get is aliased to 'status')
    // T5a.1/DR-4 (#1259, v2.11): `set` removed; `transition` is the
    // canonical phase-mutation action and replaces it in CLI coverage.
    expect(actionNames).toContain('init');
    expect(actionNames).toContain('status');
    expect(actionNames).toContain('transition');
    expect(actionNames).toContain('cancel');
    expect(actionNames).toContain('cleanup');
    expect(actionNames).toContain('reconcile');
    expect(actionNames).not.toContain('set');
  });

  it('BuildCli_UsesCliAlias_WhenProvided', () => {
    // Arrange — find a tool with an alias or verify alias mechanism works
    // We test that if a tool had cli.alias, it would be used.
    // Since the registry may not have aliases, we verify the naming falls
    // through to the stripped name correctly.
    const program = buildCli(ctx);
    const commandNames = program.commands.map((c) => c.name());

    // Each tool gets its name with exarchos_ stripped
    for (const tool of TOOL_REGISTRY) {
      const expectedName = tool.cli?.alias ?? tool.name.replace(/^exarchos_/, '');
      expect(commandNames).toContain(expectedName);
    }
  });

  it('BuildCli_ActionDispatchesCorrectly', async () => {
    // Arrange
    const program = buildCli(ctx);

    // Capture stdout to avoid polluting test output
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act — parse a workflow init command (using 'wf' alias)
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

    // Assert — dispatch was called with correct tool name and args
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_workflow',
      expect.objectContaining({
        action: 'init',
        featureId: 'test-feature',
        workflowType: 'feature',
      }),
      ctx,
    );

    stdoutSpy.mockRestore();
  });

  it('BuildCli_JsonFlag_OutputsRawJson', async () => {
    // Arrange
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act — parse with --json flag (using 'wf' alias)
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

    // Assert — stdout should carry the envelope JSON. Post-PR-B the CLI
    // emits `JSON.stringify(env, null, 2)` (pretty), so the colon-space
    // is part of the wire shape now ("success": true rather than
    // "success":true). The substring assertion holds either way as long
    // as we don't require the compact form.
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('"success": true'),
    );

    stdoutSpy.mockRestore();
  });

  // ─── #1440 Op 1 (T7): --follow expansion to additional view actions ──────
  //
  // The `isViewFollow` predicate currently inlines a two-arm disjunction
  // over `workflow_status | shepherd_status`. Expansion adds three more
  // pure ViewProjection-backed actions (`pipeline`, `convergence`,
  // `delegation_timeline`) per the T1 orchestrator-inline idempotency
  // audit. These tests pin that the `--follow` option is REGISTERED for
  // each of the five actions through the Commander tree — they fail
  // BEFORE expansion because the predicate rejects the new three, so the
  // `actionCmd.option('--follow', ...)` registration call is skipped and
  // the option simply doesn't exist on the command.

  // Map (action.name in registry) → (CLI subcommand name, after action.cli.alias resolution).
  // Only `pipeline` carries an alias (`ls`); the others register under their full name.
  const FOLLOW_ACTION_CLI_NAMES: ReadonlyArray<{ readonly action: string; readonly cliName: string }> = [
    { action: 'workflow_status', cliName: 'workflow_status' },
    { action: 'shepherd_status', cliName: 'shepherd_status' },
    { action: 'pipeline', cliName: 'ls' },
    { action: 'convergence', cliName: 'convergence' },
    { action: 'delegation_timeline', cliName: 'delegation_timeline' },
  ];

  for (const { action, cliName } of FOLLOW_ACTION_CLI_NAMES) {
    it(`BuildCli_ViewFollow_${action}_RegistersFollowFlag`, () => {
      // Arrange — locate the `vw <cliName>` subcommand via the Commander tree.
      const program = buildCli(ctx);
      const viewCmd = program.commands.find((c) => c.name() === 'vw');
      expect(viewCmd, 'exarchos vw tool group not registered').toBeDefined();
      const actionCmd = viewCmd?.commands.find((c) => c.name() === cliName);
      expect(
        actionCmd,
        `exarchos vw ${cliName} subcommand not registered (action.name: ${action})`,
      ).toBeDefined();

      // Assert — the `--follow` option is present on the subcommand.
      const optionFlags = actionCmd?.options.map((o) => o.flags) ?? [];
      expect(
        optionFlags.some((f) => f.includes('--follow')),
        `exarchos vw ${cliName} must register --follow (action.name '${action}' belongs in VIEW_FOLLOW_ACTIONS)`,
      ).toBe(true);
    });
  }

  it('BuildCli_ViewFollow_NonFollowAction_DoesNotRegisterFollowFlag', () => {
    // Negative control: `view tasks` is a one-shot detail view that the
    // T7 expansion deliberately leaves out of `VIEW_FOLLOW_ACTIONS`. The
    // predicate must continue to gate `--follow` registration to the
    // members of the set — a stray addition (or a typo) should NOT
    // silently register the flag on every view action.
    const program = buildCli(ctx);
    const viewCmd = program.commands.find((c) => c.name() === 'vw');
    const tasksCmd = viewCmd?.commands.find((c) => c.name() === 'tasks');
    expect(tasksCmd, 'exarchos vw tasks subcommand not registered').toBeDefined();
    const optionFlags = tasksCmd?.options.map((o) => o.flags) ?? [];
    expect(optionFlags.some((f) => f.includes('--follow'))).toBe(false);
  });
});

// ─── Task 12: Schema Command ─────────────────────────────────────────────────

describe('schema command', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  it('SchemaCommand_NoArgs_ListsAllActions', async () => {
    // Arrange
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'schema']);

    // Assert — should list tool names
    const output = stdoutSpy.mock.calls.map(([s]) => s).join('');
    expect(output).toContain('exarchos_workflow');
    expect(output).toContain('init');

    stdoutSpy.mockRestore();
  });

  // Bug #1218: hidden tools (e.g. exarchos_sync) MUST stay in the CLI
  // schema listing — the asymmetry with MCP `tools/list` is intentional —
  // but they should be marked `(hidden)` so the operator can see they are
  // not part of the model-facing contract.
  it('SchemaCommand_NoArgs_MarksHiddenTools', async () => {
    // Arrange
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'schema']);

    // Assert
    const output = stdoutSpy.mock.calls.map(([s]) => s).join('');
    expect(output).toMatch(/^exarchos_workflow:$/m);
    expect(output).toMatch(/^exarchos_sync \(hidden\):$/m);

    stdoutSpy.mockRestore();
  });

  it('SchemaCommand_InvalidRef_PrintsErrorGracefully', async () => {
    // Arrange — make resolveSchemaRef throw for this test only
    const { resolveSchemaRef } = await import('./schema-introspection.js');
    vi.mocked(resolveSchemaRef).mockImplementationOnce(() => {
      throw new Error('Unknown schema ref: "bogus.ref"');
    });

    const program = buildCli(ctx);

    // Act
    await program.parseAsync(['node', 'exarchos', 'schema', 'bogus.ref']);

    // Assert — printError called with error info
    const { printError } = await import('./cli-format.js');
    expect(printError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'INVALID_SCHEMA_REF',
        message: expect.stringContaining('bogus.ref'),
      }),
    );
  });

  it('SchemaCommand_WithRef_PrintsJsonSchema', async () => {
    // Arrange
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'schema', 'workflow.init']);

    // Assert — should print JSON schema
    const output = stdoutSpy.mock.calls.map(([s]) => s).join('');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('type', 'object');
    expect(parsed).toHaveProperty('properties');

    stdoutSpy.mockRestore();
  });
});

// ─── Task 13: MCP Command ────────────────────────────────────────────────────

describe('mcp command', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  it('McpCommand_Exists', () => {
    // Arrange & Act
    const program = buildCli(ctx);
    const commandNames = program.commands.map((c) => c.name());

    // Assert
    expect(commandNames).toContain('mcp');
  });
});

// ─── Bug #1216: version subcommand reads from package.json ──────────────────

describe('version subcommand', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  /**
   * Read the package.json the CLI is built from. The cli.ts module
   * lives at `<repo>/servers/exarchos-mcp/src/adapters/cli.ts`, so the
   * MCP server's package.json is at `<repo>/servers/exarchos-mcp/package.json`.
   */
  function readPkgVersion(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw).version as string;
  }

  it('VersionSubcommand_PrintsPackageJsonVersion_NotHardcodedLiteral', async () => {
    // Arrange — capture stdout writes during `exarchos version`.
    const program = buildCli(ctx);
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });

    // Act — invoke the version subcommand without flags.
    await program.parseAsync(['node', 'exarchos', 'version']);

    // Assert — printed value matches package.json.version exactly.
    const expected = readPkgVersion();
    const printed = writes.join('').trim();
    expect(printed).toBe(expected);

    stdoutSpy.mockRestore();
  });

  it('VersionSubcommand_MatchesProgramVersionFlag', async () => {
    // The subcommand and `--version` flag must agree — they both
    // describe the same running binary.
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

// ─── Task 25: Init Scaffolding Command ────────────────────────────────────────

describe('init command (DR-5 rename stub)', () => {
  // Task 011 swap (design line 322): the `init` action is removed and the `init`
  // CLI verb is now a one-release error stub — it prints `renamed → use
  // 'exarchos onboard'` and exits non-zero, running NO onboarding side effect and
  // dispatching nothing. The init handler (`handleInitWithWriters`) +
  // `init.executed` event were fully removed in DR-5 (task 018); `onboard`
  // reproduces init's outputs via the GENERATE writers.
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
    // The stub must NOT dispatch to exarchos_orchestrate (no onboarding side
    // effect runs from the stub — DR-5 acceptance criterion).
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init']);

    const { dispatch } = await import('../core/dispatch.js');
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

  it('InitCommand_WithRuntimeFlag_StillStubsAndDoesNotDispatch', async () => {
    // Even with the legacy `--runtime` flag, the stub does not dispatch — the
    // flag is accepted (allowUnknownOption) but ignored; no init action exists.
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init', '--runtime', 'copilot']);

    const { dispatch } = await import('../core/dispatch.js');
    expect(dispatch).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it('InitCommand_ExitsNonZero_NotCommandNotFound', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init']);

    // Non-zero per DR-5 (HANDLER_ERROR=2), not a Commander unknown-command exit.
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    stderrSpy.mockRestore();
  });
});

// ─── Task 013: CLI Exit-Code Mapping + Error-Shape Alignment (DR-3) ──────────
// These tests define the contract between the CLI adapter and the MCP
// ToolResult shape. Exit codes are load-bearing for downstream parity tests
// (tasks 014-017) which import CLI_EXIT_CODES directly.

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
    // Arrange & Act — downstream tasks 014-017 import this table directly.
    const { CLI_EXIT_CODES } = await import('./cli.js');

    // Assert — canonical mapping for success / input / handler / uncaught.
    expect(CLI_EXIT_CODES).toEqual({
      SUCCESS: 0,
      INVALID_INPUT: 1,
      HANDLER_ERROR: 2,
      UNCAUGHT_EXCEPTION: 3,
    });
  });

  it('CliInvocation_SuccessCase_Returns0AndStructuredPayload', async () => {
    // Arrange — dispatch returns a success ToolResult
    vi.mocked(dispatch).mockResolvedValueOnce({
      success: true,
      data: { featureId: 'test-feature', phase: 'init' },
    });

    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
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

    // Assert — exit 0 (success) and envelope JSON on stdout (post-PR-B
    // emitResult routes `--json` through `toCliResult(toEnvelope(...))`).
    // The envelope wraps the ToolResult's `data` and adds `next_actions`,
    // `_meta`, `_perf` siblings; assert the data + success shape via
    // `objectContaining` so the extra envelope fields don't need to be
    // enumerated literally (they're tested directly in cli-format.test.ts).
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

  it('CliInvocation_InvalidInput_Returns1WithInvalidInputCode', async () => {
    // Arrange — invalid workflowType should fail the action schema's Zod
    // validation at the CLI layer, before dispatch is ever called.
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act — "BOGUS" is not a valid workflow type
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

    // Assert — exit 1, dispatch never reached, ToolResult with INVALID_INPUT
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
    // Arrange — dispatch returns a ToolResult with success=false
    vi.mocked(dispatch).mockResolvedValueOnce({
      success: false,
      error: {
        code: 'INVALID_TRANSITION',
        message: 'cannot transition from init to done',
      },
    });

    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
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

    // Assert — exit 2 (handler error), ToolResult echoed verbatim
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

  it('CliInvocation_UncaughtException_Returns3', async () => {
    // Arrange — dispatch throws synchronously (bypasses its internal catch)
    vi.mocked(dispatch).mockImplementationOnce(async () => {
      throw new Error('boom: unexpected runtime failure');
    });

    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
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

    // Assert — exit 3 (uncaught exception), normalized error payload
    expect(process.exitCode).toBe(3);

    const stdoutText = stdoutSpy.mock.calls.map(([s]) => s).join('');
    const parsed = JSON.parse(stdoutText.trim()) as {
      success: boolean;
      error?: { code: string; message: string };
    };
    expect(parsed.success).toBe(false);
    // The exception message should surface in the normalized ToolResult
    expect(parsed.error?.message).toContain('boom');

    stdoutSpy.mockRestore();
  });
});

// ─── F-024-CMDR: commanderErrorToResult mapping-table parity ────────────────
//
// Keep the Commander-error → INVALID_INPUT set explicit so future Commander
// upgrades don't silently introduce a new validation-ish code that falls
// through the default branch and gets mis-mapped as UNCAUGHT_EXCEPTION.
// Every code listed in these fixtures MUST be recognized as a validation
// failure.
describe('commanderErrorToResult mapping table (F-024-CMDR)', () => {
  const invalidInputCodes: ReadonlyArray<string> = [
    // Originally covered (task 024 initial green):
    'commander.missingMandatoryOptionValue',
    'commander.missingArgument',
    'commander.optionMissingArgument',
    'commander.invalidArgument',
    'commander.unknownCommand',
    'commander.unknownOption',
    'commander.excessArguments',
    // F-024-CMDR additions — emitted by Commander's native option-conflict
    // check and a legacy `<value>` type-mismatch code path preserved for
    // backward-compatibility with older Commander releases / plugins.
    'commander.invalidOptionArgument',
    'commander.conflictingOption',
  ];

  for (const code of invalidInputCodes) {
    it(`CommanderErrorMapping_${code}_MapsToInvalidInput`, () => {
      const err = new CommanderError(1, code, `synthetic error for ${code}`);
      const { result, exitCode } = commanderErrorToResult(err);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
      // Message should be preserved verbatim so CLI users still see which
      // option/command failed.
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

  it('CommanderErrorMapping_UnknownCode_MapsToUncaughtException', () => {
    // Codes not in the whitelist fall through to UNCAUGHT_EXCEPTION so the
    // exit-code table (task 013) remains correct and users see a distinct
    // failure mode from plain validation errors.
    const err = new CommanderError(1, 'commander.fabricatedCode', 'unknown signal');
    const { result, exitCode } = commanderErrorToResult(err);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNCAUGHT_EXCEPTION');
    expect(exitCode).toBe(CLI_EXIT_CODES.UNCAUGHT_EXCEPTION);
  });

  it('RunCli_CommanderErrorJsonPath_EmitsEnvelopeShape', async () => {
    // INV-2 (facade equivalence): every `--json` failure path — handler,
    // validation, AND Commander parse error — must emit the same envelope
    // shape. CodeRabbit MAJOR on PR #1369: runCli previously did
    // `process.stdout.write(JSON.stringify(result))` for CommanderError,
    // producing a raw `ToolResult` shape that diverged from the envelope
    // emitted by `emitResult`. Route both through `toCliResult(toEnvelope)`
    // so consumers see one shape.
    const program = buildCli(createTestContext());
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Trigger an unknown-option Commander error in --json mode.
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

    // Assert envelope shape on stdout: `success: false` + canonical
    // envelope fields (`_meta`, `_perf`, `error`). The raw ToolResult
    // would lack `_meta`/`_perf` so this catches the divergence.
    const calls = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(calls).toContain('"success": false');
    expect(calls).toContain('"error"');
    expect(calls).toContain('"_meta"');
    expect(calls).toContain('"_perf"');
    stdoutSpy.mockRestore();
  });
});

// ─── DR-5 (task 018): install-skills CLI subcommand → rename stub ─────────────
//
// `install-skills` was consolidated into `onboard` (DR-5). The verb is now a
// one-release **rename stub**: it stays REGISTERED (so `exarchos install-skills`
// prints an actionable rename message instead of Commander's bare unknown-command
// error), prints `renamed → use 'exarchos onboard'`, exits non-zero, and never
// reaches the bridge. The dedicated stub-behavior coverage lives in
// `cli-install-skills.test.ts`; here we only assert the verb is present + that
// the bridge is never dispatched to.

vi.mock('../cli-commands/install-skills-bridge.js', () => ({
  runInstallSkills: vi.fn(async () => {}),
}));

describe('install-skills subcommand (DR-5 rename stub)', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  it('cli_InstallSkillsSubcommand_StillRegistered_ForRenameMessage', () => {
    // The verb must still be present on the Commander program so that
    // `exarchos install-skills` resolves to the rename stub instead of
    // producing `error: unknown command 'install-skills'`.
    const program = buildCli(ctx);
    const installSkillsCmd = program.commands.find(
      (c) => c.name() === 'install-skills',
    );
    expect(installSkillsCmd).toBeDefined();
    const helpText = installSkillsCmd?.description() ?? '';
    expect(helpText.toLowerCase()).toContain('renamed');
    expect(helpText).toContain('onboard');
  });

  it('cli_InstallSkillsSubcommand_NeverDispatchesToBridge', async () => {
    // The stub runs NO install side effect — the bridge is never reached, and
    // the verb exits non-zero (HANDLER_ERROR), even with a legacy `--agent` flag.
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
      '../cli-commands/install-skills-bridge.js'
    );
    expect(runInstallSkills).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    process.exitCode = originalExitCode;
    stderrSpy.mockRestore();
  });
});

// ─── DR-5 (task 018): install-skills binary smoke (conditional) ──────────────
//
// Cheap end-to-end probe against the compiled binary at
// `dist/bin/exarchos-<os>-<arch>`. Skipped when the binary is absent so
// developers without a local build don't see a phantom failure; CI runs
// `npm run build` before tests, so the binary IS present there.
//
// `install-skills` is now a DR-5 rename stub. We assert `--help` exits 0 and
// shows the verb + the rename hint, proving Commander still registered the verb
// inside the bundled binary (so a user gets the actionable rename message, not
// `error: unknown command 'install-skills'`) and that the rename description
// survives through `bun build --compile`.

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
  // cli.test.ts lives at servers/exarchos-mcp/src/adapters/, so the repo
  // root is four directories up. CodeRabbit #3 (#1213): use fileURLToPath
  // not URL().pathname — on Windows the latter yields `/C:/...` (leading
  // slash) which breaks path.resolve.
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
  );
  const candidate = path.join(repoRoot, 'dist', 'bin', `exarchos-${platform}-${arch}${ext}`);
  return fs.existsSync(candidate) ? candidate : null;
}

const SMOKE_BINARY = findHostBinary();

describe.skipIf(!SMOKE_BINARY)(
  'install-skills binary smoke (DR-5 rename stub)',
  () => {
    let homeTmp: string;
    let stateTmp: string;

    beforeEach(() => {
      homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-T18-home-'));
      stateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-T18-state-'));
    });

    afterEach(() => {
      // Best-effort cleanup. Errors are swallowed because the smoke test's
      // value is in the spawn assertion, not in tempdir hygiene; CI will
      // GC the runner anyway.
      try {
        fs.rmSync(homeTmp, { recursive: true, force: true });
        fs.rmSync(stateTmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it('cli_InstallSkillsBinary_HelpAgainstTempHome_ExitsZero', async () => {
      if (!SMOKE_BINARY) throw new Error('binary check should have skipped');
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(SMOKE_BINARY, ['install-skills', '--help'], {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, HOME: homeTmp, WORKFLOW_STATE_DIR: stateTmp },
      });
      // `--help` is a Commander built-in: exits 0 and prints the (rename-stub)
      // description, proving the verb is still registered in the bundled binary.
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('install-skills');
      expect(result.stdout.toLowerCase()).toContain('renamed');
      expect(result.stdout).toContain('onboard');
    });
  },
);

// ─── DR-7: top-level CLI promotion mechanism (CliActionHints.topLevel) ────────
//
// These tests exercise the GENERIC promotion mechanism + its collision guard
// over the REAL registry + CLI wiring (no hand-mocked registry): they stamp
// `cli.topLevel` onto a real registry action and assert `buildCli` hoists it to
// a top-level command that shares the subcommand's code path + Zod schema. The
// lifecycle-verb re-map (which actions actually declare `topLevel`) is a
// follow-on — this task ships only the mechanism.
describe('CLI top-level promotion (DR-7)', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  // Clone the REAL registry (getFullRegistry) and stamp `cli.topLevel` onto one
  // action. Everything else — the action's Zod schema, description, dispatch
  // wiring — stays the real thing, so the mechanism is proven against real
  // registry data, not a fabricated fixture.
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

  it('Promotion_TopLevelStamp_CommandRegisteredAndDispatches', async () => {
    // Arrange — promote the real `exarchos_view` `ps` action to top-level `ps`.
    const registry = registryWithTopLevel('exarchos_view', 'ps', 'ps');
    const program = buildCli(ctx, { registry });

    // Assert (registration) — a NEW top-level `ps` command exists alongside the
    // untouched `vw` tool group.
    const topLevelNames = program.commands.map((c) => c.name());
    expect(topLevelNames).toContain('ps');

    // Assert (same Zod schema) — the hoisted command's flag set is IDENTICAL to
    // the `vw ps` subcommand's, and carries the schema-derived `--probe` flag.
    const topLevelPs = program.commands.find((c) => c.name() === 'ps');
    const vwPs = program.commands
      .find((c) => c.name() === 'vw')
      ?.commands.find((c) => c.name() === 'ps');
    expect(topLevelPs, 'top-level ps not registered').toBeDefined();
    expect(vwPs, 'vw ps subcommand not registered').toBeDefined();
    const topLevelFlags = (topLevelPs?.options ?? []).map((o) => o.flags).sort();
    const subFlags = (vwPs?.options ?? []).map((o) => o.flags).sort();
    expect(topLevelFlags).toEqual(subFlags);
    expect(topLevelFlags.some((f) => f.includes('--probe'))).toBe(true);

    // Assert (same dispatch path) — running `exarchos ps` dispatches the SAME
    // tool + action the subcommand form would, through the shared handler.
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await program.parseAsync(['node', 'exarchos', 'ps']);
    stdoutSpy.mockRestore();

    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_view',
      expect.objectContaining({ action: 'ps' }),
      ctx,
    );
  });

  it('Promotion_CollidingName_FailsRegistrationNotRuntime', () => {
    // A `topLevel` that collides with an existing top-level command must fail at
    // REGISTRATION (build time) — the throw happens inside `buildCli`, before any
    // argv is parsed or any command action runs. `wf` is the workflow tool
    // group's top-level name.
    const collideName = registryWithTopLevel('exarchos_view', 'ps', 'wf');
    expect(() => buildCli(ctx, { registry: collideName })).toThrow(
      /topLevel 'wf'.*collides with the existing top-level command 'wf'/,
    );

    // The guard also catches a clash with a top-level command's ALIAS, not just
    // its primary name: `workflow` is registered as an alias of `wf`.
    const collideAlias = registryWithTopLevel('exarchos_view', 'ps', 'workflow');
    expect(() => buildCli(ctx, { registry: collideAlias })).toThrow(
      /topLevel 'workflow'.*collides with the existing top-level command/,
    );

    // Guard specificity: a non-colliding name must NOT throw (proves the guard
    // rejects clashes, not every promotion).
    const noCollide = registryWithTopLevel('exarchos_view', 'ps', 'ps');
    expect(() => buildCli(ctx, { registry: noCollide })).not.toThrow();

    // Dispatch was never invoked — the failure is at registration, not runtime.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('Promotion_SubcommandForm_StillWorks', async () => {
    // Promoting an action to top-level must NOT disturb its `<tool> <action>`
    // subcommand form: `vw ps` still registers and still dispatches.
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
      ctx,
    );
  });
});
