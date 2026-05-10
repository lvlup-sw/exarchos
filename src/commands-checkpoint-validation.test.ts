/**
 * T-31 (rehydration-machinery-refactor) — `commands/checkpoint.md` Output
 * Format must render the same `### House Rules` block as rehydrate.md so the
 * agent producing the checkpoint sees the contract it was operating under
 * before context clears (correctness signal symmetry with `/exarchos:rehydrate`).
 *
 * Per plan §T-31:
 *   - rendered checkpoint output contains the `### House Rules` block when
 *     phase has a registered playbook
 *   - the summary section ("Checkpoint Saved", task counts) is **preserved**
 *
 * Per plan §T-31 REFACTOR: the slash-command system does not have a snippet
 * primitive, so the House Rules block is duplicated verbatim between
 * checkpoint.md and rehydrate.md. These assertions guard against drift
 * between the two templates.
 *
 * Scope: content-only validation of the command template markdown. The
 * slash-command markdown is consumed by Claude Code as a prompt; no runtime
 * execution required.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const commandPath = join(repoRoot, 'commands', 'checkpoint.md');

describe('CheckpointCommand_HouseRulesBlock (T-31, P3)', () => {
  const body = readFileSync(commandPath, 'utf-8');

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
    // Verbatim from rehydrate.md (T-30). Keeping the two templates byte-identical
    // for this sentence is the whole point of the symmetry — any reword desyncs
    // against the RCA reference and must be caught here.
    const disciplineReminder =
      '> **Discipline reminder:** every task transition this turn forward MUST land on the workflow event stream via `exarchos_event.append` or `/exarchos:delegate` subagent emission. Direct `Edit` / `Bash` / `git` actions on task branches without corresponding events will desync the workflow tracker (see RCA `docs/rca/2026-05-08-rehydrate-behavioral-gap.md`).';
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
 * guard against accidental deletion of the summary during the rewrite.
 */
describe('CheckpointCommand_SummaryPreservation (T-31, P3)', () => {
  const body = readFileSync(commandPath, 'utf-8');

  it('preserves the "Checkpoint Saved" summary heading', () => {
    expect(body).toContain('## Checkpoint Saved');
  });

  it('preserves the task-counts line in the Progress section', () => {
    // The pre-T-31 template rendered `- Tasks: X/Y complete` under `### Progress`.
    expect(body).toContain('Tasks: X/Y complete');
  });

  it('preserves the Resume Instructions block pointing back at /exarchos:rehydrate', () => {
    expect(body).toContain('### Resume Instructions');
    expect(body).toContain('/exarchos:rehydrate');
  });
});
