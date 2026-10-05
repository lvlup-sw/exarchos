import { describe, it, expect } from 'vitest';
import type { ProjectConfig } from '../../../src/config/yaml-schema.js';
import {
  resolveConfig,
  DEFAULTS,
  EMISSION_ENFORCEMENT_FALLBACK,
  resolveEmissionEnforcement,
} from '../../../src/config/resolve.js';
import {
  emissionIndeterminacyBlocks,
  emissionViolationBlocks,
} from '../../../src/dispatch/core/interceptors/emission-verifier.js';

describe('resolveConfig', () => {
  it('resolveConfig_NoStorageBlock_DefaultsSynchronousNormal', () => {
    expect(resolveConfig({}).storage.synchronous).toBe('normal');
  });

  it('resolveConfig_StorageSynchronousFull_SurfacesFull', () => {
    const project: ProjectConfig = { storage: { synchronous: 'full' } };
    expect(resolveConfig(project).storage.synchronous).toBe('full');
  });

  /** The resolved gates must equal the per-gate defaults, which keep the advisory gates advisory. */
  it('resolveConfig_EmptyProject_ReturnsAllDefaults', () => {
    const result = resolveConfig({});

    for (const dim of ['D1', 'D2', 'D3', 'D4', 'D5'] as const) {
      expect(result.review.dimensions[dim]).toEqual({ severity: 'blocking', enabled: true });
    }

    expect(result.review.gates).toEqual(DEFAULTS.review.gates);

    expect(result.review.routing.coderabbitThreshold).toBe(0.4);
    expect(result.review.routing.riskWeights).toEqual({
      'security-path': 0.30,
      'api-surface': 0.20,
      'diff-complexity': 0.15,
      'new-files': 0.10,
      'infra-config': 0.15,
      'cross-module': 0.10,
    });

    expect(result.vcs.provider).toBe('github');
    expect(result.vcs.settings).toEqual({});

    expect(result.workflow.skipPhases).toEqual([]);
    expect(result.workflow.maxFixCycles).toBe(3);
    expect(result.workflow.maxPlanRevisions).toBe(1);
    expect(result.workflow.phases).toEqual({});

    expect(result.tools.defaultBranch).toBeUndefined();
    expect(result.tools.commitStyle).toBe('conventional');
    expect(result.tools.prTemplate).toBeUndefined();
    expect(result.tools.autoMerge).toBe(true);
    expect(result.tools.prStrategy).toBe('github-native');

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
    const project: ProjectConfig = { workflow: { 'max-plan-revisions': 3 } };
    const result = resolveConfig(project);
    expect(result.workflow.maxPlanRevisions).toBe(3);
  });

  /** The advisory mode never blocks `review → synthesize`. */
  it('resolveConfig_MutationEnforcement_DefaultsToAdvisory', () => {
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

  /** A hook without a timeout gets the default of 30000 ms. */
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

    expect(Object.isFrozen(params)).toBe(false);
    params['new-key'] = 'value';
    expect(params['new-key']).toBe('value');
  });

  it('resolveConfig_DoesNotFreezeCallerSkipPhases', () => {
    const skipPhases = ['plan-review', 'lint'];
    const project: ProjectConfig = { workflow: { 'skip-phases': skipPhases } };

    resolveConfig(project);

    expect(Object.isFrozen(skipPhases)).toBe(false);
    skipPhases.push('test');
    expect(skipPhases).toHaveLength(3);
  });

  it('ResolveConfig_EmptyConfig_PluginsDefaultToEnabled', () => {
    const resolved = resolveConfig({});
    expect(resolved.plugins.impeccable.enabled).toBe(true);
  });

  it('ResolveConfig_NoAxiomField_Omitted', () => {
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

  /** The prune config holds no `staleAfterDays`. Staleness lives in `topology.yaml`. */
  it('resolveConfig_EmptyInput_ReturnsPruneDefaults', () => {
    const resolved = resolveConfig({});
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

  describe('agents.tier-models resolution (DR-1)', () => {
    it('ResolveConfig_TierModelsAbsent_UsesDocumentedDefaults', () => {
      const resolved = resolveConfig({});
      expect(resolved.agents.tierModels).toEqual({
        low: 'haiku',
        medium: 'sonnet',
        high: 'opus',
      });
    });

    /** A partial override changes only the named tiers. `{ medium: opus }` keeps the table monotone. */
    it('ResolveConfig_TierModelsOverride_Honored', () => {
      const resolved = resolveConfig({ agents: { 'tier-models': { medium: 'opus' } } });
      expect(resolved.agents.tierModels).toEqual({
        low: 'haiku',
        medium: 'opus',
        high: 'opus',
      });
    });

    /** The high-tier floor is `sonnet`, not `opus`, so an operator can set `high` to `sonnet`. */
    it('ResolveConfig_HighTierSonnet_Accepted', () => {
      const resolved = resolveConfig({
        agents: { 'tier-models': { low: 'haiku', medium: 'sonnet', high: 'sonnet' } },
      });
      expect(resolved.agents.tierModels.high).toBe('sonnet');
    });

    /**
     * `low: sonnet` with `medium: haiku` puts a weaker model at a higher tier. `high` stays `opus`,
     * so only the monotonicity rule fails. The error names the offending cell.
     */
    it('ResolveConfig_NonMonotoneTierModels_RejectsWithStructuredError', () => {
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

    /** The high-tier floor is `sonnet`. The error names the `high` cell and `haiku`. */
    it('ResolveConfig_HighTierHaiku_Rejected', () => {
      expect(() =>
        resolveConfig({ agents: { 'tier-models': { high: 'haiku' } } }),
      ).toThrow(/agents\.tier-models\.high/);
      expect(() =>
        resolveConfig({ agents: { 'tier-models': { high: 'haiku' } } }),
      ).toThrow(/haiku/);
    });

    /** An all-haiku table is monotone, but it fails the high-tier floor. The error names the `high` cell. */
    it('ResolveConfig_AllHaikuTierModels_RejectedByHighFloor', () => {
      expect(() =>
        resolveConfig({ agents: { 'tier-models': { low: 'haiku', medium: 'haiku', high: 'haiku' } } }),
      ).toThrow(/agents\.tier-models\.high/);
    });

    it('ResolveConfig_TierModels_Frozen', () => {
      const resolved = resolveConfig({});
      expect(Object.isFrozen(resolved.agents.tierModels)).toBe(true);
    });

    it('ResolveConfig_TierModels_DoesNotFreezeCallerOverride', () => {
      const override = { high: 'sonnet' as const };
      resolveConfig({ agents: { 'tier-models': override } });
      expect(Object.isFrozen(override)).toBe(false);
    });
  });

  describe('verification resolution', () => {
    /** With no `verification:` block, `policy` is `{}`, so the later resolver adds nothing to the base policy table. */
    it('ResolveConfig_NoVerificationBlock_DefaultsToEmptyOverlay', () => {
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

  describe('emission enforcement', () => {
    /**
     * The default is `block` in every environment. A mode that fails only in CI never fails the local
     * run, which can find the drift first. An operator can still set `advisory` explicitly.
     */
    it('EmissionEnforcement_CiAndDev_DefaultToFailing', () => {
      const original = process.env.CI;
      try {
        for (const ci of ['true', 'false', undefined]) {
          if (ci === undefined) delete process.env.CI;
          else process.env.CI = ci;

          expect(resolveConfig({}).events.emissionEnforcement).toBe('block');
        }
      } finally {
        if (original === undefined) delete process.env.CI;
        else process.env.CI = original;
      }

      expect(DEFAULTS.events.emissionEnforcement).toBe('block');

      expect(
        resolveConfig({ events: { 'emission-enforcement': 'advisory' } }).events
          .emissionEnforcement,
      ).toBe('advisory');
    });

    /**
     * Without a `projectRoot`, `initializeContext` returns no `projectConfig`, so the resolved default
     * does not apply. The stated fallback is `block`, because a missing config file is not an opt-out.
     * An explicit `advisory` still does not block, and a `not-applicable` verdict never blocks.
     */
    it('EmissionEnforcement_NoProjectConfig_UsesTheStatedFallback', () => {
      expect(resolveEmissionEnforcement(undefined)).toBe(EMISSION_ENFORCEMENT_FALLBACK);
      expect(EMISSION_ENFORCEMENT_FALLBACK).toBe('block');
      expect(EMISSION_ENFORCEMENT_FALLBACK).toBe(DEFAULTS.events.emissionEnforcement);

      const violated = {
        status: 'violated',
        missingEvents: ['workflow.started'],
        lifecycleViolations: [],
        required: ['workflow.started'],
      } as const;

      expect(emissionViolationBlocks(violated, undefined)).toBe(true);
      expect(
        emissionViolationBlocks(violated, resolveConfig({ events: { 'emission-enforcement': 'advisory' } })),
      ).toBe(false);
      expect(
        emissionViolationBlocks(
          { status: 'not-applicable', reason: 'no-stream', missingEvents: [], lifecycleViolations: [], required: ['x'] },
          undefined,
        ),
      ).toBe(false);
    });

    /**
     * An indeterminate verdict blocks under `block` and not under `advisory`, as a violation does.
     * `emissionIndeterminacyBlocks` does not block a `not-applicable` verdict, and
     * `emissionViolationBlocks` does not block an indeterminate verdict.
     * The mode comes from the config object only. An environment variable named for the key changes nothing.
     */
    it('EmissionEnforcement_IndeterminateVerdict_BlocksOnConfigAloneNotEnvironment', () => {
      const unassessed = {
        status: 'indeterminate',
        cause: 'store-unavailable',
        missingEvents: [],
        lifecycleViolations: [],
        required: ['workflow.started'],
      } as const;

      expect(emissionIndeterminacyBlocks(unassessed, undefined)).toBe(true);
      expect(
        emissionIndeterminacyBlocks(
          unassessed,
          resolveConfig({ events: { 'emission-enforcement': 'advisory' } }),
        ),
      ).toBe(false);

      const benign = {
        status: 'not-applicable',
        reason: 'handler-refused',
        missingEvents: [],
        lifecycleViolations: [],
        required: ['workflow.started'],
      } as const;
      expect(emissionIndeterminacyBlocks(benign, undefined)).toBe(false);
      expect(emissionViolationBlocks(unassessed, undefined)).toBe(false);

      const previous = process.env.EXARCHOS_EMISSION_ENFORCEMENT;
      process.env.EXARCHOS_EMISSION_ENFORCEMENT = 'advisory';
      try {
        expect(emissionIndeterminacyBlocks(unassessed, undefined)).toBe(true);
        expect(resolveEmissionEnforcement(undefined)).toBe('block');
      } finally {
        if (previous === undefined) delete process.env.EXARCHOS_EMISSION_ENFORCEMENT;
        else process.env.EXARCHOS_EMISSION_ENFORCEMENT = previous;
      }
    });

    /**
     * The environment variable names the opposite of each explicit config value. If the environment
     * reached the decision, one of the two results changes.
     */
    it('EmissionVerifier_EnvironmentDoesNotOverrideExplicitPolicy', () => {
      const previous = process.env.EXARCHOS_EMISSION_ENFORCEMENT;
      process.env.EXARCHOS_EMISSION_ENFORCEMENT = 'advisory';
      try {
        expect(
          resolveConfig({ events: { 'emission-enforcement': 'block' } }).events.emissionEnforcement,
        ).toBe('block');
      } finally {
        if (previous === undefined) delete process.env.EXARCHOS_EMISSION_ENFORCEMENT;
        else process.env.EXARCHOS_EMISSION_ENFORCEMENT = previous;
      }

      process.env.EXARCHOS_EMISSION_ENFORCEMENT = 'block';
      try {
        expect(
          resolveConfig({ events: { 'emission-enforcement': 'advisory' } }).events
            .emissionEnforcement,
        ).toBe('advisory');
      } finally {
        if (previous === undefined) delete process.env.EXARCHOS_EMISSION_ENFORCEMENT;
        else process.env.EXARCHOS_EMISSION_ENFORCEMENT = previous;
      }
    });
  });
});
