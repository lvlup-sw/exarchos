/**
 * Each skill that changes the workflow phase must use the canonical mechanism, and never
 * `action: "update"` with `updates: { phase: ... }`. The runtime rejects a `phase` key in
 * `updates` with `INVALID_INPUT`.
 *
 * The suite reads the skill sources, because each command is a shim that points to its skill.
 * A skill names a transition target as a phase name in prose, so the target check is a
 * word match on the phase name.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const SKILLS_WITH_PHASE_TRANSITIONS: ReadonlyArray<{
  name: string;
  file: string;
  /** The canonical phase-change mechanism marker the skill must contain. */
  mechanism: RegExp;
  expectedTargets: readonly string[];
}> = [
  /**
   * `ideate` is absent: it writes inside the `plan` phase and makes no transition.
   * `plan` owns the transition to `plan-review`.
   */
  { name: 'plan', file: 'content/design/skills/plan/SKILL.md', mechanism: /action:\s*["']transition["']/, expectedTargets: ['plan-review', 'delegate'] },
  /** `finalize_oneshot` resolves the choice between `completed` and `synthesize`, so that verb is the marker. */
  { name: 'oneshot', file: 'content/delivery/skills/oneshot/SKILL.md', mechanism: /finalize_oneshot/, expectedTargets: ['implementing'] },
  { name: 'review', file: 'content/review/skills/review/SKILL.md', mechanism: /action:\s*["']transition["']/, expectedTargets: ['synthesize', 'delegate', 'blocked'] },
  { name: 'synthesize', file: 'content/synthesis/skills/synthesize/SKILL.md', mechanism: /action:\s*["']transition["']/, expectedTargets: ['completed'] },
];

/** Escape regex metacharacters so dynamic target strings are matched literally. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('command phase-transition canonical pattern (#1370 PR-2 F2; DR-3 fold-in)', () => {
  for (const cmd of SKILLS_WITH_PHASE_TRANSITIONS) {
    /**
     * `[^}]*` keeps the match inside one object literal. A lazy `[\s\S]*?` joins an unrelated
     * `updates: {` to a `phase:` in a later code block, which is a false positive.
     */
    it(`${cmd.name}_PhaseChange_UsesTransitionActionNotUpdatesPhase`, () => {
      const body = fs.readFileSync(path.join(REPO_ROOT, cmd.file), 'utf8');

      expect(
        body,
        `${cmd.name}: must not instruct \`updates: { phase: ... }\` pattern (runtime rejects with INVALID_INPUT)`,
      ).not.toMatch(/updates\s*:\s*\{[^}]*\bphase\s*:/);
    });

    it(`${cmd.name}_PhaseChange_NamesTransitionAction`, () => {
      const body = fs.readFileSync(path.join(REPO_ROOT, cmd.file), 'utf8');
      expect(
        body,
        `${cmd.name}: must document the canonical phase-change mechanism (${cmd.mechanism})`,
      ).toMatch(cmd.mechanism);
    });

    for (const target of cmd.expectedTargets) {
      it(`${cmd.name}_PhaseChange_DocumentsTransitionTo_${target.replace(/-/g, '_')}`, () => {
        const body = fs.readFileSync(path.join(REPO_ROOT, cmd.file), 'utf8');
        expect(
          body,
          `${cmd.name}: must document the transition target phase "${target}"`,
        ).toMatch(new RegExp(`\\b${escapeRegex(target)}\\b`));
      });
    }
  }
});
