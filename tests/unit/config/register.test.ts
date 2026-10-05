import { describe, it, expect, afterEach } from 'vitest';
import { registerCustomWorkflows, getRegisteredGuards, clearRegisteredGuards, registerCustomViews, clearRegisteredViews, registerCustomTools, clearRegisteredTools } from '../../../src/config/register.js';
import type { ExarchosConfig } from '../../../src/config/register.js';
import { getHSMDefinition, unregisterWorkflowType } from '../../../src/workflow/state-machine.js';
import { WorkflowTypeSchema, unextendWorkflowTypeEnum } from '../../../src/workflow/schemas.js';
import { getValidEventTypes, unregisterEventType } from '../../../src/events/schemas.js';
import { getFullRegistry, clearCustomTools, hasCustomToolHandlers } from '../../../src/registry.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const TEST_WORKFLOW_NAME = 'test-pipeline';

afterEach(() => {
  unregisterWorkflowType(TEST_WORKFLOW_NAME);
  unextendWorkflowTypeEnum(TEST_WORKFLOW_NAME);
  clearRegisteredGuards();
  try { unregisterEventType('deploy.started'); } catch { }
  try { unregisterEventType('deploy.finished'); } catch { }
  clearRegisteredViews();
  clearRegisteredTools();
  clearCustomTools();
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

    const hsm = getHSMDefinition(TEST_WORKFLOW_NAME);
    const guardedTransition = hsm.transitions.find(t => t.from === 'init' && t.to === 'validate');
    expect(guardedTransition).toBeDefined();
    expect(guardedTransition!.guard).toBeDefined();
    expect(guardedTransition!.guard!.id).toBe('check-ready');
    expect(guardedTransition!.guard!.description).toBe('Check if system is ready');
    expect(typeof guardedTransition!.guard!.evaluate).toBe('function');
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

describe('View Registration', () => {
  /** The handler path does not resolve, so the registration rejects. */
  it('RegisterCustomWorkflows_WithViews_RegistersViews', async () => {
    const config: ExarchosConfig = {
      views: {
        'my-counter': {
          events: ['task.completed'],
          handler: './test-handler.js',
        },
      },
    };

    await expect(
      registerCustomViews(config, '/fake/project/root'),
    ).rejects.toThrow();
  });

  it('RegisterCustomWorkflows_NoViews_Noop', async () => {
    const config: ExarchosConfig = {};
    await registerCustomViews(config, '/fake/project/root');
  });
});

describe('Tool Registration', () => {
  /** The handler paths do not resolve, so the registration rejects and leaves no tool and no handler. */
  it('RegisterCustomWorkflows_WithTools_RegistersTools', async () => {
    const config: ExarchosConfig = {
      tools: {
        'exarchos_deploy': {
          description: 'Custom deployment tool',
          actions: [
            {
              name: 'trigger',
              description: 'Trigger a deployment',
              handler: './tools/deploy-trigger.js',
            },
            {
              name: 'status',
              description: 'Check deployment status',
              handler: './tools/deploy-status.js',
            },
          ],
        },
      },
    };

    await expect(
      registerCustomTools(config, '/fake/project/root'),
    ).rejects.toThrow();

    const registry = getFullRegistry();
    const customToolRegistered = registry.some((t) => t.name === 'exarchos_deploy');
    expect(customToolRegistered).toBe(false);
    expect(hasCustomToolHandlers('exarchos_deploy')).toBe(false);
  });

  /**
   * Tool A has a real handler module, so it registers. Tool B has a path that does not
   * resolve, so it fails after tool A. The rollback must remove tool A.
   */
  it('RegisterCustomTools_PartialFailure_RollsBackPreviousTools', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'exarchos-test-'));
    const handlerPath = join(tmpDir, 'a-run.mjs');
    writeFileSync(handlerPath, 'export async function handle(args) { return { ok: true }; }\n');

    try {
      const config: ExarchosConfig = {
        tools: {
          'exarchos_tool_a': {
            description: 'First tool (resolvable handler)',
            actions: [
              { name: 'run', description: 'Run A', handler: './a-run.mjs' },
            ],
          },
          'exarchos_tool_b': {
            description: 'Second tool (unresolvable handler)',
            actions: [
              { name: 'run', description: 'Run B', handler: './b-run.mjs' },
            ],
          },
        },
      };

      await expect(
        registerCustomTools(config, tmpDir),
      ).rejects.toThrow('Failed to register custom tools');

      const registry = getFullRegistry();
      expect(registry.some((t) => t.name === 'exarchos_tool_a')).toBe(false);
      expect(registry.some((t) => t.name === 'exarchos_tool_b')).toBe(false);

      expect(hasCustomToolHandlers('exarchos_tool_a')).toBe(false);
      expect(hasCustomToolHandlers('exarchos_tool_b')).toBe(false);
    } finally {
      rmrf(tmpDir);
    }
  });

  it('RegisterCustomWorkflows_NoTools_Noop', async () => {
    const config: ExarchosConfig = {};
    await registerCustomTools(config, '/fake/project/root');
  });
});
