import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DELEGATE_COMMAND = path.join(REPO_ROOT, 'commands/delegate.md');

describe('delegate.md canonical event + transition discipline (#1370 PR-2)', () => {
  it('DelegateCommand_DispatchBlock_InstructsTaskAssignedEventEmission', () => {
    // Per [memory: feedback_orchestrator_task_assigned_emission], the orchestrator
    // must emit a `task.assigned` event before dispatching a subagent — otherwise
    // rehydration's `taskProgress` projection is silently empty.
    const body = fs.readFileSync(DELEGATE_COMMAND, 'utf8');
    expect(
      body,
      'delegate.md must instruct task.assigned event emission per dispatch',
    ).toMatch(/task\.assigned/);
    expect(
      body,
      'delegate.md must reference exarchos_event with type task.assigned',
    ).toMatch(/exarchos_event[^.]*type[^.]*task\.assigned/s);
  });

  it('DelegateCommand_AutoChain_UsesTransitionActionNotImplicitUpdate', () => {
    // The auto-chain section must instruct the model to use `action: "transition"`
    // for the phase change, not a prose-level "Set phase to ..." that the model
    // would translate to the rejected `update {phase}` form.
    const body = fs.readFileSync(DELEGATE_COMMAND, 'utf8');
    expect(
      body,
      'delegate.md must include explicit `action: "transition"` for phase changes',
    ).toMatch(/action:\s*["']transition["']/);
  });

  it('DelegateCommand_AutoChain_DocumentsTransitionTargets', () => {
    const body = fs.readFileSync(DELEGATE_COMMAND, 'utf8');
    // Normal/--fixes mode → review. --pr-fixes mode → synthesize.
    expect(body).toMatch(/target:\s*["']review["']/);
    expect(body).toMatch(/target:\s*["']synthesize["']/);
  });

  it('DelegateCommand_NoLegacy_UpdatesPhasePattern', () => {
    // Anti-pattern from the systemic F2 bug — must not appear in delegate.md either.
    const body = fs.readFileSync(DELEGATE_COMMAND, 'utf8');
    expect(
      body,
      'delegate.md must not instruct `updates: { phase: ... }` pattern',
    ).not.toMatch(/updates\s*:\s*\{[^}]*\bphase\s*:/s);
  });
});
