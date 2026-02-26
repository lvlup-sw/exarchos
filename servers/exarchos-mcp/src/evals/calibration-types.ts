import { z } from 'zod';

// ─── HumanGradedCase ────────────────────────────────────────────────────────

export const HumanGradedCaseSchema = z.object({
  /** Unique identifier for the case. */
  id: z.string().min(1),
  /** The skill this case tests (e.g., 'delegation', 'planning'). */
  skill: z.string().min(1),
  /** The rubric text used for LLM grading. */
  rubric: z.string().min(1),
  /** The output text to be graded. */
  output: z.string(),
  /** Human-assigned verdict: pass or fail. */
  humanVerdict: z.enum(['pass', 'fail']),
  /** Optional notes from the human reviewer. */
  notes: z.string().optional(),
});

export type HumanGradedCase = z.infer<typeof HumanGradedCaseSchema>;

// ─── CalibrateInput ─────────────────────────────────────────────────────────

export const CalibrateInputSchema = z.object({
  /** Path to the gold standard JSONL file. */
  goldStandardPath: z.string().min(1),
  /** Which split to use for calibration. */
  split: z.enum(['validation', 'test']),
  /** Optional skill filter — only calibrate cases matching this skill. */
  skill: z.string().optional(),
});

export type CalibrateInput = z.infer<typeof CalibrateInputSchema>;

// ─── CalibrationReport ──────────────────────────────────────────────────────

export const ConfusionMatrixSchema = z.object({
  truePositives: z.number().int().nonnegative(),
  falsePositives: z.number().int().nonnegative(),
  trueNegatives: z.number().int().nonnegative(),
  falseNegatives: z.number().int().nonnegative(),
  accuracy: z.number().min(0).max(1),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  f1: z.number().min(0).max(1),
});

export type ConfusionMatrix = z.infer<typeof ConfusionMatrixSchema>;

export const DisagreementSchema = z.object({
  caseId: z.string(),
  skill: z.string(),
  humanVerdict: z.enum(['pass', 'fail']),
  judgeVerdict: z.enum(['pass', 'fail']),
  rubric: z.string(),
  output: z.string(),
  reason: z.string(),
});

export type Disagreement = z.infer<typeof DisagreementSchema>;

export const CalibrationReportSchema = z.object({
  split: z.enum(['validation', 'test']),
  totalCases: z.number().int().nonnegative(),
  gradedCases: z.number().int().nonnegative(),
  skippedCases: z.number().int().nonnegative(),
  confusionMatrix: ConfusionMatrixSchema,
  disagreements: z.array(DisagreementSchema),
  skill: z.string().optional(),
});

export type CalibrationReport = z.infer<typeof CalibrationReportSchema>;

// ─── Gold Standard Loader ───────────────────────────────────────────────────

import * as fs from 'node:fs';

/**
 * Load a gold standard JSONL file. Each line is a JSON object conforming
 * to HumanGradedCaseSchema.
 */
export function loadGoldStandard(filePath: string): HumanGradedCase[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  return lines.map((line, idx) => {
    const parsed: unknown = JSON.parse(line);
    const result = HumanGradedCaseSchema.safeParse(parsed);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      throw new Error(
        `Invalid gold standard case at line ${idx + 1}: ${firstIssue.path.join('.')} - ${firstIssue.message}`,
      );
    }
    return result.data;
  });
}
