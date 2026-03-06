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
