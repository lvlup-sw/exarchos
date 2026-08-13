/**
 * T-31 (rehydration-machinery-refactor) — the checkpoint **skill** Structured
 * Handoff Output must render the same `### House Rules` block as the rehydrate
 * skill so the agent producing the checkpoint sees the contract it was
 * operating under before context clears (correctness signal symmetry with
 * `rehydrate`).
 *
 * DR-3 (harness conform-and-shrink, Task 007): the fat `commands/checkpoint.md`
 * body was collapsed into a thin shim and its structured-handoff output
 * template migrated into `skills-src/checkpoint/SKILL.md`. This suite now pins
 * the block in its new home — the skill source — so the contract cannot silently
 * regress after the command→skill fold.
 *
 * Per plan §T-31:
 *   - the handoff output contains the `### House Rules` block when the phase
 *     has a registered playbook
 *   - the summary section ("Checkpoint Saved", task counts) is **preserved**
 *
 * Per plan §T-31 REFACTOR: the House Rules block is duplicated verbatim between
 * the checkpoint and rehydrate skills (no shared-snippet primitive). These
 * assertions guard against drift between the two templates.
 *
 * Scope: content-only validation of the skill source markdown. The skill is
 * consumed by the agent as a prompt; no runtime execution required.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const skillPath = join(repoRoot, 'skills-src', 'checkpoint', 'SKILL.md');

describe('CheckpointSkill_HouseRulesBlock (T-31, P3; DR-3 fold-in)', () => {
  const body = readFileSync(skillPath, 'utf-8');

  it('renders an `### House Rules` heading', () => {
    expect(body).toContain('### House Rules');
  });

  it('mentions the `task.progressed` event so agents know to emit task progress', () => {
    expect(body).toContain('task.progressed');
  });

  it('still references `exarchos_event` as the event-emission entry point', () => {
    expect(body).toContain('exarchos_event');
  });

  it('renders the always-on missing-events fallback `(none — phase machinery satisfied)`', () => {
    expect(body).toContain('(none — phase machinery satisfied)');
  });

  it('renders a `(no playbook for this phase)` fallback for phases without a playbook', () => {
    expect(body).toContain('(no playbook for this phase)');
  });

  it('renders the discipline reminder sentence verbatim per brief §5.4', () => {
    // Verbatim from the rehydrate skill (T-30). Keeping the two templates
    // byte-identical for this sentence is the whole point of the symmetry —
    // any reword desyncs against the RCA reference and must be caught here.
    // Post-DR-3 the collapsed vocabulary uses the bare verb `delegate` (the
    // neutral render carries no `/exarchos:` prefix — enforced by the
    // migration NoClaudePrefixes invariant).
    const disciplineReminder =
      '> **Discipline reminder:** every task transition this turn forward MUST land on the workflow event stream via `exarchos_event.append` or `delegate` subagent emission. Direct `Edit` / `Bash` / `git` actions on task branches without corresponding events will desync the workflow tracker (see RCA `docs/rca/2026-05-08-rehydrate-behavioral-gap.md`).';
    expect(body).toContain(disciplineReminder);
  });

  it('exposes the auto-emitted-events vs model-emitted-events distinction', () => {
    expect(body).toContain('Required model-emitted events');
    expect(body).toContain('Auto-emitted events');
  });

  it('renders an `### Event Emission Hints` section', () => {
    expect(body).toContain('### Event Emission Hints');
  });
});

/**
 * T-31 also requires that the existing checkpoint summary content
 * ("Checkpoint Saved", task counts, resume instructions) is preserved —
 * the House Rules block is *appended*, not a replacement. These assertions
 * guard against accidental deletion of the summary during the command→skill
 * fold.
 */
describe('CheckpointSkill_SummaryPreservation (T-31, P3; DR-3 fold-in)', () => {
  const body = readFileSync(skillPath, 'utf-8');

  it('preserves the "Checkpoint Saved" summary heading', () => {
    expect(body).toContain('## Checkpoint Saved');
  });

  it('preserves the task-counts line in the Progress section', () => {
    // The template renders `- Tasks: X/Y complete` under `### Progress`.
    expect(body).toContain('Tasks: X/Y complete');
  });

  it('preserves the Resume Instructions block pointing back at the rehydrate verb', () => {
    expect(body).toContain('### Resume Instructions');
    // Bare verb post-DR-3 — the neutral skill render carries no `/exarchos:` prefix.
    expect(body).toContain('run `rehydrate`');
  });
});
