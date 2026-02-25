import { describe, it, expect } from 'vitest';
import { FeaturePhaseSchema, DebugPhaseSchema, RefactorPhaseSchema } from './schemas.js';
import { getPlaybook, renderPlaybook } from './playbooks.js';

describe('HSM-Playbook Coverage', () => {
  const workflowPhases: Record<string, readonly string[]> = {
    feature: FeaturePhaseSchema.options,
    debug: DebugPhaseSchema.options,
    refactor: RefactorPhaseSchema.options,
  };

  // Test: every HSM state has a playbook entry
  for (const [workflowType, phases] of Object.entries(workflowPhases)) {
    for (const phase of phases) {
      it(`allHsmStates_HavePlaybook_${workflowType}_${phase}`, () => {
        const playbook = getPlaybook(workflowType, phase);
        expect(playbook).not.toBeNull();
        expect(playbook!.phase).toBe(phase);
        expect(playbook!.workflowType).toBe(workflowType);
      });
    }
  }

  // Test: non-terminal playbooks have adequate compactGuidance
  const terminalPhases = ['completed', 'cancelled'];
  for (const [workflowType, phases] of Object.entries(workflowPhases)) {
    for (const phase of phases) {
      if (terminalPhases.includes(phase)) continue;

      it(`compactGuidance_MentionsTool_${workflowType}_${phase}`, () => {
        const playbook = getPlaybook(workflowType, phase);
        expect(playbook).not.toBeNull();
        if (playbook!.tools.length > 0) {
          const mentionsTool = playbook.tools.some((t) =>
            playbook.compactGuidance.includes(t.tool),
          );
          expect(mentionsTool).toBe(true);
        }
      });

      it(`renderPlaybook_ContainsAllToolNames_${workflowType}_${phase}`, () => {
        const playbook = getPlaybook(workflowType, phase);
        expect(playbook).not.toBeNull();
        const rendered = renderPlaybook(playbook!);
        for (const tool of playbook.tools) {
          expect(rendered).toContain(tool.tool);
        }
      });

      it(`renderPlaybook_ContainsAllEventTypes_${workflowType}_${phase}`, () => {
        const playbook = getPlaybook(workflowType, phase);
        expect(playbook).not.toBeNull();
        const rendered = renderPlaybook(playbook!);
        for (const event of playbook.events) {
          expect(rendered).toContain(event.type);
        }
      });
    }
  }

  // Test: human checkpoint playbooks mention wait/pause/confirm
  for (const [workflowType, phases] of Object.entries(workflowPhases)) {
    for (const phase of phases) {
      const playbook = getPlaybook(workflowType, phase);
      if (!playbook || !playbook.humanCheckpoint) continue;

      it(`humanCheckpoint_GuidanceMentionsWait_${workflowType}_${phase}`, () => {
        const guidance = playbook!.compactGuidance.toLowerCase();
        const mentionsWait = ['wait', 'pause', 'confirm', 'checkpoint', 'human'].some(
          (w) => guidance.includes(w),
        );
        expect(mentionsWait).toBe(true);
      });
    }
  }
});
