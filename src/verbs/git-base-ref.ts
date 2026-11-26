/**
 * The check of a base ref that a caller gives to a git diff, log or merge-base call.
 * Git reads an argument that starts with a dash as an option, and an output option writes a file.
 * The check applies the safe ref pattern of the capsule, so a base ref starts with a letter, a digit or an underscore.
 * Each git call also puts the end-of-options mark before the ref, so git never reads the ref as an option.
 */

import { CapsuleBaseRefSchema } from '../contract/capsule/exarchos-capsule.js';
import type { ToolResult } from '../format.js';

/** The git argument that ends option parsing. Each option of a git call goes before it. */
export const END_OF_OPTIONS = '--end-of-options';

/** True when git can read `ref` only as one ref name. Git cannot read it as an option, a range or two arguments. */
export function isSafeBaseRef(ref: string): boolean {
  return CapsuleBaseRefSchema.safeParse(ref).success;
}

/** The refusal of a base ref that fails {@link isSafeBaseRef}. The caller returns it before git runs. */
export function unsafeBaseRefResult(field: string, ref: string): ToolResult {
  return {
    success: false,
    error: {
      code: 'INVALID_INPUT',
      message:
        `${field} ${JSON.stringify(ref)} is not a safe git ref. A base ref starts with a letter, digit or ` +
        'underscore, contains no "..", and uses only letters, digits and . _ / + @ -',
    },
  };
}
