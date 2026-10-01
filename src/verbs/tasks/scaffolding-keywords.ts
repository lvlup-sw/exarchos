/**
 * Two keyword sets for two routers that recommend the scaffolder agent. Keep
 * the sets disjoint, so that one router does not take the tokens of the other.
 */

/**
 * Matches plan-task titles in `prepare-delegation.ts`. Each token must be
 * specific to scaffolding. A broad token such as 'format' misclassifies
 * substantive tasks as scaffolding work.
 */
export const TASK_SCAFFOLDING_KEYWORDS: readonly string[] = [
  'stub',
  'boilerplate',
  'type def',
  'interface',
  'scaffold',
];

/**
 * Matches review-comment descriptions in `src/review/classifier.ts`. An
 * all-LOW-severity group with a match goes to the scaffolder. The tokens can
 * be broad because they apply only to LOW-severity groups.
 */
export const REVIEW_DOC_NIT_KEYWORDS: readonly string[] = [
  '<remarks>',
  'sealed',
  'orderby',
  'format',
  'xml doc',
];
