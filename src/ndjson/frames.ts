/**
 * NDJSON streaming frame schema. Each line on the wire is one of four frame
 * types, discriminated by the `type` field.
 */
import { z } from 'zod';

export const EventFrame = z.object({
  type: z.literal('event'),
  event: z.unknown(),
  sequence: z.number().int().nonnegative(),
});

export const HeartbeatFrame = z.object({
  type: z.literal('heartbeat'),
  timestamp: z.string(),
});

export const EndFrame = z.object({
  type: z.literal('end'),
  reason: z.string(),
});

export const ErrorFrame = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

export const FrameSchema = z.discriminatedUnion('type', [
  EventFrame,
  HeartbeatFrame,
  EndFrame,
  ErrorFrame,
]);

export type Frame = z.infer<typeof FrameSchema>;
