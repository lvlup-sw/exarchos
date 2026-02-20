#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { TOOL_REGISTRY, buildRegistrationSchema, buildToolDescription } from './registry.js';
import { formatResult, type ToolResult } from './format.js';

// Composite handlers
import { handleWorkflow } from './workflow/composite.js';
import { handleEvent } from './event-store/composite.js';
import { handleOrchestrate } from './orchestrate/composite.js';
import { handleView } from './views/composite.js';
import { handleSync } from './sync/composite.js';

// EventStore configuration — workflow modules require explicit injection
// (non-workflow modules use lazy init via getStore())
import { configureWorkflowEventStore } from './workflow/tools.js';
import { configureNextActionEventStore } from './workflow/next-action.js';
import { configureCancelEventStore } from './workflow/cancel.js';
import { configureCleanupEventStore, configureCleanupSnapshotStore } from './workflow/cleanup.js';
import { configureQueryEventStore } from './workflow/query.js';
import { EventStore } from './event-store/store.js';
import { SnapshotStore } from './views/snapshot-store.js';

// Telemetry middleware
import { withTelemetry } from './telemetry/middleware.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'exarchos-mcp';
export const SERVER_VERSION = '1.0.0';

// ─── Composite Handler Map ──────────────────────────────────────────────────

type CompositeHandler = (
  args: Record<string, unknown>,
  stateDir: string,
) => Promise<ToolResult>;

const COMPOSITE_HANDLERS: Readonly<Record<string, CompositeHandler>> = {
  exarchos_workflow: handleWorkflow,
  exarchos_event: handleEvent,
  exarchos_orchestrate: handleOrchestrate,
  exarchos_view: handleView,
  exarchos_sync: handleSync,
};

// ─── Server Factory ──────────────────────────────────────────────────────────

export function createServer(stateDir: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const eventStore = new EventStore(stateDir);

  // Configure module-level EventStore for workflow modules (no lazy init)
  configureWorkflowEventStore(eventStore);
  configureNextActionEventStore(eventStore);
  configureCancelEventStore(eventStore);
  configureCleanupEventStore(eventStore);
  configureCleanupSnapshotStore(new SnapshotStore(stateDir));
  configureQueryEventStore(eventStore);

  // Register composite tools from registry
  const enableTelemetry = process.env.EXARCHOS_TELEMETRY !== 'false';

  for (const tool of TOOL_REGISTRY) {
    const handler = COMPOSITE_HANDLERS[tool.name];
    if (!handler) continue;

    const inputSchema = buildRegistrationSchema(tool.actions);
    const description = buildToolDescription(tool);

    const baseHandler = async (args: Record<string, unknown>) =>
      formatResult(await handler(args, stateDir));

    // Use registerTool() so the strict ZodObject is passed as inputSchema
    // directly, preserving .strict() validation that rejects unrecognized keys.
    // The server.tool() overload treats ZodObjects as annotations, not schemas.
    server.registerTool(
      tool.name,
      { description, inputSchema },
      enableTelemetry
        ? withTelemetry(baseHandler, tool.name, eventStore)
        : baseHandler,
    );
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
