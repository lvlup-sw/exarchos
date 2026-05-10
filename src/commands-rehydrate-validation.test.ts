/**
 * T043 (DR-5) — `/exarchos:rehydrate` slash command must invoke the
 * first-class `exarchos_workflow.rehydrate` MCP action (registered in T033)
 * rather than the legacy CLI/pipeline-based flow.
 *
 * Prior legacy invocation:
 *   1. `exarchos_view pipeline` to discover active workflows
 *   2. `exarchos_workflow get featureId="<id>" fields=[...]` to fetch playbook
 *
 * New canonical invocation: `exarchos_workflow` tool with
 * `action: "rehydrate"` + `featureId: <arg>` — returns an envelope
 * containing the rehydration document (workflowState, taskProgress,
 * artifacts, blockers, etc.) in a single call.
 *
 * Scope: content-only validation of the command template markdown. No
 * runtime execution required — the command file is consumed by Claude Code
 * as a prompt, not parsed by our TS code.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const commandPath = join(repoRoot, 'commands', 'rehydrate.md');

describe('RehydrateCommand_InvocationReturnsDocument (T043, DR-5)', () => {
  const body = readFileSync(commandPath, 'utf-8');

  it('references the exarchos_workflow MCP tool', () => {
    expect(body).toContain('exarchos_workflow');
  });

  it('references the "rehydrate" action on exarchos_workflow', () => {
    // Accept either the structured MCP form (`action: "rehydrate"` /
    // `action="rehydrate"`) or the bare `exarchos_workflow rehydrate`
    // composite form — both map to handleRehydrate in composite.ts.
    const mentionsRehydrateAction =
      /exarchos_workflow[\s\S]{0,200}\brehydrate\b/.test(body) ||
      /\baction\s*[:=]\s*["']rehydrate["']/.test(body);
    expect(mentionsRehydrateAction).toBe(true);
  });

  it('passes featureId to the rehydrate action', () => {
    expect(body).toMatch(/featureId/);
  });

  it('does NOT invoke the legacy `exarchos_workflow get` fields-array flow', () => {
    // The legacy flow called `exarchos_workflow get` with a `fields` array
    // to assemble the rehydration document client-side. T043 collapses that
    // into a single `rehydrate` action call — so the template must no
    // longer steer the agent toward the legacy multi-call composition.
    expect(body).not.toMatch(/exarchos_workflow\s+get[\s\S]{0,100}fields\s*=\s*\[/);
    expect(body).not.toMatch(/fields\s*=\s*\[\s*["']playbook["']/);
  });

  it('does NOT rely on `exarchos_view pipeline` as the primary discovery step', () => {
    // Legacy step 1 was: `exarchos_view pipeline` then ask user which
    // workflow to rehydrate. The `rehydrate` action now takes featureId
    // directly; discovery (if needed) is a fallback, not the canonical
    // primary step — the command body must not frame pipeline-discovery
    // as the canonical first call.
    expect(body).not.toMatch(/1\.\s*Discover\s+active\s+workflow\(s\)\s+via\s+MCP:\s*`exarchos_view\s+pipeline`/i);
  });
});

/**
 * T-30 (rehydration-machinery-refactor) — `commands/rehydrate.md` Output
 * Format must render the §5.4 brief sketch: a `### House Rules` block
 * (skill / tools / required + auto-emitted events / transition / validation
 * scripts), an `### Event Emission Hints` block with a missing-events
 * fallback, a phase-with-no-playbook fallback, and a verbatim discipline
 * reminder that names the workflow event stream and the delegate path.
 *
 * Scope: content-only validation of the command template. The slash-command
 * markdown is consumed by Claude Code as a prompt; no runtime execution.
 */
describe('RehydrateCommand_HouseRulesBlock (T-30, P3)', () => {
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
    // Verbatim sketch from
    // docs/research/2026-05-08-rehydrate-machinery-reinit.md:183 (mirrored
    // in the brief). Any reword desyncs against the RCA reference and
    // must be caught here.
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
