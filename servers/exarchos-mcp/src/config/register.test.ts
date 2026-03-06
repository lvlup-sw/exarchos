import { describe, it, expect, afterEach } from 'vitest';
import { registerCustomWorkflows, getRegisteredGuards, clearRegisteredGuards } from './register.js';
import type { ExarchosConfig } from './register.js';
import { getHSMDefinition, unregisterWorkflowType } from '../workflow/state-machine.js';
import { WorkflowTypeSchema, unextendWorkflowTypeEnum } from '../workflow/schemas.js';

const TEST_WORKFLOW_NAME = 'test-pipeline';

afterEach(() => {
  // Clean up any registered custom workflows
  try { unregisterWorkflowType(TEST_WORKFLOW_NAME); } catch { /* ignore */ }
  unextendWorkflowTypeEnum(TEST_WORKFLOW_NAME);
  clearRegisteredGuards();
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

  it('RegisterCustomWorkflows_WithGuards_GuardsRegistered', () => {
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
  });
});
