import { describe, it, expect } from 'vitest';
import { buildEnvironmentChoices, buildCompanionChoices } from './prompts.js';

describe('Prompts', () => {
  it('buildEnvironmentChoices_AllFourOptions_ReturnsFourChoices', () => {
    const choices = buildEnvironmentChoices(null);
    expect(choices).toHaveLength(4);
    const values = choices.map(c => c.value);
    expect(values).toContain('claude-code');
    expect(values).toContain('cursor');
    expect(values).toContain('generic-mcp');
    expect(values).toContain('cli');
  });

  it('buildCompanionChoices_DefaultsChecked_ReturnsCheckboxConfig', () => {
    const choices = buildCompanionChoices('claude-code');
    expect(choices.length).toBeGreaterThan(0);
    const axiom = choices.find(c => c.value === 'axiom');
    expect(axiom?.checked).toBe(true);
    const msLearn = choices.find(c => c.value === 'microsoft-learn');
    expect(msLearn?.checked).toBe(false);
  });

  it('buildCompanionChoices_EnvFiltered_ExcludesUnavailable', () => {
    // CLI env has no companion installs — should return empty or filtered
    const choices = buildCompanionChoices('cli');
    expect(choices).toHaveLength(0);
  });
});
