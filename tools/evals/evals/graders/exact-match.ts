import type { GradeResult, IGrader } from '../types.js';

/**
 * Deep equality comparison between output fields and expected fields.
 * Score = matched / total expected fields.
 */
export class ExactMatchGrader implements IGrader {
  readonly name = 'exact-match';
  readonly type = 'exact-match';

  async grade(
    _input: Record<string, unknown>,
    output: Record<string, unknown>,
    expected: Record<string, unknown>,
    config?: Record<string, unknown>
  ): Promise<GradeResult> {
    const fields = (config?.fields as string[] | undefined) ?? Object.keys(expected);
    const threshold = (config?.threshold as number | undefined) ?? 1.0;

    if (fields.length === 0) {
      return { passed: true, score: 1.0, reason: 'No fields to compare' };
    }

    let matched = 0;
    const mismatches: string[] = [];

    for (const field of fields) {
      if (deepEqual(output[field], expected[field])) {
        matched++;
      } else {
        mismatches.push(field);
      }
    }

    const score = matched / fields.length;
    const passed = score >= threshold;

    const reason =
      mismatches.length === 0
        ? 'All fields match'
        : `Mismatched fields: ${mismatches.join(', ')}`;

    return { passed, score, reason };
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in bObj && deepEqual(aObj[key], bObj[key]));
  }

  return false;
}
