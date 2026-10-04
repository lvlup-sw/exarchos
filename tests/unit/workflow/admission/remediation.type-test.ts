/**
 * Compile-time totality checks for the deny-reason census, the stable-code map and the verdict union.
 * Vitest strips types, so only a `tsc` program that includes this file reports these failures.
 * `tests/tsconfig.json` excludes `unit/**`.
 */
import { it, expect } from 'vitest';

import {
  POLICY_DENY_REASONS,
  stableErrorCodeForDenyReason,
} from '../../../../src/workflow/admission/remediation.js';
import type { PolicyDenyReason, PolicyVerdict } from '../../../../src/workflow/admission/policy-evaluation.js';
import type { StableErrorCode } from '../../../../src/contract/error-families.js';

/**
 * The two conditional types compare the element type of `POLICY_DENY_REASONS` with the `PolicyDenyReason` union, one direction each.
 * The declared element type is `PolicyDenyReason`, so both types are always `true`.
 * The `satisfies` clause on `DENY_REASON_TABLE` in `remediation.ts` keeps the census total.
 */
type _CensusCoversUnion = PolicyDenyReason extends (typeof POLICY_DENY_REASONS)[number]
  ? true
  : never;
type _UnionCoversCensus = (typeof POLICY_DENY_REASONS)[number] extends PolicyDenyReason
  ? true
  : never;
const _censusCovers: _CensusCoversUnion = true;
const _unionCovers: _UnionCoversCensus = true;
void _censusCovers;
void _unionCovers;

/**
 * Each deny reason maps to a stable code.
 * The `Record<PolicyDenyReason, StableErrorCode>` type needs one entry for each reason, and the values call the real mapper.
 */
const _reasonToStableCode: Record<PolicyDenyReason, StableErrorCode> = {
  missing: stableErrorCodeForDenyReason('missing'),
  failed: stableErrorCodeForDenyReason('failed'),
  stale: stableErrorCodeForDenyReason('stale'),
  malformed: stableErrorCodeForDenyReason('malformed'),
  contradictory: stableErrorCodeForDenyReason('contradictory'),
  unauthorized: stableErrorCodeForDenyReason('unauthorized'),
};
void _reasonToStableCode;

/** The `PolicyVerdict` union has three members. A fourth member without an entry here is a compile error. */
const _everyVerdictExplained: Record<PolicyVerdict, true> = {
  allow: true,
  deny: true,
  indeterminate: true,
};
void _everyVerdictExplained;

/** The runtime census holds six reasons. */
it('remediation type-test anchor', () => {
  expect(POLICY_DENY_REASONS.length).toBe(6);
});
