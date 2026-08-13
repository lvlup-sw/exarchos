// PR-2 Task F2 (#1370): every surface that changes `state.phase` must use the
// canonical phase-mutation mechanism, never `action: "update"` with
// `updates: { phase: ... }`.
//
// The runtime rejects `updates.phase` with INVALID_INPUT
// (`src/workflow/tools.update.test.ts:49 —
// WorkflowUpdate_RejectsUpdatesContainingPhaseField`). The registry documents
// `update` as "non-phase mutation only" and `transition` as the canonical
// phase-mutation surface that emits `workflow.transition` and runs the HSM
// guard (`src/registry.ts:1031,1067`).
//
// DR-3 (harness conform-and-shrink, Task 007): the fat `commands/*.md` bodies
// collapsed into thin shims that delegate to `@skills/<verb>/SKILL.md`; the
// phase-transition prose migrated into the skill sources in logical,
// prefix-free form. This suite therefore pins the canonical pattern in its new
// home — the skill sources — so a command→skill fold cannot silently regress
// the transition discipline. Each skill's canonical phase-change mechanism is
// the `transition` action, EXCEPT `oneshot`, whose plan→implementing and
// implementing→{completed,synthesize} moves are HSM-automatic via
// `finalize_oneshot` (a UML choice state), so its mechanism marker is that verb.
//
// The skills express transition TARGETS as phase names in prose (the collapsed
// logical form uses `target: "<phase-placeholder>"` in call sketches plus
// prose phase references), not the command-era literal `target: "plan-review"`,
// so the per-target assertion pins that the skill still names each downstream
// phase — a dropped transition target still fails.
//
// Audit source of truth:
// `docs/research/2026-05-18-phase-transition-invariant-audit.md` (per-command
// rows for ideate, plan, oneshot, review, synthesize in the findings table
// and the per-command walks).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const SKILLS_WITH_PHASE_TRANSITIONS: ReadonlyArray<{
  name: string;
  file: string;
  /** The canonical phase-change mechanism marker the skill must contain. */
  mechanism: RegExp;
  expectedTargets: readonly string[];
}> = [
  // #1581 (design+plan collapse): `ideate` is NO LONGER a phase-transitioning
  // surface. The `ideate`/GATHER phase was removed (Task 007 — `plan` is the
  // feature workflow's initial phase), so `ideate` authors the Design &
  // Rationale section of the unified docs/specs/ artifact WITHIN the `plan`
  // phase, records `artifacts.spec`, and chains to `plan` without a transition.
  // `plan` owns the `plan → plan-review` transition. (Was: ideate → plan.)
  { name: 'plan', file: 'content/design/skills/plan/SKILL.md', mechanism: /action:\s*["']transition["']/, expectedTargets: ['plan-review', 'delegate'] },
  // `oneshot` transitions are HSM-automatic (choice state at finalize), not a
  // model-emitted `transition` call — its canonical marker is `finalize_oneshot`.
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
    it(`${cmd.name}_PhaseChange_UsesTransitionActionNotUpdatesPhase`, () => {
      const body = fs.readFileSync(path.join(REPO_ROOT, cmd.file), 'utf8');

      // Anti-pattern: `updates: { ... phase: "X" ... }` — the `phase` key
      // INSIDE the `updates` object literal. The runtime rejects this with
      // INVALID_INPUT per `tools.update.test.ts:49`; the skill prose must not
      // instruct it. `[^}]*` scopes the match to a single object literal (it
      // cannot cross a closing brace) — the same form `delegate-prose.test.ts`
      // uses. This matters against a full skill body (vs the old short command
      // body): a lazy `[\s\S]*?` would bridge an unrelated `updates: {` to a
      // `phase:` in a later, separate code block (e.g. oneshot's `set` sketch
      // that teaches `phase` as a TOP-LEVEL argument, explicitly NOT inside
      // `updates`), a false positive.
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
