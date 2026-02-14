// ─── Team MCP Tool Handlers ─────────────────────────────────────────────────

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventStore } from '../event-store/store.js';
import { TeamCoordinator } from './coordinator.js';
import { ROLES } from './roles.js';
import { formatResult, type ToolResult } from '../format.js';

// ─── Module-Level EventStore (injected via registerTeamTools) ────────────────

let moduleEventStore: EventStore | null = null;
const coordinatorCache = new Map<string, TeamCoordinator>();

function getStore(stateDir: string): EventStore {
  if (!moduleEventStore) {
    moduleEventStore = new EventStore(stateDir);
  }
  return moduleEventStore;
}

/** For testing: reset the module-level EventStore and coordinator cache */
export function resetModuleEventStore(): void {
  moduleEventStore = null;
  coordinatorCache.clear();
}

function getCoordinator(stateDir: string): TeamCoordinator {
  let coordinator = coordinatorCache.get(stateDir);
  if (!coordinator) {
    const store = getStore(stateDir);
    coordinator = new TeamCoordinator(store, {
      maxTeammates: 10,
      stateDir,
    });
    coordinatorCache.set(stateDir, coordinator);
  }
  return coordinator;
}

// ─── handleTeamSpawn ───────────────────────────────────────────────────────

export async function handleTeamSpawn(
  args: {
    name: string;
    role: string;
    taskId: string;
    taskTitle: string;
    streamId: string;
    worktreePath?: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  // Guard clauses: validate required string arguments
  for (const field of ['name', 'taskId', 'taskTitle', 'streamId'] as const) {
    if (!args[field] || typeof args[field] !== 'string' || args[field].trim() === '') {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Field "${field}" is required and must be a non-empty string`,
        },
      };
    }
  }

  const role = ROLES[args.role];
  if (!role) {
    return {
      success: false,
      error: {
        code: 'INVALID_ROLE',
        message: `Unknown role '${args.role}'. Available: ${Object.keys(ROLES).join(', ')}`,
      },
    };
  }

  const coordinator = getCoordinator(stateDir);

  try {
    const info = await coordinator.spawn(
      args.name,
      role,
      { taskId: args.taskId, title: args.taskTitle },
      args.streamId,
      args.worktreePath,
    );

    return { success: true, data: info };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'SPAWN_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── handleTeamMessage ────────────────────────────────────────────────────

export async function handleTeamMessage(
  args: {
    from: string;
    to: string;
    content: string;
    streamId: string;
    messageType?: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  // Guard clauses: validate required string arguments
  if (!args.from || typeof args.from !== 'string' || args.from.trim() === '') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Field "from" is required and must be a non-empty string',
      },
    };
  }

  if (!args.to || typeof args.to !== 'string' || args.to.trim() === '') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Field "to" is required and must be a non-empty string',
      },
    };
  }

  if (!args.content || typeof args.content !== 'string' || args.content.trim() === '') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Field "content" is required and must be a non-empty string',
      },
    };
  }

  if (!args.streamId || typeof args.streamId !== 'string' || args.streamId.trim() === '') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'streamId is required',
      },
    };
  }

  const coordinator = getCoordinator(stateDir);

  try {
    await coordinator.sendMessage(args.from, args.to, args.content, args.streamId, args.messageType);
    return { success: true, data: { sent: true } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'MESSAGE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── handleTeamBroadcast ──────────────────────────────────────────────────

export async function handleTeamBroadcast(
  args: {
    from: string;
    content: string;
    streamId: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  // Guard clauses: validate required string arguments
  if (!args.from || typeof args.from !== 'string' || args.from.trim() === '') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Field "from" is required and must be a non-empty string',
      },
    };
  }

  if (!args.content || typeof args.content !== 'string' || args.content.trim() === '') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Field "content" is required and must be a non-empty string',
      },
    };
  }

  if (!args.streamId || typeof args.streamId !== 'string' || args.streamId.trim() === '') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'streamId is required',
      },
    };
  }

  const coordinator = getCoordinator(stateDir);

  try {
    await coordinator.broadcast(args.from, args.content, args.streamId);
    return { success: true, data: { broadcast: true } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'BROADCAST_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── handleTeamShutdown ───────────────────────────────────────────────────

export async function handleTeamShutdown(
  args: {
    name: string;
    streamId: string;
  },
  stateDir: string,
): Promise<ToolResult> {
  // Guard clauses: validate required string arguments
  if (!args.name || typeof args.name !== 'string' || args.name.trim() === '') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Field "name" is required and must be a non-empty string',
      },
    };
  }

  if (!args.streamId || typeof args.streamId !== 'string' || args.streamId.trim() === '') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'streamId is required',
      },
    };
  }

  const coordinator = getCoordinator(stateDir);

  try {
    await coordinator.shutdown(args.name, args.streamId);
    return { success: true, data: { shutdown: true } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'SHUTDOWN_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── handleTeamStatus ─────────────────────────────────────────────────────

export async function handleTeamStatus(
  args: { summary?: boolean },
  stateDir: string,
): Promise<ToolResult> {
  const coordinator = getCoordinator(stateDir);

  try {
    const status = coordinator.getStatus();
    if (args.summary) {
      return { success: true, data: { activeCount: status.activeCount, staleCount: status.staleCount } };
    }
    return { success: true, data: status };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'STATUS_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ─── Registration Function ──────────────────────────────────────────────────

export function registerTeamTools(server: McpServer, stateDir: string, eventStore: EventStore): void {
  moduleEventStore = eventStore;
  server.tool(
    'exarchos_team_spawn',
    'Spawn a new team member agent with a role assignment',
    {
      name: z.string().min(1),
      role: z.string().min(1),
      taskId: z.string().min(1),
      taskTitle: z.string().min(1),
      streamId: z.string().min(1),
      worktreePath: z.string().optional(),
    },
    async (args) => formatResult(await handleTeamSpawn(args, stateDir)),
  );

  server.tool(
    'exarchos_team_message',
    'Send a direct message to a team member',
    {
      from: z.string().min(1),
      to: z.string().min(1),
      content: z.string().min(1),
      streamId: z.string().min(1),
      messageType: z.string().optional(),
    },
    async (args) => formatResult(await handleTeamMessage(args, stateDir)),
  );

  server.tool(
    'exarchos_team_broadcast',
    'Broadcast a message to all team members',
    {
      from: z.string().min(1),
      content: z.string().min(1),
      streamId: z.string().min(1),
    },
    async (args) => formatResult(await handleTeamBroadcast(args, stateDir)),
  );

  server.tool(
    'exarchos_team_shutdown',
    'Shutdown a team member agent',
    {
      name: z.string().min(1),
      streamId: z.string().min(1),
    },
    async (args) => formatResult(await handleTeamShutdown(args, stateDir)),
  );

  server.tool(
    'exarchos_team_status',
    'Get status of all team members with health information',
    {
      summary: z.boolean().optional().describe('When true, returns only activeCount and staleCount without full teammate details'),
    },
    async (args) => formatResult(await handleTeamStatus(args, stateDir)),
  );
}
