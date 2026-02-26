import { z } from 'zod';

// ─── CalibrationSplit ──────────────────────────────────────────────────

export const CalibrationSplitSchema = z.enum(['train', 'validation', 'test']);

export type CalibrationSplit = z.infer<typeof CalibrationSplitSchema>;

// ─── HumanGradedCase ───────────────────────────────────────────────────

export const HumanGradedCaseSchema = z.object({
  caseId: z.string().min(1),
  input: z.record(z.unknown()),
  expectedOutput: z.record(z.unknown()),
  humanScore: z.number().min(0).max(1),
  humanRationale: z.string(),
  tags: z.array(z.string()).default([]),
});

export type HumanGradedCase = z.infer<typeof HumanGradedCaseSchema>;
