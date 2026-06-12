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
  'invariants',
  // `verification` — the verification-toolchain check (13th, design §4.6):
  // does the verification ladder's runtime resolve, and what is each policy
  // cell's provenance. Read-only visibility, never a fix surface.
  'verification',
]);

/**
 * One resolved verification-policy cell — a `(riskTier, boundaryTouching)`
 * profile plus whether its gate sequence came from the frozen built-in table
 * or a `.exarchos.yml` override. Carried (read-only) on a verification-toolchain
 * CheckResult so callers can see policy provenance without re-resolving. The
 * `source` vocabulary mirrors `VerificationPolicySource` in
 * `workflow/verification-policy-resolver.ts` (the single source of truth).
 */
export const VerificationPolicyCellSchema = z.object({
  riskTier: z.enum(['low', 'medium', 'high']),
  boundaryTouching: z.boolean(),
  source: z.enum(['builtin', 'config']),
});

export const CheckResultSchema = z
  .object({
    category: CheckCategorySchema,
    name: z.string().min(1),
    status: CheckStatusSchema,
    message: z.string().min(1),
    fix: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    durationMs: z.number().int().nonnegative(),
    // Optional read-only detail carried by the verification-toolchain check:
    // the six resolved policy cells with their builtin/config provenance.
    // Other checks omit it; the field survives `DoctorOutputSchema.parse` so
    // the provenance reaches MCP/CLI adapters intact.
    policyCells: z.array(VerificationPolicyCellSchema).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.status === 'Skipped' && (!r.reason || r.reason.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'reason is required when status is Skipped',
        path: ['reason'],
      });
    }
    if ((r.status === 'Warning' || r.status === 'Fail') && (!r.fix || r.fix.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'fix is required when status is Warning or Fail',
        path: ['fix'],
      });
    }
  });

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

export type CheckResult = z.infer<typeof CheckResultSchema>;
export type DoctorSummary = z.infer<typeof DoctorSummarySchema>;
export type DoctorOutput = z.infer<typeof DoctorOutputSchema>;
export type VerificationPolicyCell = z.infer<typeof VerificationPolicyCellSchema>;
