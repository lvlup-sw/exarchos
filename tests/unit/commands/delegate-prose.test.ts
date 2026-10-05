import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
/** The delegate skill source. The `delegate` command is a shim that points to this skill. */
const DELEGATE_SKILL = path.join(REPO_ROOT, 'content/delivery/skills/delegate/SKILL.md');

describe('delegate skill canonical event + transition discipline (#1370 PR-2; DR-3 fold-in)', () => {
  /**
   * The runtime appends `task.assigned`. The skill must name `prepare` and
   * `prepare_delegation` as the announcers, and must not instruct an append of that event.
   */
  it('DelegateSkill_AnnouncesNoTaskItself_TheRuntimeLeavesTheAssignment', () => {
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

  /**
   * The skill must chain with the `{{CHAIN}}` render token. The build expands the token
   * into the invocation of each harness.
   */
  it('DelegateCommand_AutoChain_UsesTransitionActionNotImplicitUpdate', () => {
    const body = fs.readFileSync(DELEGATE_SKILL, 'utf8');
    expect(
      body,
      'delegate skill must auto-chain via the canonical `{{CHAIN}}` render token',
    ).toMatch(/\{\{CHAIN\s+next=/);
  });

  /** `review` is the only chain target. The `shepherd` skill owns the PR feedback workflow. */
  it('DelegateCommand_AutoChain_DocumentsTransitionTargets', () => {
    const body = fs.readFileSync(DELEGATE_SKILL, 'utf8');
    expect(
      body,
      'delegate skill must auto-chain to the review phase',
    ).toMatch(/\{\{CHAIN\s+next="review"/);
  });

  it('DelegateCommand_NoLegacy_UpdatesPhasePattern', () => {
    const body = fs.readFileSync(DELEGATE_SKILL, 'utf8');
    expect(
      body,
      'delegate skill must not instruct `updates: { phase: ... }` pattern',
    ).not.toMatch(/updates\s*:\s*\{[^}]*\bphase\s*:/s);
  });
});
