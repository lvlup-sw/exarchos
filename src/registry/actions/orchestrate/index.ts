// ─── exarchos_orchestrate — the action list, assembled by family ─────────────
//
// The families below are concatenated in a FIXED order, and the order is part
// of the surface rather than a formatting detail: it decides the sequence a
// client sees in `describe`, and the recorded action snapshot compares against
// it. Splitting the list across modules is only safe because this file states
// the order in one place — reordering these lines reorders the tool.
//
// The shared `describe` action is appended last, exactly as every other
// composite tool appends it.

import { makeDescribeAction } from '../../describe-actions.js';
import type { BuiltinToolAction } from '../../types.js';
import { coordinationActions } from './coordination.js';
import { gateActions } from './gates.js';
import { mergeActions } from './merge.js';
import { verificationActions } from './verification.js';
import { reviewOpsActions } from './review-ops.js';
import { lifecycleOpsActions } from './lifecycle-ops.js';
import { vcsActions } from './vcs.js';
import { onboardingActions } from './onboarding.js';
import { invariantActions } from './invariants.js';
import { worktreeActions } from './worktree.js';
import { cutoverActions } from './cutover.js';

export const orchestrateActions: readonly BuiltinToolAction[] = [
  ...coordinationActions,
  ...gateActions,
  ...mergeActions,
  ...verificationActions,
  ...reviewOpsActions,
  ...lifecycleOpsActions,
  ...vcsActions,
  ...onboardingActions,
  ...invariantActions,
  ...worktreeActions,
  ...cutoverActions,
  makeDescribeAction('exarchos_orchestrate.describe'),
];
