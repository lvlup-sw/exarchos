import { describe, it, expect, afterEach } from 'vitest';
import { registerCustomWorkflows, getRegisteredGuards, clearRegisteredGuards, registerCustomViews, clearRegisteredViews, registerCustomTools, clearRegisteredTools } from './register.js';
import type { ExarchosConfig } from './register.js';
import { getHSMDefinition, unregisterWorkflowType } from '../workflow/state-machine.js';
import { WorkflowTypeSchema, unextendWorkflowTypeEnum } from '../workflow/schemas.js';
import { getValidEventTypes, unregisterEventType } from '../event-store/schemas.js';
import { getFullRegistry, clearCustomTools, hasCustomToolHandlers } from '../registry.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_WORKFLOW_NAME = 'test-pipeline';

afterEach(() => {
  // Clean up any registered custom workflows
  unregisterWorkflowType(TEST_WORKFLOW_NAME);
  unextendWorkflowTypeEnum(TEST_WORKFLOW_NAME);
  clearRegisteredGuards();
  // Clean up any custom event types
  try { unregisterEventType('deploy.started'); } catch { /* ignore */ }
  try { unregisterEventType('deploy.finished'); } catch { /* ignore */ }
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

  it('RegisterCustomWorkflows_EventRegistrationFails_RollsBack', () => {
    const config: ExarchosConfig = {
      events: {
        'deploy.started': { source: 'model' },
        // This will fail: built-in event type collision
        'workflow.started': { source: 'auto' },
      },
    };

    expect(() => registerCustomWorkflows(config)).toThrow(
      'Failed to register custom workflows',
    );

    // deploy.started should have been rolled back
    const validTypes = getValidEventTypes();
    expect(validTypes).not.toContain('deploy.started');
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

describe('Tool Registration', () => {
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

    // registerCustomTools loads handlers dynamically. For testing, since
    // dynamic import won't resolve ./tools/deploy-trigger.js, we test
    // that tool registration attempts handler loading and fails gracefully.
    await expect(
      registerCustomTools(config, '/fake/project/root'),
    ).rejects.toThrow();

    // Verify no partial handlers leaked — no tool should be registered
    // and no action handlers should remain in the registry
    const registry = getFullRegistry();
    const customToolRegistered = registry.some((t) => t.name === 'exarchos_deploy');
    expect(customToolRegistered).toBe(false);
    expect(hasCustomToolHandlers('exarchos_deploy')).toBe(false);
  });

  it('RegisterCustomTools_PartialFailure_RollsBackPreviousTools', async () => {
    // Tool A uses a real temp module that exports handle(), so it registers
    // successfully. Tool B uses an unresolvable path, forcing a failure after
    // tool A is already registered. Rollback must clean up tool A.
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

      // Tool A was registered before tool B failed — rollback must clean it up
      const registry = getFullRegistry();
      expect(registry.some((t) => t.name === 'exarchos_tool_a')).toBe(false);
      expect(registry.some((t) => t.name === 'exarchos_tool_b')).toBe(false);

      // No handlers should remain for either tool
      expect(hasCustomToolHandlers('exarchos_tool_a')).toBe(false);
      expect(hasCustomToolHandlers('exarchos_tool_b')).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('RegisterCustomWorkflows_NoTools_Noop', async () => {
    const config: ExarchosConfig = {};
    // Should not throw
    await registerCustomTools(config, '/fake/project/root');
  });
});
