import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema } from './yaml-schema.js';

describe('ProjectConfigSchema', () => {
  it('ProjectConfigSchema_EmptyObject_Passes', () => {
    const result = ProjectConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('ProjectConfigSchema_FullConfig_Passes', () => {
    const result = ProjectConfigSchema.safeParse({
      review: {
        dimensions: { D1: 'blocking', D3: 'warning', D5: 'disabled' },
        gates: { 'security-scan': { enabled: true, blocking: true } },
        routing: { 'coderabbit-threshold': 0.6, 'risk-weights': {
          'security-path': 0.30, 'api-surface': 0.20, 'diff-complexity': 0.15,
          'new-files': 0.10, 'infra-config': 0.15, 'cross-module': 0.10
        }}
      },
      vcs: { provider: 'github', settings: { 'auto-merge-strategy': 'squash' } },
      workflow: { 'skip-phases': ['plan-review'], 'max-fix-cycles': 2, phases: { synthesize: { 'human-checkpoint': false } } },
      tools: { 'default-branch': 'main', 'commit-style': 'conventional', 'auto-merge': true, 'pr-strategy': 'github-native' },
      hooks: { on: { 'workflow.transition': [{ command: 'echo test', timeout: 5000 }] } }
    });
    expect(result.success).toBe(true);
  });

  it('ProjectConfigSchema_DimensionShorthand_Passes', () => {
    const result = ProjectConfigSchema.safeParse({ review: { dimensions: { D3: 'warning' } } });
    expect(result.success).toBe(true);
  });

  it('ProjectConfigSchema_DimensionLongform_Passes', () => {
    const result = ProjectConfigSchema.safeParse({ review: { dimensions: { D3: { severity: 'warning' } } } });
    expect(result.success).toBe(true);
  });

  it('ProjectConfigSchema_InvalidDimensionKey_Fails', () => {
    const result = ProjectConfigSchema.safeParse({ review: { dimensions: { D6: 'blocking' } } });
    expect(result.success).toBe(false);
  });

  it('ProjectConfigSchema_GateConfig_ValidatesParams', () => {
    const result = ProjectConfigSchema.safeParse({ review: { gates: { 'tdd-compliance': { blocking: false, params: { 'coverage-threshold': 80 } } } } });
    expect(result.success).toBe(true);
  });

  it('ProjectConfigSchema_RiskWeights_MustSumToOne', () => {
    const result = ProjectConfigSchema.safeParse({ review: { routing: { 'risk-weights': {
      'security-path': 0.30, 'api-surface': 0.20, 'diff-complexity': 0.15,
      'new-files': 0.10, 'infra-config': 0.05, 'cross-module': 0.05
    }}}});
    expect(result.success).toBe(false);
  });

  it('ProjectConfigSchema_RiskWeights_SumToOne_Passes', () => {
    const result = ProjectConfigSchema.safeParse({ review: { routing: { 'risk-weights': {
      'security-path': 0.30, 'api-surface': 0.20, 'diff-complexity': 0.15,
      'new-files': 0.10, 'infra-config': 0.15, 'cross-module': 0.10
    }}}});
    expect(result.success).toBe(true);
  });

  it('ProjectConfigSchema_UnknownTopLevelKey_Fails', () => {
    const result = ProjectConfigSchema.safeParse({ foo: 1 });
    expect(result.success).toBe(false);
  });

  it('ProjectConfigSchema_VcsProvider_ValidatesEnum', () => {
    expect(ProjectConfigSchema.safeParse({ vcs: { provider: 'github' } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ vcs: { provider: 'gitlab' } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ vcs: { provider: 'azure-devops' } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ vcs: { provider: 'bitbucket' } }).success).toBe(false);
  });

  it('ProjectConfigSchema_SkipPhases_AcceptsStringArray', () => {
    const result = ProjectConfigSchema.safeParse({ workflow: { 'skip-phases': ['plan-review'] } });
    expect(result.success).toBe(true);
  });

  it('ProjectConfigSchema_MaxFixCycles_ValidatesRange', () => {
    expect(ProjectConfigSchema.safeParse({ workflow: { 'max-fix-cycles': 0 } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ workflow: { 'max-fix-cycles': 5 } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ workflow: { 'max-fix-cycles': 11 } }).success).toBe(false);
  });

  it('ProjectConfigSchema_HookAction_RequiresCommand', () => {
    const result = ProjectConfigSchema.safeParse({ hooks: { on: { 'workflow.transition': [{ timeout: 5000 }] } } });
    expect(result.success).toBe(false);
  });

  it('ProjectConfigSchema_HookTimeout_ValidatesRange', () => {
    expect(ProjectConfigSchema.safeParse({ hooks: { on: { 'test': [{ command: 'echo', timeout: 500 }] } } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ hooks: { on: { 'test': [{ command: 'echo', timeout: 300001 }] } } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ hooks: { on: { 'test': [{ command: 'echo', timeout: 5000 }] } } }).success).toBe(true);
  });

  it('ProjectConfigSchema_ToolsSection_ValidatesEnums', () => {
    expect(ProjectConfigSchema.safeParse({ tools: { 'commit-style': 'conventional' } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ tools: { 'commit-style': 'invalid' } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ tools: { 'pr-strategy': 'github-native' } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ tools: { 'pr-strategy': 'invalid' } }).success).toBe(false);
  });

  describe('prune section', () => {
    it('PruneConfigSchema_ValidFullConfig_Parses', () => {
      const result = ProjectConfigSchema.safeParse({
        prune: {
          'stale-after-days': 30,
          'max-batch-size': 50,
          'phase-exclusions': ['delegate', 'review'],
          'malformed-handling': 'include',
          'require-dry-run': false,
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prune?.['stale-after-days']).toBe(30);
        expect(result.data.prune?.['max-batch-size']).toBe(50);
        expect(result.data.prune?.['phase-exclusions']).toEqual(['delegate', 'review']);
        expect(result.data.prune?.['malformed-handling']).toBe('include');
        expect(result.data.prune?.['require-dry-run']).toBe(false);
      }
    });

    it('PruneConfigSchema_EmptyObject_UsesDefaults', () => {
      const result = ProjectConfigSchema.parse({ prune: {} });
      expect(result.prune?.['stale-after-days']).toBe(14);
      expect(result.prune?.['max-batch-size']).toBe(25);
      expect(result.prune?.['phase-exclusions']).toEqual(['delegate', 'review', 'synthesize']);
      expect(result.prune?.['malformed-handling']).toBe('report');
      expect(result.prune?.['require-dry-run']).toBe(true);
    });

    it('PruneConfigSchema_InvalidStaleAfterDays_Rejects', () => {
      expect(ProjectConfigSchema.safeParse({ prune: { 'stale-after-days': -1 } }).success).toBe(false);
      expect(ProjectConfigSchema.safeParse({ prune: { 'stale-after-days': 0 } }).success).toBe(false);
    });

    it('PruneConfigSchema_InvalidMalformedHandling_Rejects', () => {
      const result = ProjectConfigSchema.safeParse({ prune: { 'malformed-handling': 'invalid' } });
      expect(result.success).toBe(false);
    });

    it('PruneConfigSchema_PhaseExclusions_AcceptsStringArray', () => {
      const result = ProjectConfigSchema.safeParse({
        prune: { 'phase-exclusions': ['plan', 'implement', 'review'] },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prune?.['phase-exclusions']).toEqual(['plan', 'implement', 'review']);
      }
    });
  });

  describe('checkpoint section', () => {
    it('CheckpointConfigSchema_ValidFullConfig_Parses', () => {
      const result = ProjectConfigSchema.safeParse({
        checkpoint: {
          'operation-threshold': 10,
          'enforce-on-phase-transition': false,
          'enforce-on-wave-dispatch': false,
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.checkpoint?.['operation-threshold']).toBe(10);
        expect(result.data.checkpoint?.['enforce-on-phase-transition']).toBe(false);
        expect(result.data.checkpoint?.['enforce-on-wave-dispatch']).toBe(false);
      }
    });

    it('CheckpointConfigSchema_EmptyObject_UsesDefaults', () => {
      const result = ProjectConfigSchema.parse({ checkpoint: {} });
      expect(result.checkpoint?.['operation-threshold']).toBe(20);
      expect(result.checkpoint?.['enforce-on-phase-transition']).toBe(true);
      expect(result.checkpoint?.['enforce-on-wave-dispatch']).toBe(true);
    });

    it('CheckpointConfigSchema_InvalidThreshold_Rejects', () => {
      expect(ProjectConfigSchema.safeParse({ checkpoint: { 'operation-threshold': 0 } }).success).toBe(false);
      expect(ProjectConfigSchema.safeParse({ checkpoint: { 'operation-threshold': -5 } }).success).toBe(false);
    });

    it('CheckpointConfigSchema_BooleanFlags_AcceptsBothValues', () => {
      const trueResult = ProjectConfigSchema.safeParse({
        checkpoint: { 'enforce-on-phase-transition': true, 'enforce-on-wave-dispatch': true },
      });
      expect(trueResult.success).toBe(true);

      const falseResult = ProjectConfigSchema.safeParse({
        checkpoint: { 'enforce-on-phase-transition': false, 'enforce-on-wave-dispatch': false },
      });
      expect(falseResult.success).toBe(true);
    });
  });

  describe('plugins section', () => {
    it('ProjectConfigSchema_Plugins_AcceptsValidConfig', () => {
      const result = ProjectConfigSchema.safeParse({
        plugins: { axiom: { enabled: true }, impeccable: { enabled: false } },
      });
      expect(result.success).toBe(true);
    });

    it('ProjectConfigSchema_Plugins_DefaultsEnabledTrue', () => {
      const result = ProjectConfigSchema.parse({ plugins: { axiom: {} } });
      expect(result.plugins?.axiom?.enabled).toBe(true);
    });

    it('ProjectConfigSchema_Plugins_AllowsDisabling', () => {
      const result = ProjectConfigSchema.safeParse({
        plugins: { axiom: { enabled: false } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.plugins?.axiom?.enabled).toBe(false);
      }
    });

    it('ProjectConfigSchema_Plugins_AcceptsPartialConfig', () => {
      const result = ProjectConfigSchema.safeParse({
        plugins: { axiom: { enabled: true } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.plugins?.axiom?.enabled).toBe(true);
        expect(result.data.plugins?.impeccable).toBeUndefined();
      }
    });

    it('ProjectConfigSchema_Plugins_OmittedSectionIsValid', () => {
      const result = ProjectConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.plugins).toBeUndefined();
      }
    });

    it('ProjectConfigSchema_Plugins_RejectsUnknownPluginKeys', () => {
      const result = ProjectConfigSchema.safeParse({
        plugins: { unknown: {} },
      });
      expect(result.success).toBe(false);
    });

    it('ProjectConfigSchema_Plugins_RejectsUnknownPropertiesInPlugin', () => {
      const result = ProjectConfigSchema.safeParse({
        plugins: { axiom: { enabled: true, extra: 'value' } },
      });
      expect(result.success).toBe(false);
    });
  });
});
