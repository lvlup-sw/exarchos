/**
 * The `exarchos_view` action list, put together by family. The order of the list is the order
 * that clients see. The shared `describe` action is last.
 */

import { normalizeActionContract } from '../../action-contract.js';
import { makeDescribeAction } from '../../describe-actions.js';
import type { BuiltinToolAction } from '../../types.js';
import { coreViewActions } from './core.js';
import { qualityViewActions } from './quality.js';
import { lifecycleViewActions } from './lifecycle.js';

export const viewActions: readonly BuiltinToolAction[] = [
  ...coreViewActions,
  ...qualityViewActions,
  ...lifecycleViewActions,
  makeDescribeAction('exarchos_view.describe'),
];

for (const action of viewActions) {
  normalizeActionContract(action.actionContract, { annotations: action.annotations });
}
