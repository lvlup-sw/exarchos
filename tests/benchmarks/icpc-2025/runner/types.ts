import { z } from 'zod';

// --- Zod Schemas ---

export const VerdictSchema = z.enum([
  'pass',
  'fail',
  'partial',
  'tle',
  'rte',
  'ce',
  'no_solution',
]);

export const SampleVerdictSchema = z.enum(['pass', 'fail', 'tle', 'rte']);

export const ArmIdSchema = z.enum(['exarchos', 'vanilla-plan', 'hn-manual']);

export const MetricsSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  wallClockSeconds: z.number().nonnegative(),
  iterationCount: z.number().int().nonnegative(),
  linesOfCode: z.number().int().nonnegative(),
});

export const SampleResultSchema = z.object({
  sampleId: z.number().int(),
  verdict: SampleVerdictSchema,
  actualOutput: z.string().optional(),
  expectedOutput: z.string(),
});

export const ArmResultSchema = z.object({
  arm: ArmIdSchema,
  verdict: VerdictSchema,
  sampleResults: z.array(SampleResultSchema),
  metrics: MetricsSchema,
  solution: z.string().optional(),
  notes: z.string().optional(),
});

export const ProblemResultSchema = z.object({
  problemId: z.string(),
  title: z.string(),
  arms: z.array(ArmResultSchema).min(1),
});

export const ArmConfigSchema = z.object({
  id: ArmIdSchema,
  name: z.string(),
  description: z.string(),
  promptTemplate: z.string(),
  mcpEnabled: z.boolean(),
  systemPromptPath: z.string().optional(),
});

export const ProblemDefinitionSchema = z.object({
  id: z.string(),
  title: z.string(),
  timeLimit: z.number().positive(),
  statement: z.string(),
  samples: z.array(
    z.object({
      id: z.number().int(),
      input: z.string(),
      output: z.string(),
    })
  ),
  tags: z.array(z.string()).optional(),
});

export const BenchmarkRunSchema = z.object({
  runId: z.string(),
  timestamp: z.string(),
  model: z.string(),
  commit: z.string(),
  language: z.string(),
  arms: z.array(ArmConfigSchema),
  problems: z.array(ProblemResultSchema),
});

// --- Inferred Types ---

export type Verdict = z.infer<typeof VerdictSchema>;
export type SampleVerdict = z.infer<typeof SampleVerdictSchema>;
export type ArmId = z.infer<typeof ArmIdSchema>;
export type Metrics = z.infer<typeof MetricsSchema>;
export type SampleResult = z.infer<typeof SampleResultSchema>;
export type ArmResult = z.infer<typeof ArmResultSchema>;
export type ProblemResult = z.infer<typeof ProblemResultSchema>;
export type ArmConfig = z.infer<typeof ArmConfigSchema>;
export type ProblemDefinition = z.infer<typeof ProblemDefinitionSchema>;
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;
