import { z } from 'zod';
import { GradeResultSchema } from './types.js';
import { loadJsonl } from './jsonl-reader.js';

// ─── HumanGradedCase ────────────────────────────────────────────────────────

export const HumanGradedCaseSchema = z.object({
  caseId: z.string().min(1),
  skill: z.string().min(1),
  rubricName: z.string().min(1),
  humanVerdict: z.boolean(),
  humanScore: z.number().min(0).max(1),
  humanRationale: z.string().min(1),
  graderOutput: GradeResultSchema.optional(),
});

export type HumanGradedCase = z.infer<typeof HumanGradedCaseSchema>;

// ─── CalibrationReport ──────────────────────────────────────────────────────

const DisagreementSchema = z.object({
  caseId: z.string(),
  humanVerdict: z.boolean(),
  judgeVerdict: z.boolean(),
  humanRationale: z.string(),
  judgeReason: z.string(),
});

export const CalibrationReportSchema = z.object({
  skill: z.string(),
  rubricName: z.string(),
  split: z.enum(['validation', 'test']),
  totalCases: z.number().int().nonnegative(),
  truePositives: z.number().int().nonnegative(),
  trueNegatives: z.number().int().nonnegative(),
  falsePositives: z.number().int().nonnegative(),
  falseNegatives: z.number().int().nonnegative(),
  tpr: z.number(),
  tnr: z.number(),
  accuracy: z.number(),
  f1: z.number(),
  disagreements: z.array(DisagreementSchema),
});

export type CalibrationReport = z.infer<typeof CalibrationReportSchema>;

// ─── CalibrateInput ─────────────────────────────────────────────────────────

export const CalibrateInputSchema = z.object({
  goldStandardPath: z.string(),
  split: z.enum(['validation', 'test']),
  skill: z.string().optional(),
});

export type CalibrateInput = z.infer<typeof CalibrateInputSchema>;

// ─── Split Type ────────────────────────────────────────────────────────────

export type CalibrationSplit = 'train' | 'validation' | 'test';

// ─── JSONL Loader ───────────────────────────────────────────────────────────

/**
 * Load human-graded cases from a JSONL file.
 *
 * Each non-blank line is parsed as JSON and validated against HumanGradedCaseSchema.
 * Throws with line number on parse or validation errors.
 */
export async function loadGoldStandard(filePath: string): Promise<HumanGradedCase[]> {
  return loadJsonl(filePath, HumanGradedCaseSchema);
}
