import { describe, it, expect, afterEach } from 'vitest';
import * as register from '../../../src/config/register.js';
import { registerCustomWorkflows } from '../../../src/config/register.js';
import type { ExarchosConfig } from '../../../src/config/register.js';
import { getHSMDefinition, unregisterWorkflowType } from '../../../src/workflow/state-machine.js';
import { WorkflowTypeSchema, unextendWorkflowTypeEnum } from '../../../src/workflow/schemas.js';
import { getValidEventTypes, unregisterEventType } from '../../../src/events/schemas.js';

const TEST_WORKFLOW_NAME = 'test-pipeline';

afterEach(() => {
  unregisterWorkflowType(TEST_WORKFLOW_NAME);
  unextendWorkflowTypeEnum(TEST_WORKFLOW_NAME);
  try { unregisterEventType('deploy.started'); } catch { }
  try { unregisterEventType('deploy.finished'); } catch { }
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

    const hsm = getHSMDefinition(TEST_WORKFLOW_NAME);
    expect(hsm).toBeDefined();
    expect(hsm.id).toBe(TEST_WORKFLOW_NAME);
    expect(hsm.states['init']).toBeDefined();
    expect(hsm.states['build']).toBeDefined();

    const parseResult = WorkflowTypeSchema.safeParse(TEST_WORKFLOW_NAME);
    expect(parseResult.success).toBe(true);
  });

  it('RegisterCustomWorkflows_NoConfig_Noop', () => {
    const config: ExarchosConfig = {};

    registerCustomWorkflows(config);

    expect(getHSMDefinition('feature')).toBeDefined();
  });

  /**
   * The transition gets a custom guard, so it fails closed at run time. The module stores no guard command
   * and exports no guard, view or tool registrar.
   */
  it('RegisterCustomWorkflows_WithGuards_MarksTheGuardCustomAndStoresNoCommand', () => {
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

    expect(Object.keys(register)).toEqual(['registerCustomWorkflows']);
    const hsm = getHSMDefinition(TEST_WORKFLOW_NAME);
    const guardedTransition = hsm.transitions.find(t => t.from === 'init' && t.to === 'validate');
    expect(guardedTransition?.guard).toMatchObject({ id: 'check-ready', custom: true, description: 'Check if system is ready' });
    expect(JSON.stringify(guardedTransition)).not.toContain('echo ready');
  });

  /** The config lists the child before its parent. The child inherits the `done` state of the parent. */
  it('RegisterCustomWorkflows_ChildBeforeParent_RegistersInCorrectOrder', () => {
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

    registerCustomWorkflows(config);

    expect(getHSMDefinition(TEST_WORKFLOW_NAME)).toBeDefined();
    expect(getHSMDefinition('child-pipeline')).toBeDefined();

    const childHsm = getHSMDefinition('child-pipeline');
    expect(childHsm.states['done']).toBeDefined();
    expect(childHsm.states['extra']).toBeDefined();

    unregisterWorkflowType('child-pipeline');
    unextendWorkflowTypeEnum('child-pipeline');
  });

  /** `feature` is a built-in workflow name, so the registration fails. */
  it('RegisterCustomWorkflows_InvalidConfig_RollsBackAndWrapsError', () => {
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

  it('RegisterCustomWorkflows_WithEvents_RegistersEventTypes', () => {
    const config: ExarchosConfig = {
      events: {
        'deploy.started': { source: 'model' },
        'deploy.finished': { source: 'hook' },
      },
    };

    registerCustomWorkflows(config);

    const validTypes = getValidEventTypes();
    expect(validTypes).toContain('deploy.started');
    expect(validTypes).toContain('deploy.finished');
  });

  /**
   * `workflow.started` is a built-in event type, so its registration fails after the
   * registration of `deploy.started`. The rollback must remove `deploy.started`.
   */
  it('RegisterCustomWorkflows_EventRegistrationFails_RollsBack', () => {
    const config: ExarchosConfig = {
      events: {
        'deploy.started': { source: 'model' },
        'workflow.started': { source: 'auto' },
      },
    };

    expect(() => registerCustomWorkflows(config)).toThrow(
      'Failed to register custom workflows',
    );

    const validTypes = getValidEventTypes();
    expect(validTypes).not.toContain('deploy.started');
  });
});
