/**
 * Compile-time totality checks for the deny-reason census, the stable-code map and the verdict union.
 * A type checker reports these failures, not vitest.
 */
import { it, expect } from 'vitest';

import {
  POLICY_DENY_REASONS,
  stableErrorCodeForDenyReason,
} from '../../../../src/workflow/admission/remediation.js';
import type { PolicyDenyReason, PolicyVerdict } from '../../../../src/workflow/admission/policy-evaluation.js';
import type { StableErrorCode } from '../../../../src/contract/error-families.js';

/**
 * The runtime deny-reason census and the `PolicyDenyReason` union contain the same members.
 * The two conditional types check each direction.
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
