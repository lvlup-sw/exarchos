// ─── Scaffolding Keyword Sets ───────────────────────────────────────────────
//
// Two distinct keyword sets, used by two different routers (PR #1161 split):
//
//   TASK_SCAFFOLDING_KEYWORDS — matches plan-task TITLES. Used by
//     prepare-delegation.ts to recommend the scaffolder agent for cheap
//     setup work. Tokens here must be specific to scaffolding tasks; broad
//     tokens like 'format' would mis-classify substantive tasks (e.g.,
//     "format and lint output for telemetry view") as scaffolding work.
//
//   REVIEW_DOC_NIT_KEYWORDS — matches review-comment DESCRIPTIONS. Used by
//     review/classifier.ts to recommend the scaffolder agent when an
//     all-LOW-severity review group looks like a doc nit. Tokens here can
//     be broad because they're applied only to LOW-severity items already.
//
// Keep the sets disjoint to avoid one consumer accidentally borrowing the
// other's tokens.
// ────────────────────────────────────────────────────────────────────────────

export const TASK_SCAFFOLDING_KEYWORDS: readonly string[] = [
  'stub',
  'boilerplate',
  'type def',
  'interface',
  'scaffold',
];

export const REVIEW_DOC_NIT_KEYWORDS: readonly string[] = [
  '<remarks>',
  'sealed',
  'orderby',
  'format',
  'xml doc',
];
