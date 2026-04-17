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
export type ConfigWriteStatus = z.infer<typeof ConfigWriteStatusSchema>;
export type ConfigWriteResult = z.infer<typeof ConfigWriteResultSchema>;
export type InitInput = z.infer<typeof InitInputSchema>;
export type InitOutput = z.infer<typeof InitOutputSchema>;

/** Interface that all runtime config writers implement. */
export interface ConfigWriter {
  readonly runtime: string;
  write(projectRoot: string): Promise<ConfigWriteResult>;
}
