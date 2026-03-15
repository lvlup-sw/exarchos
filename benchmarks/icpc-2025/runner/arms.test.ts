import { describe, it, expect } from 'vitest';
import { loadArm, buildPrompt } from './arms.js';
import { join } from 'node:path';
import type { ProblemDefinition } from './types.js';

const ARMS_DIR = join(import.meta.dirname, '..', 'arms');

const sampleProblem: ProblemDefinition = {
  id: 'test-problem',
  title: 'Two Sum',
  timeLimit: 2,
  statement: 'Given an array of integers, find two numbers that add up to a target.',
  samples: [
    { id: 1, input: '4\n2 7 11 15\n9', output: '2 7' },
    { id: 2, input: '3\n3 2 4\n6', output: '2 4' },
  ],
};

describe('loadArm', () => {
  it('loadArm_Exarchos_ReturnsFullWorkflowConfig', () => {
    const arm = loadArm(ARMS_DIR, 'exarchos');
    expect(arm.id).toBe('exarchos');
    expect(arm.name).toBe('Exarchos-Governed Workflow');
    expect(arm.mcpEnabled).toBe(true);
    expect(arm.promptTemplate).toContain('{{PROBLEM_STATEMENT}}');
  });

  it('loadArm_VanillaPlan_DisablesMcpServers', () => {
    const arm = loadArm(ARMS_DIR, 'vanilla-plan');
    expect(arm.id).toBe('vanilla-plan');
    expect(arm.mcpEnabled).toBe(false);
    expect(arm.name).toBe('Vanilla Claude Code Plan Mode');
  });

  it('loadArm_HnManual_ContainsStructuredPhases', () => {
    const arm = loadArm(ARMS_DIR, 'hn-manual');
    expect(arm.promptTemplate).toContain('Phase 1');
    expect(arm.promptTemplate).toContain('Phase 2');
    expect(arm.promptTemplate).toContain('Phase 3');
  });

  it('loadArm_UnknownArm_ThrowsError', () => {
    expect(() => loadArm(ARMS_DIR, 'nonexistent' as never)).toThrow();
  });
});

describe('buildPrompt', () => {
  it('buildPrompt_ProblemAndArm_IncludesSamplesAndStatement', () => {
    const arm = loadArm(ARMS_DIR, 'exarchos');
    const prompt = buildPrompt(sampleProblem, arm, 'C++');

    expect(prompt).toContain('Given an array of integers');
    expect(prompt).toContain('2 7 11 15');
    expect(prompt).toContain('2 4');
    expect(prompt).toContain('C++');
    expect(prompt).not.toContain('{{PROBLEM_STATEMENT}}');
    expect(prompt).not.toContain('{{SAMPLES}}');
    expect(prompt).not.toContain('{{LANGUAGE}}');
  });
});
