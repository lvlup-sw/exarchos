/**
 * Content checks on the rehydrate skill source, `content/continuity/skills/rehydrate/SKILL.md`.
 * The skill must call the `rehydrate` action of `exarchos_workflow` with a `featureId`.
 * That one call returns the rehydration document. The skill must not send the agent to
 * `exarchos_view pipeline` and then to `exarchos_workflow get` with a `fields` array.
 * The checks read the Markdown only and run no skill.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillPath as resolveSkillPath } from '../../../tools/test-helpers/content-tree.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillPath = resolveSkillPath('rehydrate');

describe('RehydrateSkill_InvocationReturnsDocument (T043, DR-5; DR-3 fold-in)', () => {
  const body = readFileSync(skillPath, 'utf-8');

  it('references the exarchos_workflow MCP tool', () => {
    expect(body).toContain('exarchos_workflow');
  });

  /**
   * Accepts `action: "rehydrate"`, `action="rehydrate"`, or the word `rehydrate` within
   * 200 characters after `exarchos_workflow`.
   */
  it('references the "rehydrate" action on exarchos_workflow', () => {
    const mentionsRehydrateAction =
      /exarchos_workflow[\s\S]{0,200}\brehydrate\b/.test(body) ||
      /\baction\s*[:=]\s*["']rehydrate["']/.test(body);
    expect(mentionsRehydrateAction).toBe(true);
  });

  it('passes featureId to the rehydrate action', () => {
    expect(body).toMatch(/featureId/);
  });

  /**
   * One `rehydrate` call returns the document. The skill must not tell the agent to
   * assemble it from `exarchos_workflow get` calls with a `fields` array.
   */
  it('does NOT invoke the legacy `exarchos_workflow get` fields-array flow', () => {
    expect(body).not.toMatch(/exarchos_workflow\s+get[\s\S]{0,100}fields\s*=\s*\[/);
    expect(body).not.toMatch(/fields\s*=\s*\[\s*["']playbook["']/);
  });

  /**
   * The `rehydrate` action takes `featureId` directly, so pipeline discovery is not the
   * first step. The check rejects only a numbered step 1 that reads
   * "Discover active workflow(s) via MCP: `exarchos_view pipeline`".
   */
  it('does NOT rely on `exarchos_view pipeline` as the primary discovery step', () => {
    expect(body).not.toMatch(/1\.\s*Discover\s+active\s+workflow\(s\)\s+via\s+MCP:\s*`exarchos_view\s+pipeline`/i);
  });
});

/**
 * The Output Format of the rehydrate skill must hold a `### House Rules` block, an
 * `### Event Emission Hints` block, both fallbacks, and the verbatim discipline reminder.
 */
describe('RehydrateSkill_HouseRulesBlock (T-30, P3; DR-3 fold-in)', () => {
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
   * The checkpoint skill test pins the same sentence. The skill source names the bare
   * verb `delegate`, with no `/exarchos:` prefix.
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
