import { z } from 'zod';

// ─── Baseline Entry Schema ──────────────────────────────────────────────────

export const BaselineEntry = z.object({
  p50_ms: z.number().nonnegative(),
  p95_ms: z.number().nonnegative(),
  p99_ms: z.number().nonnegative(),
  measured_at: z.string().datetime(),
  commit: z.string().min(1),
  iterations: z.number().int().positive(),
});

// ─── Baselines File Schema ──────────────────────────────────────────────────

export const BaselinesFile = z.object({
  version: z.string().min(1),
  generated: z.string().min(1),
  baselines: z.record(z.string(), BaselineEntry),
});

// ─── Type Exports ───────────────────────────────────────────────────────────

export type BaselineEntryType = z.infer<typeof BaselineEntry>;
export type BaselinesFileType = z.infer<typeof BaselinesFile>;
