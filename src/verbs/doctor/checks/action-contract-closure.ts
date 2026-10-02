/**
 * Doctor check: does the contract of each registered action still hold together in this build?
 *
 * The closure evaluator asks four questions per action. Is the contract total, with each
 * dimension present or reasoned-absent? Are its references live? Are its recovery edges not expired?
 * Do the shipped projections agree with the declaration?
 *
 * The check is read-only. It has no `--fix`, because a drifted contract needs a source change.
 */

import {
  collectLiveActionContractSubjects,
  evaluateCollectedActionContractClosure,
} from '../../../contract/action-contract-closure.js';
import type { CheckFn } from './__shared__/make-stub-probes.js';

/** Findings named individually before the message falls back to a count. */
const NAMED_FINDING_LIMIT = 3;

/** An empty registry gives Warning, not Pass, because zero subjects close vacuously. */
export const actionContractClosure: CheckFn = async (_probes, _signal) => {
  const start = Date.now();
  const base = { category: 'invariants' as const, name: 'action-contract-closure' };

  let subjectCount = 0;
  let findings: readonly { readonly actionId: string; readonly code: string }[] = [];
  let closed = false;
  try {
    const subjects = collectLiveActionContractSubjects();
    subjectCount = subjects.length;
    const result = evaluateCollectedActionContractClosure(subjects);
    closed = result.closed;
    findings = result.findings;
  } catch (error) {
    return {
      ...base,
      status: 'Warning',
      message: `Action-contract closure could not be evaluated: ${
        error instanceof Error ? error.message : String(error)
      }`,
      fix:
        'The evaluator threw rather than reporting a verdict, which usually means a ' +
        'malformed contract declaration reached the registry. Run ' +
        '`npx vitest run tests/architecture/action-contract-closure.test.ts` for the ' +
        'failing subject.',
      durationMs: Date.now() - start,
    };
  }

  if (subjectCount === 0) {
    return {
      ...base,
      status: 'Warning',
      message: 'Action-contract closure measured 0 registered actions — the registry read empty',
      fix:
        'The live registry resolved no actions, so this check has nothing to judge and ' +
        'its verdict would be vacuous. Verify the build is complete (`npm run build`) ' +
        'before trusting any registry-derived output.',
      durationMs: Date.now() - start,
    };
  }

  if (!closed) {
    const named = findings
      .slice(0, NAMED_FINDING_LIMIT)
      .map((finding) => `${finding.actionId} (${finding.code})`)
      .join(', ');
    const more =
      findings.length > NAMED_FINDING_LIMIT
        ? ` (+${findings.length - NAMED_FINDING_LIMIT} more)`
        : '';
    return {
      ...base,
      status: 'Warning',
      message:
        `Action-contract closure failed on ${findings.length} of ${subjectCount} ` +
        `registered action(s): ${named}${more}`,
      fix:
        'A registered action declares a contract its shipped projection no longer ' +
        'matches, or leaves a dimension neither declared nor reasoned-absent. Reconcile ' +
        'the declaration with what describe and the compiler project for it; ' +
        '`npx vitest run tests/architecture/action-contract-closure.test.ts` names every ' +
        'finding.',
      durationMs: Date.now() - start,
    };
  }

  return {
    ...base,
    status: 'Pass',
    message: `All ${subjectCount} registered action contracts are closed`,
    durationMs: Date.now() - start,
  };
};
