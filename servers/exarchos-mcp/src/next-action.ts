import { z } from 'zod';

/** Schema for a suggested next action in a rehydration envelope (DR-8). */
export const NextAction = z.object({
  verb: z.string().min(1),
  reason: z.string(),
  validTargets: z.array(z.string()).optional(),
  hint: z.string().optional(),
});

export type NextAction = z.infer<typeof NextAction>;
