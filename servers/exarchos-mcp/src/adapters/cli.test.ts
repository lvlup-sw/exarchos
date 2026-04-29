import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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

// Mock cli-format to avoid real stdout writes
vi.mock('./cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
}));

// Mock schema-introspection
vi.mock('./schema-introspection.js', () => ({
  listSchemas: vi.fn(() => [
    {
      tool: 'exarchos_workflow',
      actions: [
        { name: 'init', description: 'Initialize a new workflow' },
        { name: 'get', description: 'Read workflow state' },
      ],
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

import { buildCli, commanderErrorToResult, CLI_EXIT_CODES } from './cli.js';
import { dispatch } from '../core/dispatch.js';
import { TOOL_REGISTRY } from '../registry.js';
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
    expect(actionNames).toContain('init');
    expect(actionNames).toContain('status');
    expect(actionNames).toContain('set');
    expect(actionNames).toContain('cancel');
    expect(actionNames).toContain('cleanup');
    expect(actionNames).toContain('reconcile');
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

    // Assert — stdout should get raw JSON
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('"success":true'),
    );

    stdoutSpy.mockRestore();
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

// ─── Task 25: Init Scaffolding Command ────────────────────────────────────────

describe('init command', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
  });

  it('InitCommand_DispatchesOrchestrate', async () => {
    // The new init command routes through exarchos_orchestrate { action: 'init' }
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init']);

    // Assert — dispatch was called with the init action
    const { dispatch } = await import('../core/dispatch.js');
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({ action: 'init' }),
      expect.anything(),
    );

    stdoutSpy.mockRestore();
  });

  it('InitCommand_WithRuntimeFlag_PassesToDispatch', async () => {
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init', '--runtime', 'copilot']);

    const { dispatch } = await import('../core/dispatch.js');
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({ action: 'init', runtime: 'copilot' }),
      expect.anything(),
    );

    stdoutSpy.mockRestore();
  });

  it('InitCommand_SuccessResult_ExitsZero', async () => {
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init']);

    // dispatch mock returns success, so exitCode should be 0 (or undefined)
    expect(process.exitCode ?? 0).toBe(0);

    stdoutSpy.mockRestore();
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

    // Assert — exit 0 (success) and raw ToolResult JSON on stdout
    expect(process.exitCode ?? 0).toBe(0);

    const stdoutText = stdoutSpy.mock.calls.map(([s]) => s).join('');
    const parsed = JSON.parse(stdoutText.trim());
    expect(parsed).toEqual({
      success: true,
      data: { featureId: 'test-feature', phase: 'init' },
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
    for (const code of ['commander.helpDisplayed', 'commander.version']) {
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
});

// ─── #1201: install-skills Commander subcommand ─────────────────────────────
//
// Asserts that `exarchos install-skills --agent <name>` is registered on the
// CLI program and that the action handler calls `installSkills()` from the
// root `src/install-skills.ts` module with the runtime maps loaded from the
// embedded codegen module. The installer is stubbed so no spawn/IO happens.

const installSkillsMock =
  vi.fn<(opts: Record<string, unknown>) => Promise<void>>();

vi.mock('../../../../src/install-skills.js', () => ({
  installSkills: (opts: Record<string, unknown>) => installSkillsMock(opts),
}));

vi.mock('../../../../src/runtimes/embedded.js', () => ({
  loadEmbeddedRuntimes: () => ({
    claude: { name: 'claude', skillsInstallPath: '~/.claude/skills' },
    generic: { name: 'generic', skillsInstallPath: '~/.agents/skills' },
  }),
}));

describe('install-skills subcommand', () => {
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    installSkillsMock.mockResolvedValue();
    ctx = createTestContext();
  });

  it('cli_InstallSkillsSubcommand_DispatchesToInstaller', async () => {
    const program = buildCli(ctx);

    await program.parseAsync([
      'node',
      'exarchos',
      'install-skills',
      '--agent',
      'claude',
    ]);

    expect(installSkillsMock).toHaveBeenCalledTimes(1);
    const call = installSkillsMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call).toBeDefined();
    expect(call?.agent).toBe('claude');
    // Handler must pass the embedded runtime maps to the installer so the
    // resolved `claude` runtime is reachable without re-loading YAML at
    // user-install time.
    const runtimes = call?.runtimes as Array<{ name: string }> | undefined;
    expect(runtimes).toBeDefined();
    expect(runtimes?.some((r) => r.name === 'claude')).toBe(true);
  });
});
