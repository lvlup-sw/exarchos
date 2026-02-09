#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'node:path';
import {
  handleInit,
  handleList,
  handleGet,
  handleSet,
  handleSummary,
  handleReconcile,
  handleNextAction,
  handleTransitions,
  handleCancel,
  handleCheckpoint,
} from './tools.js';
import type { ToolResult } from './tools.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'workflow-state-mcp';
export const SERVER_VERSION = '1.0.0';

// ─── Shared Schema Components ────────────────────────────────────────────────

const featureIdParam = z.string().min(1).regex(/^[a-z0-9-]+$/);
const workflowTypeParam = z.enum(['feature', 'debug', 'refactor']);

// ─── Tool Result Formatting ─────────────────────────────────────────────────

function formatResult(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: !result.success,
  };
}

// ─── Server Factory ──────────────────────────────────────────────────────────

export function createServer(stateDir: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ─── workflow_init ─────────────────────────────────────────────────
  server.tool(
    'workflow_init',
    'Initialize a new workflow state file for a feature/debug/refactor workflow',
    {
      featureId: featureIdParam,
      workflowType: workflowTypeParam,
    },
    async (args) => {
      const result = await handleInit(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── workflow_list ─────────────────────────────────────────────────
  server.tool(
    'workflow_list',
    'List all active workflow state files with staleness information',
    {},
    async (args) => {
      const result = await handleList(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── workflow_get ──────────────────────────────────────────────────
  server.tool(
    'workflow_get',
    'Query a field via dot-path (e.g. query:"phase") or get full state if no query',
    {
      featureId: featureIdParam,
      query: z.string().optional(),
    },
    async (args) => {
      const result = await handleGet(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── workflow_set ──────────────────────────────────────────────────
  server.tool(
    'workflow_set',
    'Update fields and/or transition phase. Returns {phase, updatedAt}',
    {
      featureId: featureIdParam,
      updates: z.record(z.string(), z.unknown()).optional(),
      phase: z.string().optional(),
    },
    async (args) => {
      const result = await handleSet(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── workflow_summary ──────────────────────────────────────────────
  server.tool(
    'workflow_summary',
    'Get structured summary of workflow progress, events, and circuit breaker status',
    {
      featureId: featureIdParam,
    },
    async (args) => {
      const result = await handleSummary(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── workflow_reconcile ────────────────────────────────────────────
  server.tool(
    'workflow_reconcile',
    'Validate state file schema, verify worktree paths, and optionally repair common corruption patterns. Returns structured issues array.',
    {
      featureId: featureIdParam,
      repair: z.boolean().optional(),
    },
    async (args) => {
      const result = await handleReconcile({ ...args, repair: args.repair ?? false }, stateDir);
      return formatResult(result);
    },
  );

  // ─── workflow_next_action ──────────────────────────────────────────
  server.tool(
    'workflow_next_action',
    'Determine the next auto-continue action based on current phase and guards',
    {
      featureId: featureIdParam,
    },
    async (args) => {
      const result = await handleNextAction(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── workflow_transitions ──────────────────────────────────────────
  server.tool(
    'workflow_transitions',
    'Get available state machine transitions for a workflow type',
    {
      workflowType: workflowTypeParam,
      fromPhase: z.string().optional(),
    },
    async (args) => {
      const result = await handleTransitions(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── workflow_cancel ───────────────────────────────────────────────
  server.tool(
    'workflow_cancel',
    'Cancel a workflow with saga compensation and cleanup',
    {
      featureId: featureIdParam,
      reason: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const result = await handleCancel(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── workflow_checkpoint ───────────────────────────────────────────
  server.tool(
    'workflow_checkpoint',
    'Create an explicit checkpoint, resetting the operation counter',
    {
      featureId: featureIdParam,
      summary: z.string().optional(),
    },
    async (args) => {
      const result = await handleCheckpoint(args, stateDir);
      return formatResult(result);
    },
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
