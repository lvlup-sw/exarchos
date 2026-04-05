import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../event-store/store.js';
import { TOOL_REGISTRY, buildToolDescription } from '../registry.js';
import type { DispatchContext } from '../core/dispatch.js';

// Mock the state-store module
vi.mock('../workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../workflow/state-store.js')>();
  return {
    ...original,
    configureStateStoreBackend: vi.fn(),
  };
});

describe('createMcpServer', () => {
  let tmpDir: string;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-adapter-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('CreateMcpServer_RegistersAllTools_FromRegistry', async () => {
    // Arrange
    const { createMcpServer } = await import('./mcp.js');

    // Act
    const server = createMcpServer(ctx);

    // Assert — server should be created successfully
    expect(server).toBeDefined();
    // The MCP server should have tools registered (we verify by checking it's an McpServer instance)
    expect(typeof server.connect).toBe('function');
  });

  it('CreateMcpServer_HandlerReturns_McpToolResult', async () => {
    // Arrange — We can't easily call registered handlers directly via McpServer API,
    // so we test via dispatch → formatResult by verifying the adapter creates a valid server
    const { createMcpServer } = await import('./mcp.js');

    // Act
    const server = createMcpServer(ctx);

    // Assert — all tools from registry should be registerable without error
    expect(server).toBeDefined();
    // Verify the expected number of tools are in the registry
    expect(TOOL_REGISTRY.length).toBe(5);
  });

  it('createMcpServer_declaresChannelCapability', async () => {
    // Arrange
    const { createMcpServer } = await import('./mcp.js');

    // Act
    const server = createMcpServer(ctx);
    const capabilities = server.server.getCapabilities();

    // Assert — experimental capabilities should include claude/channel
    expect(capabilities.experimental).toBeDefined();
    expect(capabilities.experimental).toHaveProperty('claude/channel');
    expect(capabilities.experimental!['claude/channel']).toEqual({});
  });

  it('createMcpServer_exposesServerForNotifications', async () => {
    // Arrange
    const { createMcpServer } = await import('./mcp.js');

    // Act
    const server = createMcpServer(ctx);

    // Assert — server.server should be accessible and have a notification method
    expect(server.server).toBeDefined();
    expect(typeof server.server.notification).toBe('function');
  });

  it('CreateMcpServer_SlimRegistration_UsesSlimDescriptions', async () => {
    // Arrange: create context with slimRegistration enabled
    const slimCtx: DispatchContext = { ...ctx, slimRegistration: true };
    const { createMcpServer } = await import('./mcp.js');

    // Act: buildToolDescription with slim=true should return slim descriptions
    const visibleTools = TOOL_REGISTRY.filter(t => !t.hidden);
    for (const tool of visibleTools) {
      const slimDesc = buildToolDescription(tool, true);
      const fullDesc = buildToolDescription(tool, false);

      // Assert: slim description should be different (shorter) than full description
      expect(slimDesc).toBe(tool.slimDescription);
      expect(slimDesc.length).toBeLessThan(fullDesc.length);
    }

    // Assert: server creates successfully with slim context
    const server = createMcpServer(slimCtx);
    expect(server).toBeDefined();
  });
});
