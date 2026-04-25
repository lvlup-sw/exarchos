// Phases that pause auto-continue for explicit human approval.
//
// Relocated from workflow/next-action.ts (deleted in the rehydrate-foundation
// follow-up #9 cleanup). Kept as a standalone module so callers — currently
// `cli-commands/assemble-context.ts` for the markdown next-action line — do
// not have to depend on the legacy handler shape that wrapped this constant.
//
// Adding a new workflow type? Register its checkpoint phases here. Adding a
// new checkpoint phase to an existing type? Append to the matching Set.

export const HUMAN_CHECKPOINT_PHASES: Record<string, ReadonlySet<string>> = {
  feature: new Set(['plan-review', 'synthesize']),
  debug: new Set(['hotfix-validate', 'synthesize']),
  refactor: new Set(['overhaul-plan-review', 'polish-update-docs', 'synthesize']),
};
