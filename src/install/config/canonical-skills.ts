/**
 * T1 (v2.10.1 Bundle A, #1472) — Canonical command → skill source-of-truth.
 *
 * `COMMAND_TO_SKILL` is the single authoritative mapping from a canonical
 * workflow command name (the `commands/<name>.md` slash command, e.g. `/ideate`)
 * to the underlying skill directory name(s) under `skills-src/<dir>/` that the
 * command delegates to. Downstream consumers (T2 alias emission, T5 docs) read
 * this map instead of re-deriving it, so there is exactly one place the mapping
 * lives.
 *
 * Derived from the "Skill Reference" prose in each command file — specifically
 * every `@skills/<dir>/SKILL.md` entry-point reference. Post the atomic rename
 * wave (DR-3) the map collapses toward identity — the command verb equals the
 * skill directory name — but a command may still reference more than one skill:
 *   - `delegate`  → `delegate` + `git-worktrees`
 *   - `oneshot`   → `oneshot` + `synthesize`
 *   - `review`    → `review` + `mutation-adequacy`
 *
 * `@skills/<dir>/references/*.md` include paths are NOT skill entry points and
 * are deliberately excluded.
 *
 * Commands that delegate to no skill are listed in `COMMAND_ONLY` and MUST NOT
 * appear in `COMMAND_TO_SKILL`. The co-located drift guard
 * (`canonical-skills.test.ts`) re-derives this map from the actual command files
 * and fails CI on any divergence.
 */

/**
 * Canonical command name → sorted list of skill directory names it delegates to.
 * Skill dirs are sorted to give a stable, comparable shape for the drift guard.
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
 * Canonical commands that delegate to no skill — they carry their own inline
 * prompt (or defer to a `rules/*.md` rule) rather than chaining into a skill.
 */
export const COMMAND_ONLY: ReadonlySet<string> = new Set<string>([
  'autocompact',
  'tag',
]);

/**
 * The canonical set of workflow command names: the sorted union of every
 * skill-delegating command (`COMMAND_TO_SKILL` keys) and every command-only
 * command (`COMMAND_ONLY`). This is the one accessor downstream consumers
 * read to learn "which `/commands` exist" without re-deriving the set from
 * the two underlying structures (or, worse, hand-maintaining a third copy).
 */
export function canonicalCommandSet(): readonly string[] {
  return [...Object.keys(COMMAND_TO_SKILL), ...COMMAND_ONLY].sort();
}
