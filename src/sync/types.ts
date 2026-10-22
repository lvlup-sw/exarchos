import type { WorkflowEvent } from '../events/schemas.js';

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

