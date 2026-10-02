// RESERVED(issue: #1677, owner: exarchos, expires: 2026-10-31) Dormant Zod schema for the
// benchmark baseline contract. The benchmark-harness allowlist class excludes `*-schema.ts`
// files, so this file carries the marker.

import { z } from 'zod';

export const BaselineEntry = z.object({
  p50_ms: z.number().nonnegative(),
  p95_ms: z.number().nonnegative(),
  p99_ms: z.number().nonnegative(),
  measured_at: z.string().datetime(),
  commit: z.string().min(1),
  iterations: z.number().int().positive(),
});

export const BaselinesFile = z.object({
  version: z.string().min(1),
  generated: z.string().min(1),
  baselines: z.record(z.string(), BaselineEntry),
});

export type BaselineEntryType = z.infer<typeof BaselineEntry>;
export type BaselinesFileType = z.infer<typeof BaselinesFile>;
