import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── Remote Configuration ────────────────────────────────────────────────────

export interface RemoteConfig {
  apiBaseUrl: string;
  apiToken: string;
  exarchosId: string;
  timeoutMs: number;
}

// ─── Sync Configuration ─────────────────────────────────────────────────────

export interface SyncConfig {
  mode: 'local' | 'remote' | 'dual';
  syncIntervalMs: number;
  batchSize: number;
  maxRetries: number;
  remote?: RemoteConfig;
}

// ─── Sync State ──────────────────────────────────────────────────────────────

export interface SyncState {
  streamId: string;
  localHighWaterMark: number;
  remoteHighWaterMark: number;
  lastSyncAt?: string;
  lastSyncResult?: 'success' | 'partial' | 'failed';
}

// ─── Sync Result ─────────────────────────────────────────────────────────────

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: ConflictInfo[];
}

// ─── Conflict Info ───────────────────────────────────────────────────────────

export interface ConflictInfo {
  streamId: string;
  type: string;
  localEvent?: unknown;
  remoteEvent?: unknown;
  resolution: string;
}

// ─── Outbox Entry ────────────────────────────────────────────────────────────

export interface OutboxEntry {
  id: string;
  streamId: string;
  event: WorkflowEvent;
  status: 'pending' | 'sent' | 'confirmed' | 'dead-letter';
  attempts: number;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  createdAt: string;
  error?: string;
}

// ─── Wire Format (matches C# ExarchosEventDto) ──────────────────────────────

export interface ExarchosEventDto {
  streamId: string;
  sequence: number;
  timestamp: string;
  type: string;
  correlationId?: string;
  causationId?: string;
  agentId?: string;
  agentRole?: string;
  source?: string;
  schemaVersion?: string;
  data?: Record<string, unknown>;
}

// ─── Workflow Registration ───────────────────────────────────────────────────

export interface WorkflowRegistration {
  featureId: string;
  workflowType: string;
  registeredAt: string;
  streamVersion: number;
}

// ─── Event Sender (used by Outbox to decouple from BasileusClient) ──────────

export interface EventSender {
  appendEvents(
    streamId: string,
    events: ExarchosEventDto[],
  ): Promise<AppendEventsResponse>;
}

// ─── Append Events Response ──────────────────────────────────────────────────

export interface AppendEventsResponse {
  accepted: number;
  streamVersion: number;
}

// ─── Pending Command ─────────────────────────────────────────────────────────

export interface PendingCommand {
  id: string;
  type: string;
  workflowId: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}
