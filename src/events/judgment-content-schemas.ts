/**
 * The content schemas of the seven `judgment`-tier events. `event-annotations.ts` names
 * them as `contentSchema`. On this tier the model writes the content and the gate owns the
 * emission, so the gate validates the content.
 *
 * These schemas are not in `schemas.ts`, because `schemas.ts` imports `event-annotations.ts`.
 * That runtime cycle throws a `ReferenceError` at load under Node ESM. Vitest does not
 * reproduce the error, and `tools/audit/cycle-gate.ts` fails on the cycle in CI. This module
 * imports only `zod`, and `schemas.ts` re-exports each schema.
 *
 * The `contentSchema` of each new `tier: 'judgment'` event must also live here.
 */

import { z } from 'zod';

export const ReviewFindingData = z.object({
  pr: z.number().int().describe('Pull request where finding was detected'),
  source: z.enum(['coderabbit', 'self-hosted']).describe('Review tool that produced the finding'),
  severity: z.enum(['critical', 'major', 'minor', 'suggestion']).describe('Finding severity level'),
  filePath: z.string().describe('File path where the finding was detected'),
  lineRange: z.tuple([z.number().int(), z.number().int()]).optional().describe('Start and end line numbers of the finding'),
  message: z.string().describe('Description of the review finding'),
  rule: z.string().optional().describe('Lint or analysis rule that triggered the finding'),
});

export const ReviewEscalatedData = z.object({
  pr: z.number().int().describe('Pull request being escalated'),
  reason: z.string().describe('Why the review was escalated'),
  originalScore: z.number().min(0).max(1).describe('Risk score before escalation'),
  triggeringFinding: z.string().describe('The finding that triggered escalation'),
});

export const ReviewCompletedData = z.object({
  /** `review` is the single dimension. `spec-review` and `quality-review` stay for historical events. */
  stage: z.enum(['review', 'spec-review', 'quality-review', 'security-review']).describe('Review stage that completed'),
  verdict: z.enum(['pass', 'fail', 'blocked']).describe('Review verdict: pass, fail, or blocked'),
  findingsCount: z.number().int().nonnegative().describe('Number of findings from the review'),
  summary: z.string().describe('Human-readable summary of review results'),
});

export const RemediationAttemptedDataSchema = z.object({
  taskId: z.string().min(1).describe('Task being remediated'),
  skill: z.string().min(1).describe('Skill context for the remediation'),
  gateName: z.string().min(1).describe('Gate that failed and triggered remediation'),
  attemptNumber: z.number().int().min(1).describe('Sequential attempt number (1-based)'),
  strategy: z.string().describe('Remediation strategy being applied'),
});

export const RemediationSucceededDataSchema = z.object({
  taskId: z.string().min(1).describe('Task that was successfully remediated'),
  skill: z.string().min(1).describe('Skill context for the remediation'),
  gateName: z.string().min(1).describe('Gate that now passes after remediation'),
  totalAttempts: z.number().int().min(1).describe('Total attempts before success'),
  finalStrategy: z.string().describe('Strategy that ultimately succeeded'),
});

export const TestResultData = z.object({
  passed: z.boolean().describe('Whether the overall test suite passed'),
  passCount: z.number().int().nonnegative().describe('Number of passing tests'),
  failCount: z.number().int().nonnegative().describe('Number of failing tests'),
  coveragePercent: z.number().min(0).max(100).optional().describe('Code coverage percentage (0-100)'),
  output: z.string().optional().describe('Raw test runner output'),
});

export const TypecheckResultData = z.object({
  passed: z.boolean().describe('Whether TypeScript compilation succeeded'),
  errorCount: z.number().int().nonnegative().describe('Number of type errors found'),
  errors: z.array(z.string()).optional().describe('Individual type error messages'),
});
