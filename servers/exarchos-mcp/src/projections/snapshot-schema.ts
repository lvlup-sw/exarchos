import { z } from 'zod';

/** Zod schema for one JSONL line in the `<stateDir>/<streamId>.projections.jsonl` snapshot sidecar (DR-2). */
export const SnapshotRecord = z.object({
  projectionId: z.string(),
  projectionVersion: z.string(),
  sequence: z.number().int().nonnegative(),
  state: z.unknown(),
  timestamp: z.string().datetime(),
});

export type SnapshotRecord = z.infer<typeof SnapshotRecord>;
