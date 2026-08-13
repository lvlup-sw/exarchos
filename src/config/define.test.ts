import { describe, it, expect } from 'vitest';
import { defineConfig } from './define.js';
import type {
  ExarchosConfig,
  WorkflowDefinition,
  TransitionDefinition,
  GuardDefinition,
} from './define.js';

describe('defineConfig', () => {
  it('DefineConfig_EmptyConfig_ReturnsPassthrough', () => {
    // Arrange
    const config: ExarchosConfig = {};

    // Act
    const result = defineConfig(config);

    // Assert
    expect(result).toEqual({});
    expect(result).toBe(config); // identity — same reference
  });

  it('DefineConfig_WithWorkflows_ReturnsPassthrough', () => {
    // Arrange
    const config: ExarchosConfig = {
      workflows: {
        deploy: {
          phases: ['build', 'test', 'deploy'],
          initialPhase: 'build',
          transitions: [
            { from: 'build', to: 'test', event: 'build_complete' },
            { from: 'test', to: 'deploy', event: 'tests_pass' },
          ],
        },
      },
    };

    // Act
    const result = defineConfig(config);

    // Assert
    expect(result).toBe(config);
    expect(result.workflows?.deploy.phases).toEqual(['build', 'test', 'deploy']);
    expect(result.workflows?.deploy.initialPhase).toBe('build');
    expect(result.workflows?.deploy.transitions).toHaveLength(2);
  });

  it('DefineConfig_WithGuards_ReturnsPassthrough', () => {
    // Arrange
    const guard: GuardDefinition = {
      command: 'npm run test:run',
      timeout: 60000,
      description: 'Run test suite',
    };

    const transition: TransitionDefinition = {
      from: 'test',
      to: 'deploy',
      event: 'tests_pass',
      guard: 'run_tests',
    };

    const workflow: WorkflowDefinition = {
      phases: ['test', 'deploy'],
      initialPhase: 'test',
      transitions: [transition],
      guards: { run_tests: guard },
    };

    const config: ExarchosConfig = { workflows: { pipeline: workflow } };

    // Act
    const result = defineConfig(config);

    // Assert
    expect(result).toBe(config);
    expect(result.workflows?.pipeline.guards?.run_tests.command).toBe('npm run test:run');
    expect(result.workflows?.pipeline.guards?.run_tests.timeout).toBe(60000);
  });

  it('DefineConfig_WithExtends_ReturnsPassthrough', () => {
    // Arrange
    const config: ExarchosConfig = {
      workflows: {
        'custom-feature': {
          extends: 'feature',
          phases: ['ideate', 'plan', 'implement', 'review'],
          initialPhase: 'ideate',
          transitions: [
            { from: 'ideate', to: 'plan', event: 'ideate_complete' },
          ],
        },
      },
    };

    // Act
    const result = defineConfig(config);

    // Assert
    expect(result.workflows?.['custom-feature'].extends).toBe('feature');
  });
});
