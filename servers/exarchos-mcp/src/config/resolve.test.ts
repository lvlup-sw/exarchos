import { describe, it, expect } from 'vitest';
import type { ProjectConfig } from './yaml-schema.js';
import { resolveConfig, DEFAULTS } from './resolve.js';

describe('resolveConfig', () => {
  it('resolveConfig_EmptyProject_ReturnsAllDefaults', () => {
    const result = resolveConfig({});

    // All dimensions should be blocking by default
    for (const dim of ['D1', 'D2', 'D3', 'D4', 'D5'] as const) {
      expect(result.review.dimensions[dim]).toEqual({ severity: 'blocking', enabled: true });
    }

    // Empty gates
    expect(result.review.gates).toEqual({});

    // Routing defaults
    expect(result.review.routing.coderabbitThreshold).toBe(0.4);
    expect(result.review.routing.riskWeights).toEqual({
      'security-path': 0.30,
      'api-surface': 0.20,
      'diff-complexity': 0.15,
      'new-files': 0.10,
      'infra-config': 0.15,
      'cross-module': 0.10,
    });

    // VCS defaults
    expect(result.vcs.provider).toBe('github');
    expect(result.vcs.settings).toEqual({});

    // Workflow defaults
    expect(result.workflow.skipPhases).toEqual([]);
    expect(result.workflow.maxFixCycles).toBe(3);
    expect(result.workflow.phases).toEqual({});

    // Tools defaults
    expect(result.tools.defaultBranch).toBeUndefined();
    expect(result.tools.commitStyle).toBe('conventional');
    expect(result.tools.prTemplate).toBeUndefined();
    expect(result.tools.autoMerge).toBe(true);
    expect(result.tools.prStrategy).toBe('github-native');

    // Hooks defaults
    expect(result.hooks.on).toEqual({});
  });

  it('resolveConfig_DimensionOverride_MergesOntoDefaults', () => {
    const project: ProjectConfig = {
      review: { dimensions: { D3: 'warning' } },
    };
    const result = resolveConfig(project);

    expect(result.review.dimensions.D3).toEqual({ severity: 'warning', enabled: true });
    expect(result.review.dimensions.D1).toEqual({ severity: 'blocking', enabled: true });
    expect(result.review.dimensions.D2).toEqual({ severity: 'blocking', enabled: true });
    expect(result.review.dimensions.D4).toEqual({ severity: 'blocking', enabled: true });
    expect(result.review.dimensions.D5).toEqual({ severity: 'blocking', enabled: true });
  });

  it('resolveConfig_DimensionShorthand_NormalizesToObject', () => {
    const project: ProjectConfig = {
      review: { dimensions: { D1: 'warning' } },
    };
    const result = resolveConfig(project);
    expect(result.review.dimensions.D1).toEqual({ severity: 'warning', enabled: true });
  });

  it('resolveConfig_DimensionLongform_Preserved', () => {
    const project: ProjectConfig = {
      review: { dimensions: { D2: { severity: 'disabled', enabled: false } } },
    };
    const result = resolveConfig(project);
    expect(result.review.dimensions.D2).toEqual({ severity: 'disabled', enabled: false });
  });

  it('resolveConfig_GateOverride_MergedOntoEmptyDefault', () => {
    const project: ProjectConfig = {
      review: { gates: { 'tdd-compliance': { blocking: true, params: { 'coverage-threshold': 80 } } } },
    };
    const result = resolveConfig(project);
    expect(result.review.gates['tdd-compliance']).toEqual({
      enabled: true,
      blocking: true,
      params: { 'coverage-threshold': 80 },
    });
  });

  it('resolveConfig_RoutingThreshold_OverridesDefault', () => {
    const project: ProjectConfig = {
      review: { routing: { 'coderabbit-threshold': 0.6 } },
    };
    const result = resolveConfig(project);
    expect(result.review.routing.coderabbitThreshold).toBe(0.6);
  });

  it('resolveConfig_RiskWeights_FullReplace', () => {
    const customWeights = {
      'security-path': 0.50,
      'api-surface': 0.20,
      'diff-complexity': 0.10,
      'new-files': 0.05,
      'infra-config': 0.10,
      'cross-module': 0.05,
    };
    const project: ProjectConfig = {
      review: { routing: { 'risk-weights': customWeights } },
    };
    const result = resolveConfig(project);
    expect(result.review.routing.riskWeights).toEqual(customWeights);
  });

  it('resolveConfig_VcsProvider_OverridesDefault', () => {
    const project: ProjectConfig = { vcs: { provider: 'gitlab' } };
    const result = resolveConfig(project);
    expect(result.vcs.provider).toBe('gitlab');
    expect(result.vcs.settings).toEqual({});
  });

  it('resolveConfig_SkipPhases_AddedToEmptyDefault', () => {
    const project: ProjectConfig = { workflow: { 'skip-phases': ['plan-review', 'lint'] } };
    const result = resolveConfig(project);
    expect(result.workflow.skipPhases).toEqual(['plan-review', 'lint']);
  });

  it('resolveConfig_MaxFixCycles_OverridesDefault', () => {
    const project: ProjectConfig = { workflow: { 'max-fix-cycles': 5 } };
    const result = resolveConfig(project);
    expect(result.workflow.maxFixCycles).toBe(5);
  });

  it('resolveConfig_ToolsPartial_MergesWithDefaults', () => {
    const project: ProjectConfig = { tools: { 'auto-merge': false } };
    const result = resolveConfig(project);
    expect(result.tools.autoMerge).toBe(false);
    expect(result.tools.commitStyle).toBe('conventional');
    expect(result.tools.prStrategy).toBe('github-native');
  });

  it('resolveConfig_HooksOn_MergedByEventType', () => {
    const project: ProjectConfig = {
      hooks: {
        on: {
          'workflow.transition': [{ command: 'echo hello', timeout: 5000 }],
          'review.complete': [{ command: 'echo done' }],
        },
      },
    };
    const result = resolveConfig(project);
    expect(result.hooks.on['workflow.transition']).toHaveLength(1);
    expect(result.hooks.on['workflow.transition'][0].command).toBe('echo hello');
    expect(result.hooks.on['workflow.transition'][0].timeout).toBe(5000);
    expect(result.hooks.on['review.complete']).toHaveLength(1);
    expect(result.hooks.on['review.complete'][0].command).toBe('echo done');
    // Default timeout for hooks without explicit timeout
    expect(result.hooks.on['review.complete'][0].timeout).toBe(30000);
  });

  it('resolveConfig_Result_IsFrozen', () => {
    const result = resolveConfig({});
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.review)).toBe(true);
    expect(Object.isFrozen(result.review.dimensions)).toBe(true);
    expect(Object.isFrozen(result.review.dimensions.D1)).toBe(true);
    expect(Object.isFrozen(result.vcs)).toBe(true);
    expect(Object.isFrozen(result.workflow)).toBe(true);
    expect(Object.isFrozen(result.tools)).toBe(true);
    expect(Object.isFrozen(result.hooks)).toBe(true);
  });

  it('resolveConfig_DefaultBranch_UndefinedByDefault', () => {
    const result = resolveConfig({});
    expect(result.tools.defaultBranch).toBeUndefined();
  });

  it('DEFAULTS_IsExported', () => {
    expect(DEFAULTS).toBeDefined();
    expect(DEFAULTS.review).toBeDefined();
    expect(DEFAULTS.vcs).toBeDefined();
    expect(DEFAULTS.workflow).toBeDefined();
    expect(DEFAULTS.tools).toBeDefined();
    expect(DEFAULTS.hooks).toBeDefined();
  });

  it('resolveConfig_DoesNotFreezeCallerParams', () => {
    const params: Record<string, unknown> = { 'coverage-threshold': 80 };
    const project: ProjectConfig = {
      review: { gates: { 'tdd-compliance': { blocking: true, params } } },
    };

    resolveConfig(project);

    // The caller's params object should NOT be frozen by deepFreeze
    expect(Object.isFrozen(params)).toBe(false);
    // Should still be mutable
    params['new-key'] = 'value';
    expect(params['new-key']).toBe('value');
  });

  it('resolveConfig_DoesNotFreezeCallerSkipPhases', () => {
    const skipPhases = ['plan-review', 'lint'];
    const project: ProjectConfig = { workflow: { 'skip-phases': skipPhases } };

    resolveConfig(project);

    // The caller's skipPhases array should NOT be frozen by deepFreeze
    expect(Object.isFrozen(skipPhases)).toBe(false);
    // Should still be mutable
    skipPhases.push('test');
    expect(skipPhases).toHaveLength(3);
  });
});
