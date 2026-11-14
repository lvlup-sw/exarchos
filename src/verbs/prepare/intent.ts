/** The closed request for an approved design record. */
import { z } from 'zod';
import { CapsuleBaseRefSchema } from '../../contract/capsule/exarchos-capsule.js';
import { DurableWorkflowTypeSchema } from '../../workflow/schemas.js';

const NonemptyText = z.string().refine((value) => value.trim().length > 0);
const intentFields = {
  designRef: NonemptyText.describe('Relative path to the unified design record'),
  approval: z.object({
    decision: z.literal('approved'),
    designDigest: z.string().regex(/^[0-9a-f]{64}$/).describe('SHA-256 of the entire design file'),
  }).strict(),
  designDepth: z.enum(['thin', 'standard', 'deep']).optional().describe('Defaults to standard'),
  refactor: z.object({
    track: z.literal('overhaul'),
    scopeAssessment: NonemptyText,
  }).strict().optional(),
};

export const PrepareIntentSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('bootstrap'),
    workflowType: DurableWorkflowTypeSchema,
    baseRef: CapsuleBaseRefSchema,
    ...intentFields,
  }).strict(),
  z.object({
    mode: z.literal('compile'),
    workflowType: DurableWorkflowTypeSchema.optional(),
    baseRef: CapsuleBaseRefSchema.optional(),
    ...intentFields,
  }).strict(),
]).superRefine((intent, ctx) => {
  if (intent.refactor !== undefined && intent.workflowType !== undefined && intent.workflowType !== 'refactor') {
    ctx.addIssue({ code: 'custom', path: ['refactor'], message: 'Refactor terms require the refactor workflow type.' });
  }
  if (intent.mode === 'bootstrap' && intent.workflowType === 'refactor' && intent.refactor === undefined) {
    ctx.addIssue({ code: 'custom', path: ['refactor'], message: 'Refactor bootstrap requires overhaul terms.' });
  }
});

export type CompileIntent = Extract<z.infer<typeof PrepareIntentSchema>, { mode: 'compile' }>;

export type BootstrapIntent = Extract<z.infer<typeof PrepareIntentSchema>, { mode: 'bootstrap' }>;
