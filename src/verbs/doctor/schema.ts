/**
 * Doctor output contract: the schemas for `CheckResult` and `DoctorOutput`.
 * The CLI adapter and the MCP adapter both use these schemas. The types come
 * from `z.infer`, so the schemas and the types cannot drift.
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
  /** Category of the verification-toolchain check. */
  'verification',
]);

/**
 * One resolved verification-policy cell: a `(riskTier, boundaryTouching)`
 * profile and the source of its gate sequence. `builtin` is the frozen
 * built-in table, and `config` is a `.exarchos.yml` override. The values
 * mirror `VerificationPolicySource` in `workflow/verification-policy-resolver.ts`.
 */
export const VerificationPolicyCellSchema = z.object({
  riskTier: z.enum(['low', 'medium', 'high']),
  boundaryTouching: z.boolean(),
  source: z.enum(['builtin', 'config']),
});

/**
 * One check result. The refinements require `reason` when the status is
 * `Skipped`, and `fix` when the status is `Warning` or `Fail`.
 */
export const CheckResultSchema = z
  .object({
    category: CheckCategorySchema,
    name: z.string().min(1),
    status: CheckStatusSchema,
    message: z.string().min(1),
    fix: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    durationMs: z.number().int().nonnegative(),
    /**
     * The six resolved policy cells, one for each `(riskTier, boundaryTouching)`
     * pair. The fixed length makes a truncated payload fail at the schema. The
     * refinement requires this field on the verification-toolchain check and
     * rejects it on all other checks.
     */
    policyCells: z.array(VerificationPolicyCellSchema).length(6).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.name === 'verification-toolchain' && r.policyCells === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'policyCells is required for the verification-toolchain check',
        path: ['policyCells'],
      });
    }
    if (r.name !== 'verification-toolchain' && r.policyCells !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'policyCells is only valid on the verification-toolchain check',
        path: ['policyCells'],
      });
    }
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

/** The full doctor output. The refinement requires the summary tally to equal `checks.length`. */
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
