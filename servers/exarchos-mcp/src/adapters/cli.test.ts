import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    // Assert — all 5 tools should be registered (with exarchos_ prefix stripped)
    expect(commandNames).toContain('workflow');
    expect(commandNames).toContain('event');
    expect(commandNames).toContain('orchestrate');
    expect(commandNames).toContain('view');
    expect(commandNames).toContain('sync');
  });

  it('BuildCli_GeneratesActionSubcommands', () => {
    // Arrange & Act
    const program = buildCli(ctx);
    const workflowCmd = program.commands.find((c) => c.name() === 'workflow');
    const actionNames = workflowCmd?.commands.map((c) => c.name()) ?? [];

    // Assert — workflow actions
    expect(actionNames).toContain('init');
    expect(actionNames).toContain('get');
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

    // Act — parse a workflow init command
    await program.parseAsync([
      'node',
      'exarchos',
      'workflow',
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

    // Act — parse with --json flag
    await program.parseAsync([
      'node',
      'exarchos',
      'workflow',
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
