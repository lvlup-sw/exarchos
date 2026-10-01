/**
 * Declared resource quotas for an extension.
 *
 * An extension declares its resource ceilings in its signed manifest.
 * Admission makes two checks, and each check rejects on failure:
 *   1. Each declared ceiling is less than or equal to the host budget.
 *   2. The loaded content size is less than or equal to the declared ceiling and the host budget.
 */

import { z } from 'zod';

/** Declared resource ceilings. Every field is a non-negative integer. */
export const ExtensionQuotaSchema = z
  .object({
    /** Maximum size, in bytes, of the extension's content payload. */
    maxContentBytes: z.number().int().nonnegative(),
    /** Maximum resident memory for the extension, in bytes. */
    maxMemoryBytes: z.number().int().nonnegative(),
    /** Maximum wall-clock runtime per invocation, in milliseconds. */
    maxRuntimeMillis: z.number().int().nonnegative(),
    /** Maximum concurrent invocations. */
    maxConcurrency: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type ExtensionQuota = z.infer<typeof ExtensionQuotaSchema>;

const QUOTA_FIELDS = [
  'maxContentBytes',
  'maxMemoryBytes',
  'maxRuntimeMillis',
  'maxConcurrency',
] as const;

/** Outcome of a quota check. */
export type QuotaEvaluation =
  | { readonly withinBudget: true }
  | { readonly withinBudget: false; readonly detail: string };

/**
 * Check every declared ceiling against the host budget. Runs before content is
 * loaded so an over-declaring extension is rejected without touching its bytes.
 */
export function evaluateDeclaredQuota(
  declared: ExtensionQuota,
  budget: ExtensionQuota,
): QuotaEvaluation {
  for (const field of QUOTA_FIELDS) {
    if (declared[field] > budget[field]) {
      return {
        withinBudget: false,
        detail: `declared ${field}=${declared[field]} exceeds host budget ${budget[field]}`,
      };
    }
  }
  return { withinBudget: true };
}

/**
 * Check the actual content size against both the extension's own declared
 * ceiling and the host budget. Runs after the content bytes are loaded once.
 */
export function evaluateContentQuota(
  declared: ExtensionQuota,
  budget: ExtensionQuota,
  actualContentBytes: number,
): QuotaEvaluation {
  if (actualContentBytes > declared.maxContentBytes) {
    return {
      withinBudget: false,
      detail: `content size ${actualContentBytes} exceeds declared maxContentBytes ${declared.maxContentBytes}`,
    };
  }
  if (actualContentBytes > budget.maxContentBytes) {
    return {
      withinBudget: false,
      detail: `content size ${actualContentBytes} exceeds host budget maxContentBytes ${budget.maxContentBytes}`,
    };
  }
  return { withinBudget: true };
}
