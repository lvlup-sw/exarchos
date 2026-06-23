// PR-2 Task F2 (#1370): every command that changes `state.phase` must use
// `action: "transition"`, not `action: "update"` with `updates: { phase: ... }`.
//
// The runtime rejects `updates.phase` with INVALID_INPUT
// (`servers/exarchos-mcp/src/workflow/tools.update.test.ts:49 —
// WorkflowUpdate_RejectsUpdatesContainingPhaseField`). The registry documents
// `update` as "non-phase mutation only" and `transition` as the canonical
// phase-mutation surface that emits `workflow.transition` and runs the HSM
// guard (`servers/exarchos-mcp/src/registry.ts:1031,1067`).
//
// This suite is prose-level: it reads `commands/*.md` and asserts the
// canonical pattern is present, so future edits to these commands cannot
// silently regress to the broken `update + phase` form.
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
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const COMMANDS_WITH_PHASE_TRANSITIONS = [
  // #1581 (design+plan collapse): `/ideate` is NO LONGER a phase-transitioning
  // command. The `ideate`/GATHER phase was removed (task 007 — `plan` is the
  // feature workflow's initial phase), so `/ideate` authors the Design &
  // Rationale section of the unified docs/specs/ artifact WITHIN the `plan`
  // phase, records `artifacts.spec`, and chains to `/plan` without a transition.
  // `/plan` owns the `plan → plan-review` transition. (Was: ideate → plan.)
  { name: 'plan', file: 'commands/plan.md', expectedTargets: ['plan-review', 'delegate'] },
  { name: 'oneshot', file: 'commands/oneshot.md', expectedTargets: ['implementing'] },
  { name: 'review', file: 'commands/review.md', expectedTargets: ['synthesize', 'delegate', 'blocked'] },
  { name: 'synthesize', file: 'commands/synthesize.md', expectedTargets: ['completed'] },
];

/** Escape regex metacharacters so dynamic target strings are matched literally. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('command phase-transition canonical pattern (#1370 PR-2 F2)', () => {
  for (const cmd of COMMANDS_WITH_PHASE_TRANSITIONS) {
    it(`${cmd.name}_PhaseChange_UsesTransitionActionNotUpdatesPhase`, () => {
      const body = fs.readFileSync(path.join(REPO_ROOT, cmd.file), 'utf8');

      // Anti-pattern: `updates: { ... phase: "X" ... }`.
      // The runtime rejects this with INVALID_INPUT per
      // `tools.update.test.ts:49`; the command prose must not instruct it.
      // The `[\s\S]*?` allows the phase key to appear anywhere inside the
      // updates object literal (lazy, single object scope).
      expect(
        body,
        `${cmd.name}: must not instruct \`updates: { phase: ... }\` pattern (runtime rejects with INVALID_INPUT)`,
      ).not.toMatch(/updates\s*:\s*\{[\s\S]*?\bphase\s*:/);
    });

    it(`${cmd.name}_PhaseChange_NamesTransitionAction`, () => {
      const body = fs.readFileSync(path.join(REPO_ROOT, cmd.file), 'utf8');
      expect(
        body,
        `${cmd.name}: must include explicit \`action: "transition"\` for phase changes`,
      ).toMatch(/action:\s*["']transition["']/);
    });

    for (const target of cmd.expectedTargets) {
      it(`${cmd.name}_PhaseChange_DocumentsTransitionTo_${target.replace(/-/g, '_')}`, () => {
        const body = fs.readFileSync(path.join(REPO_ROOT, cmd.file), 'utf8');
        expect(
          body,
          `${cmd.name}: must document \`target: "${target}"\` transition`,
        ).toMatch(new RegExp(`target:\\s*["']${escapeRegex(target)}["']`));
      });
    }
  }
});
