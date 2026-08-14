// ─── exarchos_view — the action list, assembled by family ────────────────────
//
// Same rule as the orchestrate list: the concatenation order below IS the
// order clients see, so it is stated once here rather than implied by import
// order. The shared `describe` action is appended last.

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
