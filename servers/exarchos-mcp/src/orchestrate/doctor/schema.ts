/**
 * Doctor output contract — single source of truth for CheckResult and
 * DoctorOutput shapes. Both the CLI adapter and the MCP adapter project
 * through this schema; types are derived via `z.infer` so schema and
 * TypeScript cannot drift (DIM-3/T-3.3).
 *
 * Refinements enforce the two invariants the handler cannot express at
 * the field level:
 *   - status === 'Skipped' requires a non-empty `reason` (DIM-2 — no
 *     silent skips)
 *   - DoctorOutput.summary tally must equal checks.length (DIM-3 — the
 *     handler validates through parse() before returning)
 */

import { z } from 'zod';

export const CheckStatusSchema = z.enum(['Pass', 'Warning', 'Fail', 'Skipped']);

export const CheckCategorySchema = z.enum([
  'runtime',
  'storage',
  'vcs',
  'agent',
  'plugin',
  'env',
  'remote',
]);

export const CheckResultSchema = z
  .object({
    category: CheckCategorySchema,
    name: z.string().min(1),
    status: CheckStatusSchema,
    message: z.string().min(1),
    fix: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .refine(
    (r) => r.status !== 'Skipped' || (r.reason !== undefined && r.reason.length > 0),
    { message: 'reason is required when status is Skipped', path: ['reason'] },
  );

export const DoctorSummarySchema = z.object({
  passed: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const DoctorOutputSchema = z
  .object({
    checks: z.array(CheckResultSchema),
    summary: DoctorSummarySchema,
  })
  .refine(
    (o) =>
      o.summary.passed + o.summary.warnings + o.summary.failed + o.summary.skipped ===
      o.checks.length,
    { message: 'summary tally must equal checks.length', path: ['summary'] },
  );

export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type CheckCategory = z.infer<typeof CheckCategorySchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type DoctorSummary = z.infer<typeof DoctorSummarySchema>;
export type DoctorOutput = z.infer<typeof DoctorOutputSchema>;
