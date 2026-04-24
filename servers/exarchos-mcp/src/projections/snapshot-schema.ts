import { z } from 'zod';

export const SnapshotRecord = z.object({
  projectionId: z.string(),
  projectionVersion: z.string(),
  sequence: z.number().int().nonnegative(),
  state: z.unknown(),
  timestamp: z.string().datetime(),
});

export type SnapshotRecord = z.infer<typeof SnapshotRecord>;
