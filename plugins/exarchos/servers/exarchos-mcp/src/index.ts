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
} from './workflow/tools.js';
import type { ToolResult } from './workflow/tools.js';
import {
  handleEventAppend,
  handleEventQuery,
} from './event-store/tools.js';
import {
  handleViewWorkflowStatus,
  handleViewTeamStatus,
  handleViewTasks,
  handleViewPipeline,
} from './views/tools.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SERVER_NAME = 'exarchos-mcp';
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

// ─── Stub Tool Result ───────────────────────────────────────────────────────

function stubResult() {
  return formatResult({
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Coming soon' },
  });
}

// ─── Server Factory ──────────────────────────────────────────────────────────

export function createServer(stateDir: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ─── Workflow Tools (10) ────────────────────────────────────────────

  // ─── exarchos_workflow_init ──────────────────────────────────────────
  server.tool(
    'exarchos_workflow_init',
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

  // ─── exarchos_workflow_list ──────────────────────────────────────────
  server.tool(
    'exarchos_workflow_list',
    'List all active workflow state files with staleness information',
    {},
    async (args) => {
      const result = await handleList(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── exarchos_workflow_get ───────────────────────────────────────────
  server.tool(
    'exarchos_workflow_get',
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

  // ─── exarchos_workflow_set ───────────────────────────────────────────
  server.tool(
    'exarchos_workflow_set',
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

  // ─── exarchos_workflow_summary ───────────────────────────────────────
  server.tool(
    'exarchos_workflow_summary',
    'Get structured summary of workflow progress, events, and circuit breaker status',
    {
      featureId: featureIdParam,
    },
    async (args) => {
      const result = await handleSummary(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── exarchos_workflow_reconcile ─────────────────────────────────────
  server.tool(
    'exarchos_workflow_reconcile',
    'Verify worktree paths and branches match state file',
    {
      featureId: featureIdParam,
    },
    async (args) => {
      const result = await handleReconcile(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── exarchos_workflow_next_action ───────────────────────────────────
  server.tool(
    'exarchos_workflow_next_action',
    'Determine the next auto-continue action based on current phase and guards',
    {
      featureId: featureIdParam,
    },
    async (args) => {
      const result = await handleNextAction(args, stateDir);
      return formatResult(result);
    },
  );

  // ─── exarchos_workflow_transitions ───────────────────────────────────
  server.tool(
    'exarchos_workflow_transitions',
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

  // ─── exarchos_workflow_cancel ────────────────────────────────────────
  server.tool(
    'exarchos_workflow_cancel',
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

  // ─── exarchos_workflow_checkpoint ────────────────────────────────────
  server.tool(
    'exarchos_workflow_checkpoint',
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

  // ─── Event Store Tools (2) ──────────────────────────────────────────

  // ─── exarchos_event_append ────────────────────────────────────────
  server.tool(
    'exarchos_event_append',
    'Append an event to the event store with optional optimistic concurrency',
    {
      stream: z.string().min(1),
      event: z.record(z.string(), z.unknown()),
      expectedSequence: z.number().int().optional(),
    },
    async (args) => {
      const result = await handleEventAppend(args, stateDir);
      return formatResult(result as ToolResult);
    },
  );

  // ─── exarchos_event_query ─────────────────────────────────────────
  server.tool(
    'exarchos_event_query',
    'Query events from the event store with optional filters (type, sinceSequence, since, until)',
    {
      stream: z.string().min(1),
      filter: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      const result = await handleEventQuery(args, stateDir);
      return formatResult(result as ToolResult);
    },
  );

  // ─── View Tools (4) ────────────────────────────────────────────────

  // ─── exarchos_view_pipeline ─────────────────────────────────────────
  server.tool(
    'exarchos_view_pipeline',
    'Get CQRS pipeline view aggregating all workflows with stack positions and phase tracking',
    {},
    async (args) => {
      const result = await handleViewPipeline(args, stateDir);
      return formatResult(result as ToolResult);
    },
  );

  // ─── exarchos_view_tasks ────────────────────────────────────────────
  server.tool(
    'exarchos_view_tasks',
    'Get CQRS task detail view with optional filtering by workflowId and task properties',
    {
      workflowId: z.string().optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => {
      const result = await handleViewTasks(args, stateDir);
      return formatResult(result as ToolResult);
    },
  );

  // ─── exarchos_view_workflow_status ──────────────────────────────────
  server.tool(
    'exarchos_view_workflow_status',
    'Get CQRS workflow status view with phase, task counts, and feature metadata',
    { workflowId: z.string().optional() },
    async (args) => {
      const result = await handleViewWorkflowStatus(args, stateDir);
      return formatResult(result as ToolResult);
    },
  );

  // ─── exarchos_view_team_status ─────────────────────────────────────
  server.tool(
    'exarchos_view_team_status',
    'Get CQRS team status view with teammate composition and current task assignments',
    { workflowId: z.string().optional() },
    async (args) => {
      const result = await handleViewTeamStatus(args, stateDir);
      return formatResult(result as ToolResult);
    },
  );

  // ─── Stub Tools (11) ─────────────────────────────────────────────

  // Team
  server.tool(
    'exarchos_team_spawn',
    'Spawn a new team member agent',
    { role: z.string(), config: z.record(z.string(), z.unknown()).optional() },
    async () => stubResult(),
  );

  server.tool(
    'exarchos_team_message',
    'Send a message to a team member',
    { agentId: z.string(), message: z.string() },
    async () => stubResult(),
  );

  server.tool(
    'exarchos_team_broadcast',
    'Broadcast a message to all team members',
    { message: z.string() },
    async () => stubResult(),
  );

  server.tool(
    'exarchos_team_shutdown',
    'Shutdown a team member agent',
    { agentId: z.string() },
    async () => stubResult(),
  );

  server.tool(
    'exarchos_team_status',
    'Get status of all team members',
    {},
    async () => stubResult(),
  );

  // Tasks
  server.tool(
    'exarchos_task_claim',
    'Claim a task for execution',
    { taskId: z.string() },
    async () => stubResult(),
  );

  server.tool(
    'exarchos_task_complete',
    'Mark a task as complete',
    { taskId: z.string(), result: z.record(z.string(), z.unknown()).optional() },
    async () => stubResult(),
  );

  server.tool(
    'exarchos_task_fail',
    'Mark a task as failed',
    { taskId: z.string(), error: z.string() },
    async () => stubResult(),
  );

  // Stack
  server.tool(
    'exarchos_stack_status',
    'Get current stack status',
    {},
    async () => stubResult(),
  );

  server.tool(
    'exarchos_stack_place',
    'Place an item on the stack',
    { item: z.record(z.string(), z.unknown()) },
    async () => stubResult(),
  );

  // Sync
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
