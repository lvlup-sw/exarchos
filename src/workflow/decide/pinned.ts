/**
 * RESERVED(issue: #1927, owner: exarchos, expires: 2027-01-31)
 *
 * Reads the `exarchos` extension of a pinned definition. A capsule pins the definition of its workflow,
 * and an earlier compiler pinned the kernel only. So a pinned definition can hold no extension.
 */

import { parseExtension, type ExarchosExtension } from '../definitions/extension.js';

/**
 * Returns the parsed extension of a pinned definition. A kernel-only definition and an extension that does
 * not parse give `undefined`.
 */
export function pinnedExtensionOf(definition: unknown): ExarchosExtension | undefined {
  const parsed = parseExtension(definition);
  return parsed.ok ? parsed.extension : undefined;
}
