#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'node:path';
import { stubResult } from './format.js';
import { registerWorkflowTools, configureWorkflowEventStore } from './workflow/tools.js';
import { registerNextActionTool, configureNextActionEventStore } from './workflow/next-action.js';
import { registerCancelTool, configureCancelEventStore } from './workflow/cancel.js';
import { registerQueryTools, configureQueryEventStore } from './workflow/query.js';
import { registerEventTools } from './event-store/tools.js';
import { EventStore } from './event-store/store.js';
import { registerViewTools } from './views/tools.js';
import { registerTeamTools } from './team/tools.js';
import { registerTaskTools } from './tasks/tools.js';
import { registerStackTools } from './stack/tools.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'exarchos-mcp';
export const SERVER_VERSION = '1.0.0';

// ─── Server Factory ──────────────────────────────────────────────────────────

export function createServer(stateDir: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const eventStore = new EventStore(stateDir);

  // Configure module-level EventStore instances before registration
  configureWorkflowEventStore(eventStore);
  configureNextActionEventStore(eventStore);
  configureCancelEventStore(eventStore);
  configureQueryEventStore(eventStore);

  // Register all tool modules
  registerWorkflowTools(server, stateDir);
  registerNextActionTool(server, stateDir);
  registerCancelTool(server, stateDir);
  registerQueryTools(server, stateDir);
  registerEventTools(server, stateDir, eventStore);
  registerViewTools(server, stateDir, eventStore);
  registerTeamTools(server, stateDir, eventStore);
  registerTaskTools(server, stateDir, eventStore);
  registerStackTools(server, stateDir, eventStore);

  // Stub tools
  server.tool(
    'exarchos_sync_now',
    'Trigger immediate sync with remote',
    {},
    async () => stubResult(),
  );

  return server;
}

// ─── State Directory Resolution ──────────────────────────────────────────────

export async function resolveStateDir(): Promise<string> {
  if (process.env.WORKFLOW_STATE_DIR) {
    return process.env.WORKFLOW_STATE_DIR;
  }

  try {
    const { execSync } = await import('node:child_process');
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    return path.join(gitRoot, 'docs', 'workflow-state');
  } catch {
    return path.join(process.cwd(), 'docs', 'workflow-state');
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function main() {
  const stateDir = await resolveStateDir();
  const server = createServer(stateDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run main when executed directly (not when imported for testing)
const isDirectExecution =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].replace(/\.ts$/, '.js')));

if (isDirectExecution) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
