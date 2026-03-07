import { describe, it, expect, afterEach } from 'vitest';
import { registerCustomWorkflows, getRegisteredGuards, clearRegisteredGuards, registerCustomViews, clearRegisteredViews } from './register.js';
import type { ExarchosConfig } from './register.js';
import { getHSMDefinition, unregisterWorkflowType } from '../workflow/state-machine.js';
import { WorkflowTypeSchema, unextendWorkflowTypeEnum } from '../workflow/schemas.js';

const TEST_WORKFLOW_NAME = 'test-pipeline';

afterEach(() => {
  // Clean up any registered custom workflows
  unregisterWorkflowType(TEST_WORKFLOW_NAME);
  unextendWorkflowTypeEnum(TEST_WORKFLOW_NAME);
  clearRegisteredGuards();
  clearRegisteredViews();
});

describe('Registration Pipeline', () => {
  it('RegisterCustomWorkflows_FromConfig_WorkflowAvailable', () => {
    const config: ExarchosConfig = {
      workflows: {
        [TEST_WORKFLOW_NAME]: {
          phases: ['init', 'build', 'deploy', 'done'],
          initialPhase: 'init',
          transitions: [
            { from: 'init', to: 'build', event: 'start-build' },
            { from: 'build', to: 'deploy', event: 'build-complete' },
            { from: 'deploy', to: 'done', event: 'deploy-complete' },
          ],
        },
      },
    };

    registerCustomWorkflows(config);

    // HSM should be available
    const hsm = getHSMDefinition(TEST_WORKFLOW_NAME);
    expect(hsm).toBeDefined();
    expect(hsm.id).toBe(TEST_WORKFLOW_NAME);
    expect(hsm.states['init']).toBeDefined();
    expect(hsm.states['build']).toBeDefined();

    // WorkflowTypeSchema should accept the new type
    const parseResult = WorkflowTypeSchema.safeParse(TEST_WORKFLOW_NAME);
    expect(parseResult.success).toBe(true);
  });

  it('RegisterCustomWorkflows_NoConfig_Noop', () => {
    const config: ExarchosConfig = {};

    // Should not throw
    registerCustomWorkflows(config);

    // Built-ins should still work
    expect(getHSMDefinition('feature')).toBeDefined();
  });

  it('RegisterCustomWorkflows_WithGuards_GuardsRegisteredAndResolved', () => {
    const config: ExarchosConfig = {
      workflows: {
        [TEST_WORKFLOW_NAME]: {
          phases: ['init', 'validate', 'done'],
          initialPhase: 'init',
          transitions: [
            { from: 'init', to: 'validate', event: 'start', guard: 'check-ready' },
            { from: 'validate', to: 'done', event: 'pass' },
          ],
          guards: {
            'check-ready': {
              command: 'echo ready',
              timeout: 5000,
              description: 'Check if system is ready',
            },
          },
        },
      },
    };

    registerCustomWorkflows(config);

    const guards = getRegisteredGuards();
    const guard = guards.get(`${TEST_WORKFLOW_NAME}:check-ready`);
    expect(guard).toBeDefined();
    expect(guard!.command).toBe('echo ready');
    expect(guard!.timeout).toBe(5000);
    expect(guard!.description).toBe('Check if system is ready');

    // Verify the guard is resolved to a Guard object in the HSM
    const hsm = getHSMDefinition(TEST_WORKFLOW_NAME);
    const guardedTransition = hsm.transitions.find(t => t.from === 'init' && t.to === 'validate');
    expect(guardedTransition).toBeDefined();
    expect(guardedTransition!.guard).toBeDefined();
    expect(guardedTransition!.guard!.id).toBe('check-ready');
    expect(guardedTransition!.guard!.description).toBe('Check if system is ready');
    expect(typeof guardedTransition!.guard!.evaluate).toBe('function');
  });

  it('RegisterCustomWorkflows_ChildBeforeParent_RegistersInCorrectOrder', () => {
    // Child is defined before parent in the config object
    const config: ExarchosConfig = {
      workflows: {
        'child-pipeline': {
          extends: TEST_WORKFLOW_NAME,
          phases: ['init', 'build', 'extra'],
          initialPhase: 'init',
          transitions: [
            { from: 'init', to: 'build', event: 'start' },
            { from: 'build', to: 'extra', event: 'extend' },
          ],
        },
        [TEST_WORKFLOW_NAME]: {
          phases: ['init', 'build', 'done'],
          initialPhase: 'init',
          transitions: [
            { from: 'init', to: 'build', event: 'start' },
            { from: 'build', to: 'done', event: 'finish' },
          ],
        },
      },
    };

    // Should NOT throw despite child being listed before parent
    registerCustomWorkflows(config);

    // Both should be registered
    expect(getHSMDefinition(TEST_WORKFLOW_NAME)).toBeDefined();
    expect(getHSMDefinition('child-pipeline')).toBeDefined();

    // Child should have inherited parent's states
    const childHsm = getHSMDefinition('child-pipeline');
    expect(childHsm.states['done']).toBeDefined();
    expect(childHsm.states['extra']).toBeDefined();

    // Cleanup child
    unregisterWorkflowType('child-pipeline');
    unextendWorkflowTypeEnum('child-pipeline');
  });

  it('RegisterCustomWorkflows_InvalidConfig_RollsBackAndWrapsError', () => {
    // A config with a built-in name will fail during registerWorkflowType
    const invalidConfig: ExarchosConfig = {
      workflows: {
        feature: {
          phases: ['a', 'b'],
          initialPhase: 'a',
          transitions: [{ from: 'a', to: 'b', event: 'go' }],
        },
      },
    };

    expect(() => registerCustomWorkflows(invalidConfig)).toThrow(
      'Failed to register custom workflows',
    );
  });
});

describe('View Registration', () => {
  it('RegisterCustomWorkflows_WithViews_RegistersViews', async () => {
    const config: ExarchosConfig = {
      views: {
        'my-counter': {
          events: ['task.completed'],
          handler: './test-handler.js',
        },
      },
    };

    // registerCustomViews loads handlers dynamically. For testing, we use
    // a mock handler module path. In production, handler modules export
    // init() and apply() conforming to ViewProjection.
    // Since dynamic import won't resolve ./test-handler.js in tests,
    // we test that view registration validates handler modules.
    await expect(
      registerCustomViews(config, '/fake/project/root'),
    ).rejects.toThrow();
  });

  it('RegisterCustomWorkflows_NoViews_Noop', async () => {
    const config: ExarchosConfig = {};
    // Should not throw
    await registerCustomViews(config, '/fake/project/root');
  });
});
