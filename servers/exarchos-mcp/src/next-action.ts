import { z } from 'zod';

/** Schema for a suggested next action in a rehydration envelope (DR-8). */
export const NextAction = z.object({
  verb: z.string().min(1),
  reason: z.string(),
  validTargets: z.array(z.string()).optional(),
  hint: z.string().optional(),
  // T18 (DR-MO-1): action verbs that carry a side-effect (e.g.
  // `merge_orchestrate`) include an idempotency key so callers can de-duplicate
  // auto-triggered work across rehydrations of the same workflow state.
  idempotencyKey: z.string().optional(),
});

export type NextAction = z.infer<typeof NextAction>;
