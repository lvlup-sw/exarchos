#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { formatResult, stubResult, type ToolResult } from './format.js';
import { configureWorkflowEventStore } from './workflow/tools.js';
import { configureNextActionEventStore } from './workflow/next-action.js';
import { configureCancelEventStore } from './workflow/cancel.js';
import { configureQueryEventStore } from './workflow/query.js';
import { EventStore } from './event-store/store.js';
import { TOOL_REGISTRY } from './registry.js';
import { handleWorkflow } from './workflow/composite.js';
import { handleEvent } from './event-store/composite.js';
import { handleOrchestrate } from './orchestrate/composite.js';
import { handleView } from './views/composite.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'exarchos-mcp';
export const SERVER_VERSION = '1.0.0';

// ─── Composite Handler Map ──────────────────────────────────────────────────

type CompositeHandler = (args: Record<string, unknown>, stateDir: string) => Promise<ToolResult>;

const COMPOSITE_HANDLERS: Readonly<Record<string, CompositeHandler>> = {
  exarchos_workflow: handleWorkflow,
  exarchos_event: handleEvent,
  exarchos_orchestrate: handleOrchestrate,
  exarchos_view: handleView,
};

// ─── Server Factory ──────────────────────────────────────────────────────────

export function createServer(stateDir: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const eventStore = new EventStore(stateDir);

  // Configure module-level EventStore instances before registration
  configureWorkflowEventStore(eventStore);
  configureNextActionEventStore(eventStore);
  configureCancelEventStore(eventStore);
  configureQueryEventStore(eventStore);

  // Register composite tools from the registry
  for (const composite of TOOL_REGISTRY) {
    const handler = COMPOSITE_HANDLERS[composite.name];

    if (handler) {
      // Real composite — route through the composite handler
      server.tool(
        composite.name,
        composite.description,
        { action: z.string(), ...Object.fromEntries(
          // Collect all possible fields from all actions as optional z.unknown()
          // so the SDK schema passes through all args to the handler
          composite.actions.flatMap((a) =>
            Object.keys(a.schema.shape).map((k) => [k, z.unknown().optional()]),
          ),
        ) },
        async (args) => formatResult(await handler(args as Record<string, unknown>, stateDir)),
      );
    } else {
      // Stub composite (exarchos_sync) — return NOT_IMPLEMENTED for any action
      server.tool(
        composite.name,
        composite.description,
        { action: z.string() },
        async () => stubResult(),
      );
    }
  }

  return server;
}

// ─── State Directory Resolution ──────────────────────────────────────────────

export async function resolveStateDir(): Promise<string> {
  if (process.env.WORKFLOW_STATE_DIR) {
    return process.env.WORKFLOW_STATE_DIR;
  }

  return path.join(homedir(), '.claude', 'workflow-state');
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
