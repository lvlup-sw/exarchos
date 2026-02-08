// ─── Team Coordinator ───────────────────────────────────────────────────────

import { EventStore } from '../event-store/store.js';
import type { RoleDefinition } from './roles.js';
import type { TaskInput } from './composition.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TeammateInfo {
  name: string;
  role: string;
  taskId: string;
  status: 'active' | 'stale' | 'shutdown';
  spawnedAt: string;
  lastActivityAt: string;
}

export interface CoordinatorConfig {
  readonly maxTeammates: number;
  readonly stateDir: string;
}

export interface TeamStatus {
  teammates: TeammateInfo[];
  activeCount: number;
  staleCount: number;
}

// ─── Team Coordinator ───────────────────────────────────────────────────────

export class TeamCoordinator {
  private readonly teammates: Map<string, TeammateInfo> = new Map();
  private readonly eventStore: EventStore;
  private readonly config: CoordinatorConfig;

  constructor(eventStore: EventStore, config: CoordinatorConfig) {
    this.eventStore = eventStore;
    this.config = config;
  }

  async spawn(
    name: string,
    role: RoleDefinition,
    task: TaskInput,
    streamId: string,
    worktreePath?: string,
  ): Promise<TeammateInfo> {
    // Guard: max teammates
    if (this.teammates.size >= this.config.maxTeammates) {
      throw new Error(`Cannot spawn: max teammates (${this.config.maxTeammates}) reached`);
    }

    // Guard: duplicate name
    if (this.teammates.has(name)) {
      throw new Error(`Teammate '${name}' already exists`);
    }

    const now = new Date().toISOString();
    const info: TeammateInfo = {
      name,
      role: role.name,
      taskId: task.taskId,
      status: 'active',
      spawnedAt: now,
      lastActivityAt: now,
    };

    // Track teammate
    this.teammates.set(name, info);

    // Emit task.assigned event
    await this.eventStore.append(streamId, {
      type: 'task.assigned',
      data: {
        taskId: task.taskId,
        title: task.title,
        assignee: name,
        ...(worktreePath ? { worktree: worktreePath } : {}),
      },
      agentId: name,
      agentRole: role.name,
    });

    return { ...info };
  }

  async sendMessage(
    from: string,
    to: string,
    content: string,
    streamId: string,
    messageType?: string,
  ): Promise<void> {
    // Guard: target must exist
    if (!this.teammates.has(to)) {
      throw new Error(`Teammate '${to}' not found`);
    }

    await this.eventStore.append(streamId, {
      type: 'agent.message',
      data: {
        from,
        to,
        content,
        messageType: messageType ?? 'direct',
      },
      agentId: from,
    });
  }

  async broadcast(
    from: string,
    content: string,
    streamId: string,
  ): Promise<void> {
    await this.eventStore.append(streamId, {
      type: 'agent.message',
      data: {
        from,
        to: '*',
        content,
        messageType: 'broadcast',
      },
      agentId: from,
    });
  }

  async shutdown(name: string, streamId: string): Promise<void> {
    if (!this.teammates.has(name)) {
      throw new Error(`Teammate '${name}' not found`);
    }

    this.teammates.delete(name);
  }

  async shutdownAll(streamId: string): Promise<void> {
    this.teammates.clear();
  }

  checkHealth(staleAfterMinutes: number = 30): TeammateInfo[] {
    const now = Date.now();
    const staleThreshold = staleAfterMinutes * 60 * 1000;

    const result: TeammateInfo[] = [];
    for (const [, info] of this.teammates) {
      const lastActivity = new Date(info.lastActivityAt).getTime();
      const elapsed = now - lastActivity;

      if (elapsed > staleThreshold) {
        info.status = 'stale';
      }
      result.push({ ...info });
    }

    return result;
  }

  updateActivity(name: string): void {
    const info = this.teammates.get(name);
    if (info) {
      info.lastActivityAt = new Date().toISOString();
    }
  }

  getStatus(): TeamStatus {
    const teammates = Array.from(this.teammates.values()).map((t) => ({ ...t }));
    const activeCount = teammates.filter((t) => t.status === 'active').length;
    const staleCount = teammates.filter((t) => t.status === 'stale').length;

    return { teammates, activeCount, staleCount };
  }
}
