import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
// DR-3 (harness conform-and-shrink, Task 007): `commands/delegate.md` collapsed
// into a thin shim delegating to `@skills/delegate/SKILL.md` +
// `@skills/git-worktrees/SKILL.md`. The dispatch/event/transition discipline
// migrated into the delegate skill source, so this suite pins the contract in
// its new home. `delegate` is an ORCHESTRATION skill, so its auto-chain uses the
// per-runtime `{{CHAIN}}` render token rather than a literal, harness-specific
// slash-command invocation.
const DELEGATE_SKILL = path.join(REPO_ROOT, 'content/delivery/skills/delegate/SKILL.md');

describe('delegate skill canonical event + transition discipline (#1370 PR-2; DR-3 fold-in)', () => {
  it('DelegateSkill_AnnouncesNoTaskItself_TheRuntimeLeavesTheAssignment', () => {
    // The orchestrator used to emit `task.assigned` by hand before dispatching,
    // because rehydration's `taskProgress` projection was otherwise silently
    // empty. The append is the runtime's now: `prepare` leaves it in the same
    // commit as the prepared record, `prepare_delegation` ahead of its readiness
    // read. So the skill must SAY who announces, and must not instruct an
    // `exarchos_event` append of the type on either path.
    const body = fs.readFileSync(DELEGATE_SKILL, 'utf8');
    expect(body, 'delegate skill must name the announcement').toMatch(/task\.assigned/);
    expect(body, 'delegate skill must name prepare as an announcer').toMatch(
      /`prepare`[^\n]*announces[^\n]*`task\.assigned`|announces[^\n]*`task\.assigned`[^\n]*`prepare`/,
    );
    expect(body, 'delegate skill must name prepare_delegation as the primitive-path announcer').toMatch(
      /prepare_delegation[^\n]*announces[^\n]*`task\.assigned`|`task\.assigned`[^\n]*prepare_delegation/,
    );
    expect(
      body,
      'delegate skill must not instruct a task.assigned append',
    ).not.toMatch(/type:\s*["']task\.assigned["']/);
  });

  it('DelegateCommand_AutoChain_UsesTransitionActionNotImplicitUpdate', () => {
    // The auto-chain must transition through the canonical mechanism, not a
    // prose-level "Set phase to ..." the model would translate to the rejected
    // `update {phase}` form. For this orchestration skill the canonical
    // mechanism is the `{{CHAIN}}` render token, which the build expands into
    // each harness's phase-advancing invocation.
    const body = fs.readFileSync(DELEGATE_SKILL, 'utf8');
    expect(
      body,
      'delegate skill must auto-chain via the canonical `{{CHAIN}}` render token',
    ).toMatch(/\{\{CHAIN\s+next=/);
  });

  it('DelegateCommand_AutoChain_DocumentsTransitionTargets', () => {
    const body = fs.readFileSync(DELEGATE_SKILL, 'utf8');
    // Normal/--fixes mode auto-chains to `review`. (The `--pr-fixes → synthesize`
    // auto-chain was deprecated and superseded by the `shepherd` skill for PR
    // feedback workflows — see `content/delivery/skills/delegate/SKILL.md` "Deprecated" note —
    // so delegate no longer documents a synthesize target.)
    expect(
      body,
      'delegate skill must auto-chain to the review phase',
    ).toMatch(/\{\{CHAIN\s+next="review"/);
  });

  it('DelegateCommand_NoLegacy_UpdatesPhasePattern', () => {
    // Anti-pattern from the systemic F2 bug — must not appear in the delegate
    // skill body either.
    const body = fs.readFileSync(DELEGATE_SKILL, 'utf8');
    expect(
      body,
      'delegate skill must not instruct `updates: { phase: ... }` pattern',
    ).not.toMatch(/updates\s*:\s*\{[^}]*\bphase\s*:/s);
  });
});
