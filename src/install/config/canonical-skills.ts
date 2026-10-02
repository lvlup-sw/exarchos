/**
 * Canonical map from a workflow command name to the skill directories that the
 * command delegates to. Consumers read this map and do not derive it again.
 *
 * The map comes from the `@skills/<dir>/SKILL.md` references in the command files.
 * `@skills/<dir>/references/*.md` paths are not skill entry points.
 * Most commands map to the skill of the same name. Some commands also use a
 * second skill.
 *
 * A command that delegates to no skill goes in `COMMAND_ONLY`, not in
 * `COMMAND_TO_SKILL`. `canonical-skills.test.ts` derives the map again from the
 * command files and fails on a difference.
 */

/**
 * Command name to the sorted skill directory names that it delegates to. The
 * sort gives the drift test a stable shape.
 */
export const COMMAND_TO_SKILL: Readonly<Record<string, readonly string[]>> = {
  checkpoint: ['checkpoint'],
  cleanup: ['cleanup'],
  debug: ['debug'],
  delegate: ['delegate', 'git-worktrees'],
  discover: ['discover'],
  dogfood: ['dogfood'],
  ideate: ['ideate'],
  invariants: ['invariants'],
  oneshot: ['oneshot', 'synthesize'],
  plan: ['plan'],
  prune: ['prune'],
  refactor: ['refactor'],
  rehydrate: ['rehydrate'],
  review: ['mutation-adequacy', 'review'],
  shepherd: ['shepherd'],
  synthesize: ['synthesize'],
} as const;

/**
 * Canonical commands that delegate to no skill. Each one carries its own
 * prompt or defers to a `rules/*.md` rule.
 */
export const COMMAND_ONLY: ReadonlySet<string> = new Set<string>([
  'autocompact',
  'tag',
]);

/**
 * Return the sorted canonical command names: the keys of `COMMAND_TO_SKILL`
 * and the members of `COMMAND_ONLY`.
 */
export function canonicalCommandSet(): readonly string[] {
  return [...Object.keys(COMMAND_TO_SKILL), ...COMMAND_ONLY].sort();
}
