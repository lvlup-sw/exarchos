// ─── Team MCP Tool Handlers ─────────────────────────────────────────────────

import { EventStore } from '../event-store/store.js';
import { TeamCoordinator } from './coordinator.js';
import { ROLES } from './roles.js';

// ─── Tool Result Type ──────────────────────────────────────────────────────

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

// ─── Shared Coordinator + Store Cache ──────────────────────────────────────

const coordinatorCache = new Map<string, TeamCoordinator>();
const storeCache = new Map<string, EventStore>();

function getStore(stateDir: string): EventStore {
  let store = storeCache.get(stateDir);
  if (!store) {
    store = new EventStore(stateDir);
    storeCache.set(stateDir, store);
  }
  return store;
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
  args: Record<string, unknown>,
  stateDir: string,
): Promise<ToolResult> {
  const coordinator = getCoordinator(stateDir);

  try {
    const status = coordinator.getStatus();
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
