import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(__dirname, '../../../../skills');

function readSkillFile(relativePath: string): string {
  const fullPath = resolve(skillsDir, relativePath);
  return readFileSync(fullPath, 'utf-8');
}

function assertRunbookReference(content: string, runbookId: string): void {
  // Check that the content references the runbook ID in a context that
  // makes it clear it's a runbook reference (action: "runbook" with the id,
  // or similar patterns)
  const hasRunbookAction = content.includes('action: "runbook"') && content.includes(`"${runbookId}"`);
  const hasRunbookIdField = content.includes(`id: "${runbookId}"`);
  expect(
    hasRunbookAction || hasRunbookIdField,
    `Expected reference to runbook "${runbookId}" (e.g., action: "runbook", id: "${runbookId}")`,
  ).toBe(true);
}

describe('Skill coverage — runbook references', () => {
  it('SkillCoverage_DelegationSkill_ReferencesTaskCompletionRunbook', () => {
    const content = readSkillFile('delegation/SKILL.md');
    assertRunbookReference(content, 'task-completion');
  });

  it('SkillCoverage_DelegationSkill_ReferencesAgentTeamsSagaRunbook', () => {
    const content = readSkillFile('delegation/references/agent-teams-saga.md');
    assertRunbookReference(content, 'agent-teams-saga');
  });

  it('SkillCoverage_QualityReviewSkill_ReferencesQualityEvaluationRunbook', () => {
    const content = readSkillFile('quality-review/SKILL.md');
    assertRunbookReference(content, 'quality-evaluation');
  });

  it('SkillCoverage_SynthesisSkill_ReferencesSynthesisFlowRunbook', () => {
    const content = readSkillFile('synthesis/SKILL.md');
    assertRunbookReference(content, 'synthesis-flow');
  });

  it('SkillCoverage_ShepherdSkill_ReferencesShepherdIterationRunbook', () => {
    const content = readSkillFile('shepherd/SKILL.md');
    assertRunbookReference(content, 'shepherd-iteration');
  });

  // ─── Decision Runbook References ─────────────────────────────────────

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
    const content = readSkillFile('delegation/SKILL.md');
    assertRunbookReference(content, 'dispatch-decision');
  });

  it('SkillCoverage_QualityReviewSkill_ReferencesReviewEscalationRunbook', () => {
    const content = readSkillFile('quality-review/SKILL.md');
    assertRunbookReference(content, 'review-escalation');
  });
});
