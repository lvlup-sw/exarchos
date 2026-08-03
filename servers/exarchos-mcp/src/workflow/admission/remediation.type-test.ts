import { it, expect } from 'vitest';

import {
  POLICY_DENY_REASONS,
  stableErrorCodeForDenyReason,
} from './remediation.js';
import type { PolicyDenyReason, PolicyVerdict } from './policy-evaluation.js';
import type { StableErrorCode } from '../../contract/error-families.js';

// ─── Compile-time totality proofs (the real gate is `tsc --noEmit`) ──────────
//
// These `.type-test.ts` assertions fail the TypeScript build — not vitest — if
// the explanation/remediation contract ever loses totality. This is exit-proof
// (e): adding a reason (or a verdict) without an explanation arm is a COMPILE
// error, caught here and by the `assertNever` guards in the modules themselves.

/**
 * Proof 1 — the runtime deny-reason census is EXACTLY the `PolicyDenyReason`
 * union, both directions. Adding a 7th reason without listing it in
 * `DENY_REASON_TABLE` (which backs `POLICY_DENY_REASONS`) drops this to `never`.
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
 * Proof 2 — every deny reason maps to a stable code. This exact-shape
 * `Record<PolicyDenyReason, …>` reconstruction requires an entry per reason;
 * omitting one is a missing-property compile error (TS2741). The values call
 * the real mapper, so the aligned code is always a `StableErrorCode`.
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

/**
 * Proof 3 — the verdict union is closed at exactly three members. Adding a
 * fourth `PolicyVerdict` without an entry here is a missing-property compile
 * error, mirroring the `assertNever(evaluation.verdict)` guard in
 * `explainDecision`.
 */
const _everyVerdictExplained: Record<PolicyVerdict, true> = {
  allow: true,
  deny: true,
  indeterminate: true,
};
void _everyVerdictExplained;

it('remediation type-test anchor', () => {
  // The census list is frozen and matches the union proven above at compile time.
  expect(POLICY_DENY_REASONS.length).toBe(6);
});
