import { WorkflowEventBase, EVENT_DATA_SCHEMAS, type WorkflowEvent, type EventType } from './schemas.js';

export interface EventInput {
  type: EventType;
  data?: Record<string, unknown>;
  timestamp?: string;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
  agentId?: string;
  agentRole?: string;
  tenantId?: string;
  organizationId?: string;
  source?: string;
  schemaVersion?: string;
}

/** Accepts untrusted type strings — Zod validates at runtime. */
export type UntrustedEventInput = Omit<EventInput, 'type'> & { type: string };

/**
 * Build a WorkflowEvent with Zod validation. Use at system boundaries
 * (MCP tool handlers, external input) where input is untrusted.
 */
export function buildValidatedEvent(
  streamId: string,
  sequence: number,
  input: UntrustedEventInput,
): WorkflowEvent {
  const event = WorkflowEventBase.parse({
    ...input,
    streamId,
    sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
  });

  // Type-specific data validation (defense in depth for all events with schemas)
  const dataSchema = EVENT_DATA_SCHEMAS[event.type as EventType];
  if (dataSchema && event.data !== undefined) {
    dataSchema.parse(event.data);
  }

  return event;
}

/**
 * Build a WorkflowEvent without Zod validation. Use for internal callers
 * where input is already type-checked by TypeScript at compile time.
 * Skips Zod overhead (~0.1-0.3ms per call) on hot paths.
 */
export function buildEvent(
  streamId: string,
  sequence: number,
  input: EventInput,
): WorkflowEvent {
  return {
    ...input,
    streamId,
    sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    schemaVersion: input.schemaVersion ?? '1.0',
  } as WorkflowEvent;
}
