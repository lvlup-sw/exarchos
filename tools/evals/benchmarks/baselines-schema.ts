// RESERVED(issue: #1677, owner: exarchos, expires: 2026-10-31) — dormant benchmark-contract Zod schema (BaselineEntry/BaselinesFile); kept as the baseline contract surface for the benchmark-validation epic #1677. Deliberately NOT in the benchmark-harness allowlist class — that class excludes `*-schema.ts` contract surfaces by design (DR-7 module-intent gate)

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
