// ─── exarchos_view — the action list, assembled by family ────────────────────
//
// Same rule as the orchestrate list: the concatenation order below IS the
// order clients see, so it is stated once here rather than implied by import
// order. The shared `describe` action is appended last.

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
  if (!('actionContract' in action)) {
    throw new Error(`exarchos_view.${action.name} is missing required actionContract`);
  }
  normalizeActionContract(Reflect.get(action, 'actionContract'), { annotations: action.annotations });
}
