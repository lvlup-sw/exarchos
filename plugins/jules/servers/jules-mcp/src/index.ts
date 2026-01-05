#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { JulesClient } from './jules-client.js';
import { createJulesTools, toolDescriptions } from './tools.js';

// Validate required environment variable
const apiKey = process.env.JULES_API_KEY;
if (!apiKey) {
  console.error('Error: JULES_API_KEY environment variable is required');
  console.error('Get your API key at https://jules.google/settings');
  process.exit(1);
}

// Initialize client and tools
const client = new JulesClient(apiKey);
const tools = createJulesTools(client);

// Create MCP server
const server = new McpServer({
  name: 'jules-mcp',
  version: '1.0.0'
});

// Register jules_list_sources tool
server.tool(
  'jules_list_sources',
  toolDescriptions.jules_list_sources,
  {},
  async () => {
    const result = await tools.jules_list_sources({});
    return {
      content: result.content,
      isError: result.isError
    };
  }
);

// Register jules_create_task tool
server.tool(
  'jules_create_task',
  toolDescriptions.jules_create_task,
  {
    repo: z.string().describe('GitHub repository in owner/repo format'),
    prompt: z.string().describe('Task description for Jules to execute'),
    branch: z
      .string()
      .optional()
      .describe('Branch to work on (default: main)'),
    title: z.string().optional().describe('Optional title for the session')
  },
  async (args) => {
    const result = await tools.jules_create_task({
      repo: args.repo,
      prompt: args.prompt,
      branch: args.branch ?? 'main',
      title: args.title
    });
    return {
      content: result.content,
      isError: result.isError
    };
  }
);

// Register jules_check_status tool
server.tool(
  'jules_check_status',
  toolDescriptions.jules_check_status,
  {
    sessionId: z.string().describe('The Jules session ID to check')
  },
  async (args) => {
    const result = await tools.jules_check_status({
      sessionId: args.sessionId
    });
    return {
      content: result.content,
      isError: result.isError
    };
  }
);

// Register jules_approve_plan tool
server.tool(
  'jules_approve_plan',
  toolDescriptions.jules_approve_plan,
  {
    sessionId: z
      .string()
      .describe('The Jules session ID with a pending plan to approve')
  },
  async (args) => {
    const result = await tools.jules_approve_plan({
      sessionId: args.sessionId
    });
    return {
      content: result.content,
      isError: result.isError
    };
  }
);

// Register jules_send_feedback tool
server.tool(
  'jules_send_feedback',
  toolDescriptions.jules_send_feedback,
  {
    sessionId: z.string().describe('The Jules session ID'),
    message: z.string().describe('Feedback or instructions to send to Jules')
  },
  async (args) => {
    const result = await tools.jules_send_feedback({
      sessionId: args.sessionId,
      message: args.message
    });
    return {
      content: result.content,
      isError: result.isError
    };
  }
);

// Register jules_cancel tool
server.tool(
  'jules_cancel',
  toolDescriptions.jules_cancel,
  {
    sessionId: z.string().describe('The Jules session ID to cancel')
  },
  async (args) => {
    const result = await tools.jules_cancel({
      sessionId: args.sessionId
    });
    return {
      content: result.content,
      isError: result.isError
    };
  }
);

// Register jules_get_conversation tool
server.tool(
  'jules_get_conversation',
  toolDescriptions.jules_get_conversation,
  {
    sessionId: z.string().describe('The Jules session ID'),
    limit: z
      .number()
      .optional()
      .describe('Maximum number of activities to return (default: 50)')
  },
  async (args) => {
    const result = await tools.jules_get_conversation({
      sessionId: args.sessionId,
      limit: args.limit ?? 50
    });
    return {
      content: result.content,
      isError: result.isError
    };
  }
);

// Register jules_get_pending_question tool
server.tool(
  'jules_get_pending_question',
  toolDescriptions.jules_get_pending_question,
  {
    sessionId: z.string().describe('The Jules session ID')
  },
  async (args) => {
    const result = await tools.jules_get_pending_question({
      sessionId: args.sessionId
    });
    return {
      content: result.content,
      isError: result.isError
    };
  }
);

// Connect to stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
