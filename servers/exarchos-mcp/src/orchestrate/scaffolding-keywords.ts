// ─── Scaffolding Keywords ───────────────────────────────────────────────────
//
// Shared keyword set used by two routers:
//   - prepare-delegation.ts classifies plan tasks as scaffolding work
//   - review/classifier.ts routes all-LOW review-comment groups to the
//     scaffolder agent when at least one item description matches a keyword
//
// Original five keywords ('stub', 'boilerplate', 'type def', 'interface',
// 'scaffold') target plan-task titles. The doc-nit additions ('<remarks>',
// 'sealed', 'orderby', 'format', 'xml doc') target review comments authored
// by automated reviewers (CodeRabbit, Sentry) that flag style/doc issues
// suitable for the scaffolder's faster, cheaper context (#1159 design Q-P5).
// ────────────────────────────────────────────────────────────────────────────

export const SCAFFOLDING_KEYWORDS: readonly string[] = [
  // Plan-task scaffolding
  'stub',
  'boilerplate',
  'type def',
  'interface',
  'scaffold',
  // Review-comment doc nits (#1159)
  '<remarks>',
  'sealed',
  'orderby',
  'format',
  'xml doc',
];
