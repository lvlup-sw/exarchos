import { z } from 'zod';

// ─── Score constraint (reusable) ────────────────────────────────────────

const ScoreSchema = z.number().min(0).max(1);

// ─── GradeResult ────────────────────────────────────────────────────────

export const GradeResultSchema = z.object({
  passed: z.boolean(),
  score: ScoreSchema,
  reason: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type GradeResult = z.infer<typeof GradeResultSchema>;

// ─── AssertionConfig ────────────────────────────────────────────────────

export const AssertionConfigSchema = z.object({
  type: z.enum(['exact-match', 'schema', 'tool-call', 'trace-pattern']),
  name: z.string(),
  threshold: ScoreSchema.default(1.0),
  config: z.record(z.unknown()).optional(),
});

export type AssertionConfig = z.infer<typeof AssertionConfigSchema>;

// ─── AssertionResult ────────────────────────────────────────────────────

export const AssertionResultSchema = z.object({
  name: z.string(),
  type: z.string(),
  passed: z.boolean(),
  score: ScoreSchema,
  reason: z.string(),
  threshold: z.number(),
});

export type AssertionResult = z.infer<typeof AssertionResultSchema>;

// ─── EvalCase ───────────────────────────────────────────────────────────

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['single', 'trace']),
  description: z.string(),
  input: z.record(z.unknown()),
  expected: z.record(z.unknown()),
  tags: z.array(z.string()).default([]),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;

// ─── EvalResult ─────────────────────────────────────────────────────────

export const EvalResultSchema = z.object({
  caseId: z.string(),
  suiteId: z.string(),
  passed: z.boolean(),
  score: ScoreSchema,
  assertions: z.array(AssertionResultSchema),
  duration: z.number().int().nonnegative(),
});

export type EvalResult = z.infer<typeof EvalResultSchema>;

// ─── EvalSuiteConfig ────────────────────────────────────────────────────

export const EvalSuiteConfigSchema = z.object({
  description: z.string(),
  metadata: z.object({
    skill: z.string(),
    phaseAffinity: z.string(),
    version: z.string(),
  }),
  assertions: z.array(AssertionConfigSchema),
  datasets: z.record(
    z.object({
      path: z.string(),
      description: z.string(),
    })
  ),
});

export type EvalSuiteConfig = z.infer<typeof EvalSuiteConfigSchema>;

// ─── RunSummary ─────────────────────────────────────────────────────────

export const RunSummarySchema = z.object({
  runId: z.string(),
  suiteId: z.string(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  avgScore: ScoreSchema,
  duration: z.number().int().nonnegative(),
  results: z.array(EvalResultSchema),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;

// ─── IGrader Interface ──────────────────────────────────────────────────

export interface IGrader {
  readonly name: string;
  readonly type: string;
  grade(
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    expected: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<GradeResult>;
}
