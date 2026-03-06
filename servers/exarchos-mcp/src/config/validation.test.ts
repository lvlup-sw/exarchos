import { describe, it, expect } from 'vitest';
import { validateConfig, BUILTIN_WORKFLOW_TYPES } from './validation.js';

describe('validateConfig', () => {
  // ─── Valid Configs ─────────────────────────────────────────────────────

  it('ValidateConfig_EmptyObject_Succeeds', () => {
    const result = validateConfig({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it('ValidateConfig_ValidWorkflow_Succeeds', () => {
    const result = validateConfig({
      workflows: {
        deploy: {
          phases: ['build', 'test', 'deploy'],
          initialPhase: 'build',
          transitions: [
            { from: 'build', to: 'test', event: 'build_done' },
            { from: 'test', to: 'deploy', event: 'tests_pass' },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.workflows?.deploy.phases).toHaveLength(3);
  });

  it('ValidateConfig_WithGuardsAndRefs_Succeeds', () => {
    const result = validateConfig({
      workflows: {
        pipeline: {
          phases: ['test', 'deploy'],
          initialPhase: 'test',
          transitions: [
            { from: 'test', to: 'deploy', event: 'pass', guard: 'run_tests' },
          ],
          guards: {
            run_tests: { command: 'npm test', timeout: 60000, description: 'Run tests' },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('ValidateConfig_WithExtends_Succeeds', () => {
    const result = validateConfig({
      workflows: {
        'custom-feature': {
          extends: 'feature',
          phases: ['ideate', 'plan'],
          initialPhase: 'ideate',
          transitions: [
            { from: 'ideate', to: 'plan', event: 'done' },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  // ─── Invalid Configs ───────────────────────────────────────────────────

  it('ValidateConfig_EmptyPhases_Fails', () => {
    const result = validateConfig({
      workflows: {
        deploy: {
          phases: [],
          initialPhase: 'build',
          transitions: [],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some((e) => e.includes('at least one phase'))).toBe(true);
  });

  it('ValidateConfig_InitialPhaseNotInPhases_Fails', () => {
    const result = validateConfig({
      workflows: {
        deploy: {
          phases: ['build', 'test'],
          initialPhase: 'nonexistent',
          transitions: [],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('initialPhase') && e.includes('nonexistent'))).toBe(true);
  });

  it('ValidateConfig_TransitionFromInvalidPhase_Fails', () => {
    const result = validateConfig({
      workflows: {
        deploy: {
          phases: ['build', 'test'],
          initialPhase: 'build',
          transitions: [
            { from: 'unknown', to: 'test', event: 'go' },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('unknown') && e.includes('unknown phase'))).toBe(true);
  });

  it('ValidateConfig_TransitionToInvalidPhase_Fails', () => {
    const result = validateConfig({
      workflows: {
        deploy: {
          phases: ['build', 'test'],
          initialPhase: 'build',
          transitions: [
            { from: 'build', to: 'missing', event: 'go' },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('missing') && e.includes('unknown phase'))).toBe(true);
  });

  it('ValidateConfig_GuardRefNotDefined_Fails', () => {
    const result = validateConfig({
      workflows: {
        deploy: {
          phases: ['build', 'test'],
          initialPhase: 'build',
          transitions: [
            { from: 'build', to: 'test', event: 'go', guard: 'nonexistent_guard' },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('nonexistent_guard') && e.includes('not defined'))).toBe(true);
  });

  it('ValidateConfig_BuiltinWorkflowName_Fails', () => {
    for (const builtinName of BUILTIN_WORKFLOW_TYPES) {
      const result = validateConfig({
        workflows: {
          [builtinName]: {
            phases: ['a'],
            initialPhase: 'a',
            transitions: [],
          },
        },
      });

      expect(result.success).toBe(false);
      expect(result.errors?.some((e) => e.includes(builtinName) && e.includes('built-in'))).toBe(true);
    }
  });

  it('ValidateConfig_ExtendsUnknownWorkflow_Fails', () => {
    const result = validateConfig({
      workflows: {
        'my-workflow': {
          extends: 'nonexistent',
          phases: ['a'],
          initialPhase: 'a',
          transitions: [],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('nonexistent') && e.includes('unknown workflow'))).toBe(true);
  });

  it('ValidateConfig_ExtendsSelf_Fails', () => {
    const result = validateConfig({
      workflows: {
        'my-workflow': {
          extends: 'my-workflow',
          phases: ['a'],
          initialPhase: 'a',
          transitions: [],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('cannot extend itself'))).toBe(true);
  });

  it('ValidateConfig_CircularExtends_Fails', () => {
    const result = validateConfig({
      workflows: {
        alpha: {
          extends: 'beta',
          phases: ['a'],
          initialPhase: 'a',
          transitions: [],
        },
        beta: {
          extends: 'alpha',
          phases: ['b'],
          initialPhase: 'b',
          transitions: [],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('Circular extends chain'))).toBe(true);
  });

  it('ValidateConfig_ExtendsSiblingWorkflow_Succeeds', () => {
    const result = validateConfig({
      workflows: {
        base: {
          phases: ['a', 'b'],
          initialPhase: 'a',
          transitions: [{ from: 'a', to: 'b', event: 'go' }],
        },
        derived: {
          extends: 'base',
          phases: ['a', 'b', 'c'],
          initialPhase: 'a',
          transitions: [
            { from: 'a', to: 'b', event: 'go' },
            { from: 'b', to: 'c', event: 'next' },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('ValidateConfig_InitialPhaseIsTerminal_Fails', () => {
    const result = validateConfig({
      workflows: {
        broken: {
          phases: ['a'],
          initialPhase: 'completed',
          transitions: [],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('initialPhase') && e.includes('completed'))).toBe(true);
  });

  it('ValidateConfig_TransitionFromTerminal_Fails', () => {
    const result = validateConfig({
      workflows: {
        broken: {
          phases: ['a'],
          initialPhase: 'a',
          transitions: [
            { from: 'cancelled', to: 'a', event: 'retry' },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.some((e) => e.includes('cancelled') && e.includes('unknown phase'))).toBe(true);
  });

  it('ValidateConfig_TransitionToTerminal_Succeeds', () => {
    const result = validateConfig({
      workflows: {
        pipeline: {
          phases: ['a'],
          initialPhase: 'a',
          transitions: [
            { from: 'a', to: 'completed', event: 'done' },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('ValidateConfig_MultipleErrors_ReturnsAll', () => {
    const result = validateConfig({
      workflows: {
        deploy: {
          phases: ['build'],
          initialPhase: 'nonexistent',
          transitions: [
            { from: 'missing_from', to: 'missing_to', event: 'go' },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
    // Should have errors for initialPhase + from + to
    expect(result.errors!.length).toBeGreaterThanOrEqual(3);
  });
});
