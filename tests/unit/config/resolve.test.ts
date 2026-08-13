import { describe, it, expect } from 'vitest';
import type { ProjectConfig } from '../../../src/config/yaml-schema.js';
import { resolveConfig, DEFAULTS } from '../../../src/config/resolve.js';

describe('resolveConfig', () => {
  it('resolveConfig_NoStorageBlock_DefaultsSynchronousNormal', () => {
    // DR-4 — the durability posture defaults to 'normal' (unchanged behavior)
    // when `.exarchos.yml` omits the storage block.
    expect(resolveConfig({}).storage.synchronous).toBe('normal');
  });

  it('resolveConfig_StorageSynchronousFull_SurfacesFull', () => {
    const project: ProjectConfig = { storage: { synchronous: 'full' } };
    expect(resolveConfig(project).storage.synchronous).toBe('full');
  });

  it('resolveConfig_EmptyProject_ReturnsAllDefaults', () => {
    const result = resolveConfig({});

    // All dimensions should be blocking by default
    for (const dim of ['D1', 'D2', 'D3', 'D4', 'D5'] as const) {
      expect(result.review.dimensions[dim]).toEqual({ severity: 'blocking', enabled: true });
    }

    // Per-gate DEFAULTS seed through (verification-ladder advisory demotions
    // survive even when a project ships a .exarchos.yml; without the seed,
    // any config file silently re-blocked the demoted gates via dimension D1).
    expect(result.review.gates).toEqual(DEFAULTS.review.gates);

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
    expect(result.workflow.maxPlanRevisions).toBe(1); // DR-1: default cap 1
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

  it('resolveConfig_MaxPlanRevisions_OverridesDefault', () => {
    // DR-1: `.exarchos.yml workflow.max-plan-revisions` overrides the default 1.
    const project: ProjectConfig = { workflow: { 'max-plan-revisions': 3 } };
    const result = resolveConfig(project);
    expect(result.workflow.maxPlanRevisions).toBe(3);
  });

  it('resolveConfig_MutationEnforcement_DefaultsToAdvisory', () => {
    // DR-3: advisory by default (#1520/R5) — never blocks review→synthesize.
    expect(resolveConfig({}).review.mutationEnforcement).toBe('advisory');
  });

  it('resolveConfig_MutationEnforcement_OverridesToBlock', () => {
    const project: ProjectConfig = { review: { 'mutation-enforcement': 'block' } };
    expect(resolveConfig(project).review.mutationEnforcement).toBe('block');
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
    expect(Object.isFrozen(result.prune)).toBe(true);
    expect(Object.isFrozen(result.prune.phaseExclusions)).toBe(true);
    expect(Object.isFrozen(result.checkpoint)).toBe(true);
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
    expect(DEFAULTS.prune).toBeDefined();
    expect(DEFAULTS.checkpoint).toBeDefined();
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

  it('ResolveConfig_EmptyConfig_PluginsDefaultToEnabled', () => {
    const resolved = resolveConfig({});
    expect(resolved.plugins.impeccable.enabled).toBe(true);
  });

  it('ResolveConfig_NoAxiomField_Omitted', () => {
    // axiom is excised (#1477) — the resolved config must not carry an axiom field.
    const resolved = resolveConfig({ plugins: { impeccable: { enabled: false } } });
    expect('axiom' in resolved.plugins).toBe(false);
    expect(resolved.plugins.impeccable.enabled).toBe(false);
  });

  it('ResolveConfig_ImpeccableDisabled_ResolvesCorrectly', () => {
    const resolved = resolveConfig({ plugins: { impeccable: { enabled: false } } });
    expect(resolved.plugins.impeccable.enabled).toBe(false);
  });

  it('ResolveConfig_PluginsPartial_MissingKeyDefaultsToEnabled', () => {
    const resolved = resolveConfig({ plugins: {} });
    expect(resolved.plugins.impeccable.enabled).toBe(true);
  });

  it('resolveConfig_EmptyInput_ReturnsPruneDefaults', () => {
    const resolved = resolveConfig({});
    // `staleAfterDays` removed (DR-9): staleness lives in topology.yaml.
    expect(resolved.prune).toEqual({
      maxBatchSize: 25,
      phaseExclusions: ['delegate', 'review', 'synthesize'],
      malformedHandling: 'report',
      requireDryRun: true,
    });
    expect('staleAfterDays' in resolved.prune).toBe(false);
  });

  it('resolveConfig_EmptyInput_ReturnsCheckpointDefaults', () => {
    const resolved = resolveConfig({});
    expect(resolved.checkpoint).toEqual({
      operationThreshold: 20,
      enforceOnPhaseTransition: true,
      enforceOnWaveDispatch: true,
    });
  });

  it('resolveConfig_PartialPrune_MergesWithDefaults', () => {
    // `stale-after-days` removed (DR-9) — exercise partial-merge via a
    // surviving prune knob instead.
    const resolved = resolveConfig({ prune: { 'max-batch-size': 10 } });
    expect(resolved.prune.maxBatchSize).toBe(10);
    expect(resolved.prune.phaseExclusions).toEqual(['delegate', 'review', 'synthesize']);
    expect(resolved.prune.malformedHandling).toBe('report');
    expect(resolved.prune.requireDryRun).toBe(true);
  });

  it('resolveConfig_PartialCheckpoint_MergesWithDefaults', () => {
    const resolved = resolveConfig({ checkpoint: { 'operation-threshold': 50 } });
    expect(resolved.checkpoint.operationThreshold).toBe(50);
    expect(resolved.checkpoint.enforceOnPhaseTransition).toBe(true);
    expect(resolved.checkpoint.enforceOnWaveDispatch).toBe(true);
  });

  describe('agents resolution', () => {
    it('resolveConfig_EmptyProject_ReturnsAgentDefaults', () => {
      const resolved = resolveConfig({});
      expect(resolved.agents.defaultModel).toBe('opus');
      expect(resolved.agents.models).toMatchObject({ scaffolder: 'haiku', reviewer: 'sonnet' });
    });

    it('resolveConfig_AgentsDefaultModel_OverridesDefault', () => {
      const resolved = resolveConfig({ agents: { 'default-model': 'sonnet' } });
      expect(resolved.agents.defaultModel).toBe('sonnet');
    });

    it('resolveConfig_AgentsModels_OverridesPerAgent', () => {
      const resolved = resolveConfig({ agents: { models: { implementer: 'haiku' } } });
      expect(resolved.agents.models.implementer).toBe('haiku');
      // Other defaults preserved
      expect(resolved.agents.models.scaffolder).toBe('haiku');
      expect(resolved.agents.models.reviewer).toBe('sonnet');
    });

    it('resolveConfig_AgentsModels_PartialOverride_MergesWithDefaults', () => {
      const resolved = resolveConfig({ agents: { models: { reviewer: 'haiku' } } });
      expect(resolved.agents.models.reviewer).toBe('haiku');
      expect(resolved.agents.models.scaffolder).toBe('haiku');
    });

    it('resolveConfig_AgentsFrozen_CannotMutate', () => {
      const resolved = resolveConfig({});
      expect(() => { (resolved.agents as Record<string, unknown>).defaultModel = 'haiku'; }).toThrow();
    });
  });

  // ─── DR-1 (#1672): tier→model policy surface + monotonicity guard ──────────
  describe('agents.tier-models resolution (DR-1)', () => {
    it('ResolveConfig_TierModelsAbsent_UsesDocumentedDefaults', () => {
      // No `agents.tier-models` block → the documented in-code default table:
      // low → haiku, medium → sonnet, high → opus.
      const resolved = resolveConfig({});
      expect(resolved.agents.tierModels).toEqual({
        low: 'haiku',
        medium: 'sonnet',
        high: 'opus',
      });
    });

    it('ResolveConfig_TierModelsOverride_Honored', () => {
      // A partial `.exarchos.yml` override re-maps only the named tiers and
      // inherits the documented defaults for the rest. { medium: opus } is
      // monotone (haiku ≤ opus ≤ opus) and high stays opus.
      const resolved = resolveConfig({ agents: { 'tier-models': { medium: 'opus' } } });
      expect(resolved.agents.tierModels).toEqual({
        low: 'haiku',
        medium: 'opus',
        high: 'opus',
      });
    });

    it('ResolveConfig_HighTierSonnet_Accepted', () => {
      // Settled OQ2: high → sonnet is an ALLOWED operator opt-in (the high-tier
      // floor is sonnet, not opus). Must resolve without throwing.
      const resolved = resolveConfig({
        agents: { 'tier-models': { low: 'haiku', medium: 'sonnet', high: 'sonnet' } },
      });
      expect(resolved.agents.tierModels.high).toBe('sonnet');
    });

    it('ResolveConfig_NonMonotoneTierModels_RejectsWithStructuredError', () => {
      // low → sonnet but medium → haiku is NON-monotone (a weaker model at a
      // higher tier). high stays opus so the high-floor rule is satisfied — this
      // isolates the monotonicity rule. The structured error names the offending
      // cell(s).
      expect(() =>
        resolveConfig({ agents: { 'tier-models': { low: 'sonnet', medium: 'haiku' } } }),
      ).toThrow(/tier-models/);
      expect(() =>
        resolveConfig({ agents: { 'tier-models': { low: 'sonnet', medium: 'haiku' } } }),
      ).toThrow(/monotone/i);
      expect(() =>
        resolveConfig({ agents: { 'tier-models': { low: 'sonnet', medium: 'haiku' } } }),
      ).toThrow(/medium/);
    });

    it('ResolveConfig_HighTierHaiku_Rejected', () => {
      // high → haiku is rejected outright — the high-tier floor is sonnet. The
      // structured error names the high cell and haiku specifically.
      expect(() =>
        resolveConfig({ agents: { 'tier-models': { high: 'haiku' } } }),
      ).toThrow(/agents\.tier-models\.high/);
      expect(() =>
        resolveConfig({ agents: { 'tier-models': { high: 'haiku' } } }),
      ).toThrow(/haiku/);
    });

    it('ResolveConfig_AllHaikuTierModels_RejectedByHighFloor', () => {
      // An all-haiku table is technically monotone (0 ≤ 0 ≤ 0) but still fails
      // the high-tier floor — the high→haiku rule is checked first and names the
      // specific cell.
      expect(() =>
        resolveConfig({ agents: { 'tier-models': { low: 'haiku', medium: 'haiku', high: 'haiku' } } }),
      ).toThrow(/agents\.tier-models\.high/);
    });

    it('ResolveConfig_TierModels_Frozen', () => {
      // The resolved tier table is deep-frozen alongside the rest of agents.
      const resolved = resolveConfig({});
      expect(Object.isFrozen(resolved.agents.tierModels)).toBe(true);
    });

    it('ResolveConfig_TierModels_DoesNotFreezeCallerOverride', () => {
      // Mirrors resolveConfig_DoesNotFreezeCallerParams — deepFreeze must not
      // reach into the caller-owned override object.
      const override = { high: 'sonnet' as const };
      resolveConfig({ agents: { 'tier-models': override } });
      expect(Object.isFrozen(override)).toBe(false);
    });
  });

  describe('verification resolution', () => {
    it('ResolveConfig_NoVerificationBlock_DefaultsToEmptyOverlay', () => {
      // A config with no `verification:` block resolves to an empty override
      // layer — `policy` is `{}` so the later resolver layers nothing over the
      // frozen base policy table.
      const resolved = resolveConfig({});
      expect(resolved.verification).toBeDefined();
      expect(resolved.verification.policy).toEqual({});
    });

    it('ResolveConfig_VerificationPolicyOverride_ThreadsOntoResolved', () => {
      const resolved = resolveConfig({
        verification: {
          policy: {
            low: ['check_static_analysis'],
            boundary: { high: ['check_static_analysis', 'check_contract_drift', 'check_mock_boundary'] },
          },
        },
      });
      expect(resolved.verification.policy.low).toEqual(['check_static_analysis']);
      expect(resolved.verification.policy.boundary?.high).toEqual([
        'check_static_analysis',
        'check_contract_drift',
        'check_mock_boundary',
      ]);
    });

    it('ResolveConfig_VerificationResolved_IsFrozen', () => {
      const resolved = resolveConfig({ verification: { policy: { low: ['check_static_analysis'] } } });
      expect(Object.isFrozen(resolved.verification)).toBe(true);
      expect(Object.isFrozen(resolved.verification.policy)).toBe(true);
    });

    it('DEFAULTS_CarriesVerificationEmptyOverlay', () => {
      expect(DEFAULTS.verification).toBeDefined();
      expect(DEFAULTS.verification.policy).toEqual({});
    });

    it('ResolveConfig_DoesNotFreezeCallerVerificationOverlay', () => {
      // The resolved overlay is deep-frozen; the caller's nested input must NOT
      // be frozen by deepFreeze (mirrors resolveConfig_DoesNotFreezeCallerParams).
      const cells: string[] = ['check_static_analysis'];
      const project: ProjectConfig = {
        verification: { policy: { low: cells as ('check_static_analysis')[], boundary: { high: ['check_contract_drift'] } } },
      };

      resolveConfig(project);

      expect(Object.isFrozen(cells)).toBe(false);
      expect(Object.isFrozen(project.verification!.policy!.boundary)).toBe(false);
      cells.push('check_test_adequacy');
      expect(cells).toHaveLength(2);
    });
  });
});
