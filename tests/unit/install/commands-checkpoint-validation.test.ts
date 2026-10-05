/**
 * Content checks on the checkpoint skill source, `content/continuity/skills/checkpoint/SKILL.md`.
 * The Structured Handoff Output must hold the same `### House Rules` block as the rehydrate skill.
 * The rehydrate skill test pins the same strings, so the two tests catch drift between the copies.
 * The checks read the Markdown only and run no skill.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillPath as resolveSkillPath } from '../../../tools/test-helpers/content-tree.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillPath = resolveSkillPath('checkpoint');

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

  /**
   * The sentence must match the rehydrate skill byte for byte. The neutral render
   * uses the bare verb `delegate`, with no `/exarchos:` prefix.
   */
  it('renders the discipline reminder sentence verbatim per brief §5.4', () => {
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
 * The House Rules block is an addition. The summary heading, the task counts and the
 * resume instructions must stay in the skill.
 */
describe('CheckpointSkill_SummaryPreservation (T-31, P3; DR-3 fold-in)', () => {
  const body = readFileSync(skillPath, 'utf-8');

  it('preserves the "Checkpoint Saved" summary heading', () => {
    expect(body).toContain('## Checkpoint Saved');
  });

  it('preserves the task-counts line in the Progress section', () => {
    expect(body).toContain('Tasks: X/Y complete');
  });

  /** The neutral render names the bare verb `rehydrate`, with no `/exarchos:` prefix. */
  it('preserves the Resume Instructions block pointing back at the rehydrate verb', () => {
    expect(body).toContain('### Resume Instructions');
    expect(body).toContain('run `rehydrate`');
  });
});
