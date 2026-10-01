/**
 * Init output contract. The TypeScript types derive from the schemas through `z.infer`.
 * A refinement makes a `failed` ConfigWriteResult carry a non-empty `error`.
 */

import { z } from 'zod';

export const ConfigWriteStatusSchema = z.enum(['written', 'skipped', 'failed', 'stub']);

export const ConfigWriteResultSchema = z
  .object({
    runtime: z.string().min(1),
    path: z.string().min(1).optional(),
    status: ConfigWriteStatusSchema,
    componentsWritten: z.array(z.string()),
    warnings: z.array(z.string()).optional(),
    error: z.string().optional(),
    /**
     * True when the writer converged but its AGENTS.md on-ramp block write failed.
     * The onboard reconcile gate then keeps the retired lifecycle hooks in place.
     * A project thus does not lose the hooks before it has the block.
     */
    onrampFailed: z.boolean().optional(),
  })
  .refine(
    (r) => r.status !== 'failed' || (r.error !== undefined && r.error.length > 0),
    { message: 'error is required when status is failed', path: ['error'] },
  );

export const InitInputSchema = z.object({
  runtime: z.string().optional(),
  vcs: z.string().optional(),
  nonInteractive: z.boolean().default(false),
  forceOverwrite: z.boolean().default(false),
  format: z.enum(['table', 'json']).default('table'),
});

export const InitOutputSchema = z.object({
  runtimes: z.array(ConfigWriteResultSchema),
  vcs: z
    .object({
      provider: z.string(),
      remoteUrl: z.string(),
      cliAvailable: z.boolean(),
      cliVersion: z.string().optional(),
    })
    .nullable(),
  durationMs: z.number().int().nonnegative(),
});

export type ConfigWriteResult = z.infer<typeof ConfigWriteResultSchema>;
export type InitOutput = z.infer<typeof InitOutputSchema>;

