/**
 * Init output contract — single source of truth for ConfigWriteResult
 * and InitOutput shapes. Types are derived via `z.infer` so schema and
 * TypeScript cannot drift.
 *
 * Refinements enforce that a `failed` ConfigWriteResult always carries
 * a non-empty `error` string — no silent failures.
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
     * DR-7: the writer converged overall (status 'written'/'skipped') but its
     * consumer-side on-ramp block write (AGENTS.md) FAILED — an advisory-only
     * failure that must NOT be conflated with success. The onboard reconcile gate
     * reads this to keep retired lifecycle hooks in place when the replacement
     * on-ramp block is not actually written (no hook-less + block-less window).
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

// Derive TypeScript types
export type ConfigWriteResult = z.infer<typeof ConfigWriteResultSchema>;
export type InitOutput = z.infer<typeof InitOutputSchema>;

