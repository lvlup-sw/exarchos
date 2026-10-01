/**
 * The `exarchos_orchestrate` action list, assembled from its families in a fixed order.
 * The order is part of the surface: it sets the sequence in `describe`, and the recorded action
 * snapshot compares against it. The shared `describe` action comes last, as in each visible
 * composite tool.
 */

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
import { executeActions } from './execute.js';
import { prepareActions } from './prepare.js';
import { settleActions } from './settle.js';

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
  ...executeActions,
  ...prepareActions,
  ...settleActions,
  makeDescribeAction('exarchos_orchestrate.describe'),
];
