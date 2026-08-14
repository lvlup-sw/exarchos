// ─── The `judgment`-tier content schemas (DR-2, task 011) ───────────────────
//
// The seven event-data schemas that `event-annotations.ts` names as `contentSchema` on the
// DR-2 `judgment` registrations — the arm where the model composes the CONTENT while the gate
// owns the emission, so the content is the thing that gets validated.
//
// ## Why they live here and not in `schemas.ts`
//
// Task 011 derives `EVENT_EMISSION_REGISTRY` from the annotations, which makes `schemas.ts` an
// importer of `event-annotations.ts`. These seven `z.object`s were the ONLY runtime values
// `event-annotations.ts` took from `schemas.ts` (everything else it takes is `import type`, which
// erases), so leaving them there would have closed a runtime import cycle
// `schemas.ts -> event-annotations.ts -> schemas.ts`.
//
// That cycle is not a style question — it was MEASURED to be fatal:
//
//   • Under real Node ESM the cycle throws at load. `event-annotations.ts` dereferences these
//     bindings during its own module evaluation (they are `contentSchema` values inside a frozen
//     object literal), and as a dependency of `schemas.ts` it evaluates FIRST, so the bindings are
//     still in their temporal dead zone:
//     `ReferenceError: Cannot access 'ReviewCompletedData' before initialization`.
//   • Vitest does NOT reproduce that failure — vite-node's SSR transform turns the imports into
//     namespace property reads, which yield `undefined` instead of throwing. The suite would have
//     gone green on a server that cannot boot. (Reported as a finding by task 011; it is why the
//     cycle was probed with `tsx` rather than trusted to the suite.)
//   • `tools/audit/cycle-gate.ts` fails CLOSED in CI on any unbaselined runtime cycle, so the
//     edge could not have been shipped even if the load order happened to work.
//
// Moving the seven values to a module that imports nothing but `zod` removes the back-edge
// structurally rather than papering over it, and `schemas.ts` re-exports every one of them, so
// the public surface is byte-identical: `import { ReviewFindingData } from './schemas.js'` still
// resolves to this exact object.
//
// ## The constraint this creates, stated plainly
//
// A future event annotated `tier: 'judgment'` must have its `contentSchema` here too. Putting it
// in `schemas.ts` instead would re-close the cycle — which is now a LOUD failure (the cycle gate
// fails closed in CI, and the tsx-level load throws), not a silent one.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// ─── Review Event Data ──────────────────────────────────────────────────────

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
  // 'review' is the single dimension; 'spec-review'/'quality-review' retained for historical events.
  stage: z.enum(['review', 'spec-review', 'quality-review', 'security-review']).describe('Review stage that completed'),
  verdict: z.enum(['pass', 'fail', 'blocked']).describe('Review verdict: pass, fail, or blocked'),
  findingsCount: z.number().int().nonnegative().describe('Number of findings from the review'),
  summary: z.string().describe('Human-readable summary of review results'),
});

// ─── Remediation Event Data ─────────────────────────────────────────────────

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

// ─── Verification Event Data ────────────────────────────────────────────────

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
