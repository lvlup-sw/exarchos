#!/usr/bin/env node
/**
 * A minimal mock MCP server for the harness self-tests. It runs on stdio, so it pairs with
 * `StdioClientTransport`. Its one tool, `echo`, returns `echo:<message>` in a text content
 * block.
 *
 * The fixture isolates `spawnMcpClient` from the real `exarchos` binary. A caller passes
 * `{ command: 'node', args: [<path of this script>] }`.
 *
 * The server comes from the v2 SDK, the same generation as the client in `../mcp-client.ts`.
 * A pair of different generations hangs.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer(
  { name: 'mock-mcp-server', version: '0.0.0' },
  { capabilities: {} },
);

server.registerTool(
  'echo',
  {
    description: 'Echoes back the provided message.',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `echo:${message}` }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
