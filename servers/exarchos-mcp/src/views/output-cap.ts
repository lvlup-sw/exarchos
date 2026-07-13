// ─── Re-export shim: the output-cap kit moved to core/economy (DR-1) ─────────
//
// The deterministic output-cap + measured-size-summary primitives generalized
// out of `views/` into the shared core (`core/economy.ts`) so any dispatch path
// can reuse them, not just the two inventory views. This file remains as a
// thin re-export so existing importers and tests (`./output-cap.js`) keep
// working with byte-identical behavior. New consumers should import from
// `core/economy.js` directly.
// ─────────────────────────────────────────────────────────────────────────────

export {
  DEFAULT_VIEW_ITEM_CAP,
  PIPELINE_DEFAULT_ITEM_CAP,
  SUMMARY_FIRST_PAGE_ITEMS,
  estimateOutputTokens,
  resolveOutputTokenThreshold,
  countBy,
  narrowAffordance,
} from '../core/economy.js';
