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

import { buildCli } from './cli.js';
import { dispatch } from '../core/dispatch.js';
import { TOOL_REGISTRY } from '../registry.js';
import type { DispatchContext } from '../core/dispatch.js';

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
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-cli-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('InitCommand_CreatesConfigFile', async () => {
    // Arrange
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'init']);

    // Assert — file created with template content
    const configPath = path.join(tmpDir, 'exarchos.config.ts');
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('defineConfig');
    expect(content).toContain('@lvlup-sw/exarchos');
    expect(content).toContain('workflows');

    stdoutSpy.mockRestore();
  });

  it('InitCommand_ConfigExists_DoesNotOverwrite', async () => {
    // Arrange — create existing config
    const configPath = path.join(tmpDir, 'exarchos.config.ts');
    fs.writeFileSync(configPath, 'existing content');
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'init']);

    // Assert — file not overwritten
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toBe('existing content');

    // Assert — warning was printed
    const output = [
      ...stderrSpy.mock.calls.map(([s]) => s),
      ...stdoutSpy.mock.calls.map(([s]) => s),
    ].join('');
    expect(output).toContain('already exists');

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('InitCommand_PrintsGettingStarted', async () => {
    // Arrange
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'init']);

    // Assert — getting-started instructions printed
    const output = stdoutSpy.mock.calls.map(([s]) => s).join('');
    expect(output).toContain('exarchos.config.ts');

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
