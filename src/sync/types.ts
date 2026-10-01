import { z } from 'zod';
import type { WorkflowEvent } from '../events/schemas.js';

export interface RemoteConfig {
  apiBaseUrl: string;
  apiToken: string;
  exarchosId: string;
  timeoutMs: number;
}

export const RemoteConfigSchema = z.object({
  apiToken: z.string().min(1),
  apiBaseUrl: z.string().default('http://localhost:5000'),
  exarchosId: z.string().default('default'),
  timeoutMs: z.number().int().positive().default(5000),
});

export interface SyncConfig {
  mode: 'local' | 'remote' | 'dual';
  syncIntervalMs: number;
  batchSize: number;
  maxRetries: number;
  remote?: RemoteConfig;
}

export const SyncConfigSchema = z.object({
  mode: z.enum(['local', 'remote', 'dual']).default('local'),
  syncIntervalMs: z.number().int().positive().default(30000),
  batchSize: z.number().int().positive().default(50),
  maxRetries: z.number().int().nonnegative().default(10),
  remote: RemoteConfigSchema.optional(),
});

export interface SyncState {
  streamId: string;
  localHighWaterMark: number;
  remoteHighWaterMark: number;
  lastSyncAt?: string;
  lastSyncResult?: 'success' | 'partial' | 'failed';
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: ConflictInfo[];
}

export interface ConflictInfo {
  streamId: string;
  type: string;
  localEvent?: unknown;
  remoteEvent?: unknown;
  resolution: string;
}

export interface OutboxEntry {
  id: string;
  streamId: string;
  event: WorkflowEvent;
  status: 'pending' | 'sent' | 'confirmed' | 'dead-letter';
  attempts: number;
  lastAttemptAt?: string | undefined;
  nextRetryAt?: string | undefined;
  createdAt: string;
  error?: string | undefined;
}

/** Wire format of an event. It matches the C# `ExarchosEventDto`. */
export interface ExarchosEventDto {
  streamId: string;
  sequence: number;
  timestamp: string;
  type: string;
  correlationId?: string | undefined;
  causationId?: string | undefined;
  agentId?: string | undefined;
  agentRole?: string | undefined;
  source?: string | undefined;
  schemaVersion?: string | undefined;
  data?: Record<string, unknown> | undefined;
  idempotencyKey?: string | undefined;
}

export interface WorkflowRegistration {
  featureId: string;
  workflowType: string;
  registeredAt: string;
  streamVersion: number;
}

/** The sender that the Outbox uses, so the Outbox does not depend on `BasileusClient`. */
export interface EventSender {
  appendEvents(
    streamId: string,
    events: ExarchosEventDto[],
  ): Promise<AppendEventsResponse>;
}

export interface AppendEventsResponse {
  accepted: number;
  streamVersion: number;
}

export interface PendingCommand {
  id: string;
  type: string;
  workflowId: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}
