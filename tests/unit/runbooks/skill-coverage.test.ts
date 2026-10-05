import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillDir } from '../../../tools/test-helpers/content-tree.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(__dirname, '../../../content');

/**
 * Reads `<skill>/<rest…>` from the authored `content/` tree, not from a rendered runtime variant.
 * A runbook reference is the same in every runtime variant, so one check on the source is enough.
 * The first segment is a skill name, and `skillDir` finds the domain that owns it.
 */
function readSkillFile(relativePath: string): string {
  const [name, ...rest] = relativePath.split('/');
  return readFileSync(resolve(skillDir(name), ...rest), 'utf-8');
}

/**
 * Passes when the content holds `action: "runbook"` and the quoted id, each at any position.
 * It also passes when the content holds `id: "<runbookId>"`.
 */
function assertRunbookReference(content: string, runbookId: string): void {
  const hasRunbookAction = content.includes('action: "runbook"') && content.includes(`"${runbookId}"`);
  const hasRunbookIdField = content.includes(`id: "${runbookId}"`);
  expect(
    hasRunbookAction || hasRunbookIdField,
    `Expected reference to runbook "${runbookId}" (e.g., action: "runbook", id: "${runbookId}")`,
  ).toBe(true);
}

describe('Skill coverage — runbook references', () => {
  it('SkillCoverage_DelegationSkill_ReferencesTaskCompletionRunbook', () => {
    const content = readSkillFile('delegate/SKILL.md');
    assertRunbookReference(content, 'task-completion');
  });

  it('SkillCoverage_DelegationSkill_ReferencesAgentTeamsSagaRunbook', () => {
    const content = readSkillFile('delegate/references/agent-teams-saga.md');
    assertRunbookReference(content, 'agent-teams-saga');
  });

  it('SkillCoverage_ReviewSkill_ReferencesQualityEvaluationRunbook', () => {
    const content = readSkillFile('review/SKILL.md');
    assertRunbookReference(content, 'quality-evaluation');
  });

  it('SkillCoverage_SynthesisSkill_ReferencesSynthesisFlowRunbook', () => {
    const content = readSkillFile('synthesize/SKILL.md');
    assertRunbookReference(content, 'synthesis-flow');
  });

  it('SkillCoverage_ShepherdSkill_ReferencesShepherdIterationRunbook', () => {
    const content = readSkillFile('shepherd/SKILL.md');
    assertRunbookReference(content, 'shepherd-iteration');
  });

  it('SkillCoverage_DebugSkill_ReferencesTriageDecisionRunbook', () => {
    const content = readSkillFile('debug/SKILL.md');
    assertRunbookReference(content, 'triage-decision');
  });

  it('SkillCoverage_DebugSkill_ReferencesInvestigationDecisionRunbook', () => {
    const content = readSkillFile('debug/SKILL.md');
    assertRunbookReference(content, 'investigation-decision');
  });

  it('SkillCoverage_RefactorSkill_ReferencesScopeDecisionRunbook', () => {
    const content = readSkillFile('refactor/SKILL.md');
    assertRunbookReference(content, 'scope-decision');
  });

  it('SkillCoverage_DelegationSkill_ReferencesDispatchDecisionRunbook', () => {
    const content = readSkillFile('delegate/SKILL.md');
    assertRunbookReference(content, 'dispatch-decision');
  });

  it('SkillCoverage_ReviewSkill_ReferencesReviewEscalationRunbook', () => {
    const content = readSkillFile('review/SKILL.md');
    assertRunbookReference(content, 'review-escalation');
  });

  it('SkillCoverage_ShepherdSkill_ReferencesShepherdEscalationRunbook', () => {
    const content = readSkillFile('shepherd/SKILL.md');
    assertRunbookReference(content, 'shepherd-escalation');
  });

  it('SkillCoverage_DelegationSkill_ReferencesTaskClassificationRunbook', () => {
    const content = readSkillFile('delegate/SKILL.md');
    assertRunbookReference(content, 'task-classification');
  });

  it('SkillCoverage_ReviewSkill_ReferencesReviewStrategyRunbook', () => {
    const content = readSkillFile('review/SKILL.md');
    assertRunbookReference(content, 'review-strategy');
  });
});
