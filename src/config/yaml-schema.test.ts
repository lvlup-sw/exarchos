import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { ProjectConfigSchema, FullExarchosConfigSchema } from './yaml-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  it('ProjectConfigSchema_MaxPlanRevisions_ValidatesRange', () => {
    // DR-1: same 1..10 int bound as max-fix-cycles.
    expect(ProjectConfigSchema.safeParse({ workflow: { 'max-plan-revisions': 0 } }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ workflow: { 'max-plan-revisions': 3 } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ workflow: { 'max-plan-revisions': 11 } }).success).toBe(false);
  });

  it('ProjectConfigSchema_MutationEnforcement_ValidatesEnum', () => {
    // DR-3: only 'block' | 'advisory'.
    expect(ProjectConfigSchema.safeParse({ review: { 'mutation-enforcement': 'block' } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ review: { 'mutation-enforcement': 'advisory' } }).success).toBe(true);
    expect(ProjectConfigSchema.safeParse({ review: { 'mutation-enforcement': 'warn' } }).success).toBe(false);
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
          'max-batch-size': 50,
          'phase-exclusions': ['delegate', 'review'],
          'malformed-handling': 'include',
          'require-dry-run': false,
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prune?.['max-batch-size']).toBe(50);
        expect(result.data.prune?.['phase-exclusions']).toEqual(['delegate', 'review']);
        expect(result.data.prune?.['malformed-handling']).toBe('include');
        expect(result.data.prune?.['require-dry-run']).toBe(false);
      }
    });

    it('PruneConfigSchema_EmptyObject_UsesDefaults', () => {
      const result = ProjectConfigSchema.parse({ prune: {} });
      expect(result.prune?.['max-batch-size']).toBe(25);
      expect(result.prune?.['phase-exclusions']).toEqual(['delegate', 'review', 'synthesize']);
      expect(result.prune?.['malformed-handling']).toBe('report');
      expect(result.prune?.['require-dry-run']).toBe(true);
    });

    it('PruneConfigSchema_RemovedStaleAfterDays_ActionableRemovalError', () => {
      // DR-9: `stale-after-days` was removed. A bare `.strict()` would surface
      // an OPAQUE `unrecognized_keys` that names neither the removal, #1334, nor
      // the real config surface — the form DR-9 bars. `PruneConfig` now parses
      // the removed key with `.passthrough().superRefine`, so the caller gets
      // the ACTIONABLE removal message instead (identical to the action seam).
      const result = ProjectConfigSchema.safeParse({ prune: { 'stale-after-days': 30 } });
      expect(result.success).toBe(false);
      if (!result.success) {
        // The actionable message wins: it names the removal (#1334), the field,
        // and the real surface (`topology.yaml`). No competing opaque
        // `unrecognized_keys` is emitted for the removed key.
        const message = result.error.issues.map((i) => i.message).join('; ');
        expect(message).toContain('stale-after-days');
        expect(message).toContain('#1334');
        expect(message).toContain('topology.yaml');
        expect(
          result.error.issues.some((i) => i.code === 'unrecognized_keys'),
        ).toBe(false);
      }
    });

    it('PruneConfigSchema_UnknownTypoKey_StillRejected', () => {
      // A genuinely-unknown key (caller typo, not a removed knob) is still
      // rejected — the removed-knob affordance must not swallow typos.
      const result = ProjectConfigSchema.safeParse({ prune: { 'max-bath-size': 10 } });
      expect(result.success).toBe(false);
      if (!result.success) {
        const message = result.error.issues.map((i) => i.message).join('; ');
        expect(message).toContain('max-bath-size');
      }
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
        plugins: { impeccable: { enabled: false } },
      });
      expect(result.success).toBe(true);
    });

    it('ProjectConfigSchema_Plugins_DefaultsEnabledTrue', () => {
      const result = ProjectConfigSchema.parse({ plugins: { impeccable: {} } });
      expect(result.plugins?.impeccable?.enabled).toBe(true);
    });

    it('ProjectConfigSchema_Plugins_AllowsDisabling', () => {
      const result = ProjectConfigSchema.safeParse({
        plugins: { impeccable: { enabled: false } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.plugins?.impeccable?.enabled).toBe(false);
      }
    });

    it('ProjectConfigSchema_Plugins_AcceptsPartialConfig', () => {
      const result = ProjectConfigSchema.safeParse({
        plugins: { impeccable: { enabled: true } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.plugins?.impeccable?.enabled).toBe(true);
      }
    });

    it('PluginsConfig_WithAxiomKey_Rejected', () => {
      // axiom is excised (#1477) — the strict PluginsConfig must reject it.
      const result = ProjectConfigSchema.safeParse({
        plugins: { axiom: { enabled: true } },
      });
      expect(result.success).toBe(false);
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
        plugins: { impeccable: { enabled: true, extra: 'value' } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('default .exarchos.yml', () => {
    // The committed `.exarchos.yml` legitimately carries keys from BOTH
    // concern-schemas (per the #1479 dual-reader reconciliation above
    // `FullExarchosConfigSchema`): project-level keys (`agents`, `review`,
    // `vcs`, ...) validated by `ProjectConfigSchema`, and top-level
    // toolchain-override keys (`test`, `typecheck`, `install`, `mutation`,
    // ...) validated by `ExarchosConfigSchema`. `FullExarchosConfigSchema`
    // is therefore the architecturally-correct reader for "does the real
    // config file parse" — `ProjectConfigSchema` alone rejects the
    // toolchain-override keys it was never meant to model.
    it('FullExarchosConfigSchema_DefaultExarchosYml_ParsesSuccessfully', () => {
      const content = readFileSync(resolve(__dirname, '../../.exarchos.yml'), 'utf-8');
      const parsed = parseYaml(content);
      expect(FullExarchosConfigSchema.safeParse(parsed).success).toBe(true);
    });

    // Widening the reader to the unified schema must not open a passthrough
    // hole: a genuinely-typo'd top-level key (valid in NEITHER concern-schema)
    // is still rejected, exactly as `.strict()` intends.
    it('FullExarchosConfigSchema_TypoTopLevelKey_StillRejected', () => {
      const content = readFileSync(resolve(__dirname, '../../.exarchos.yml'), 'utf-8');
      const parsed = parseYaml(content) as Record<string, unknown>;
      const withTypo = { ...parsed, mutaton: parsed.mutation };
      delete (withTypo as { mutation?: unknown }).mutation;
      const result = FullExarchosConfigSchema.safeParse(withTypo);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.code === 'unrecognized_keys'),
        ).toBe(true);
      }
    });
  });

  describe('verification section', () => {
    it('ProjectConfigSchema_VerificationPolicyValidCells_Parses', () => {
      // All six cells — base (low|medium|high) AND boundary (low|medium|high) —
      // accept ordered gate-name lists drawn from VERIFICATION_GATE_NAMES.
      const result = ProjectConfigSchema.safeParse({
        verification: {
          policy: {
            low: ['check_static_analysis'],
            medium: ['check_static_analysis', 'check_test_adequacy'],
            high: ['check_static_analysis', 'check_test_adequacy', 'check_integration_suite'],
            boundary: {
              low: ['check_static_analysis', 'check_contract_drift'],
              medium: ['check_static_analysis', 'check_test_adequacy', 'check_contract_drift', 'check_mock_boundary'],
              high: ['check_static_analysis', 'check_test_adequacy', 'check_integration_suite', 'check_contract_drift', 'check_mock_boundary'],
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('ProjectConfigSchema_VerificationUnknownGateName_RejectsAtParse', () => {
      const result = ProjectConfigSchema.safeParse({
        verification: { policy: { low: ['check_does_not_exist'] } },
      });
      expect(result.success).toBe(false);
    });

    it('ProjectConfigSchema_VerificationDuplicateGateInCell_Rejects', () => {
      const result = ProjectConfigSchema.safeParse({
        verification: { policy: { low: ['check_static_analysis', 'check_static_analysis'] } },
      });
      expect(result.success).toBe(false);
    });

    it('ProjectConfigSchema_VerificationUnknownKey_RejectsStrict', () => {
      // A typo'd key must fail at parse under `.strict()` — at every level.
      const topLevelTypo = ProjectConfigSchema.safeParse({
        verification: { policy: {}, extra: true },
      });
      expect(topLevelTypo.success).toBe(false);

      const cellTypo = ProjectConfigSchema.safeParse({
        verification: { policy: { lowww: ['check_static_analysis'] } },
      });
      expect(cellTypo.success).toBe(false);

      const boundaryTypo = ProjectConfigSchema.safeParse({
        verification: { policy: { boundary: { lowww: ['check_static_analysis'] } } },
      });
      expect(boundaryTypo.success).toBe(false);
    });

    it('ProjectConfigSchema_VerificationEmptyCellArray_Parses', () => {
      // An explicit empty array means "run nothing for this cell" — valid.
      const result = ProjectConfigSchema.safeParse({
        verification: { policy: { low: [] } },
      });
      expect(result.success).toBe(true);
    });

    it('ProjectConfigSchema_VerificationOmitted_IsValid', () => {
      const result = ProjectConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.verification).toBeUndefined();
      }
    });
  });

  describe('agents section', () => {
    it('ProjectConfigSchema_AgentsSection_AcceptsValidConfig', () => {
      const result = ProjectConfigSchema.safeParse({
        agents: {
          'default-model': 'opus',
          models: { implementer: 'opus', reviewer: 'sonnet', scaffolder: 'haiku' },
        },
      });
      expect(result.success).toBe(true);
    });

    it('ProjectConfigSchema_AgentsSection_AcceptsPartialConfig', () => {
      const result = ProjectConfigSchema.safeParse({
        agents: { 'default-model': 'sonnet' },
      });
      expect(result.success).toBe(true);
    });

    it('ProjectConfigSchema_AgentsSection_RejectsInvalidModel', () => {
      const result = ProjectConfigSchema.safeParse({
        agents: { 'default-model': 'gpt4' },
      });
      expect(result.success).toBe(false);
    });

    it('ProjectConfigSchema_AgentsSection_RejectsInvalidAgentKey', () => {
      const result = ProjectConfigSchema.safeParse({
        agents: { models: { orchestrator: 'opus' } },
      });
      expect(result.success).toBe(false);
    });

    it('ProjectConfigSchema_AgentsSection_OmittedIsValid', () => {
      const result = ProjectConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('ProjectConfigSchema_AgentsSection_RejectsUnknownKeys', () => {
      const result = ProjectConfigSchema.safeParse({
        agents: { 'default-model': 'opus', extra: true },
      });
      expect(result.success).toBe(false);
    });
  });
});
