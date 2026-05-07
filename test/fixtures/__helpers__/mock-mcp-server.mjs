#!/usr/bin/env node
/**
 * Minimal mock MCP server for harness self-tests.
 *
 * Registers a single `echo` tool that returns its input string wrapped in a
 * text content block. Runs on stdio so it pairs with StdioClientTransport.
 *
 * This fixture isolates spawnMcpClient's behavior from the real
 * `exarchos-mcp` binary — callers point spawnMcpClient at this script via
 * `{ command: 'node', args: ['test/fixtures/__helpers__/mock-mcp-server.mjs'] }`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
