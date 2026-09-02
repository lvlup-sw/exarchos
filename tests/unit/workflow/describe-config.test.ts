import { describe, it, expect } from 'vitest';
import { buildConfigDescription } from '../../../src/workflow/describe-config.js';
import { DEFAULTS, resolveConfig } from '../../../src/config/resolve.js';

describe('buildConfigDescription', () => {
  it('DescribeConfig_NoYml_AllDefaults', () => {
    const result = buildConfigDescription(DEFAULTS);
    expect(result.review.dimensions.D1.value).toBe('blocking');
    expect(result.review.dimensions.D1.source).toBe('default');
    expect(result.vcs.provider.source).toBe('default');
  });

  it('DescribeConfig_WithOverrides_SourceAnnotated', () => {
    const config = resolveConfig({ review: { dimensions: { D3: 'warning' } } });
    const result = buildConfigDescription(config);

    expect(result.review.dimensions.D3.value).toBe('warning');
    expect(result.review.dimensions.D3.source).toBe('.exarchos.yml');
    // Unchanged dimensions should be 'default'
    expect(result.review.dimensions.D1.source).toBe('default');
  });

  it('DescribeConfig_AllSectionsPresent', () => {
    const result = buildConfigDescription(DEFAULTS);
    // Parity check — any top-level section added to DEFAULTS must appear
    // in the description output (and vice versa), so future sections can't
    // silently regress.
    expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });

  it('DescribeConfig_GateOverride_ShowsGateAndDimension', () => {
    // Verification-ladder slice 1: `tdd-compliance` now defaults to advisory
    // (blocking:false), so an override must use the OPPOSITE value (blocking:
    // true) to register as a user `.exarchos.yml` change rather than collapsing
    // to the default. This re-blocks the gate explicitly.
    const config = resolveConfig({
      review: { gates: { 'tdd-compliance': { blocking: true } } },
    });
    const result = buildConfigDescription(config);

    expect(result.review.gates['tdd-compliance'].blocking.value).toBe(true);
    expect(result.review.gates['tdd-compliance'].blocking.source).toBe('.exarchos.yml');
  });

  it('DescribeConfig_VcsOverride_ShowsSource', () => {
    const config = resolveConfig({ vcs: { provider: 'gitlab' } });
    const result = buildConfigDescription(config);

    expect(result.vcs.provider.value).toBe('gitlab');
    expect(result.vcs.provider.source).toBe('.exarchos.yml');
  });

  it('DescribeConfig_ToolsDefaults_AllDefault', () => {
    const result = buildConfigDescription(DEFAULTS);
    expect(result.tools.commitStyle.value).toBe('conventional');
    expect(result.tools.commitStyle.source).toBe('default');
    expect(result.tools.autoMerge.value).toBe(true);
    expect(result.tools.autoMerge.source).toBe('default');
    expect(result.tools.prStrategy.value).toBe('github-native');
    expect(result.tools.prStrategy.source).toBe('default');
  });

  it('DescribeConfig_ToolsOverride_ShowsSource', () => {
    const config = resolveConfig({ tools: { 'auto-merge': false } });
    const result = buildConfigDescription(config);

    expect(result.tools.autoMerge.value).toBe(false);
    expect(result.tools.autoMerge.source).toBe('.exarchos.yml');
    // Non-overridden tools stay default
    expect(result.tools.commitStyle.source).toBe('default');
  });

  it('DescribeConfig_WorkflowDefaults_AllDefault', () => {
    const result = buildConfigDescription(DEFAULTS);
    expect(result.workflow.skipPhases.value).toEqual([]);
    expect(result.workflow.skipPhases.source).toBe('default');
    expect(result.workflow.maxFixCycles.value).toBe(3);
    expect(result.workflow.maxFixCycles.source).toBe('default');
  });

  it('DescribeConfig_WorkflowOverride_ShowsSource', () => {
    const config = resolveConfig({ workflow: { 'max-fix-cycles': 5 } });
    const result = buildConfigDescription(config);

    expect(result.workflow.maxFixCycles.value).toBe(5);
    expect(result.workflow.maxFixCycles.source).toBe('.exarchos.yml');
  });

  it('DescribeConfig_HooksDefaults_AllDefault', () => {
    const result = buildConfigDescription(DEFAULTS);
    expect(result.hooks.on.value).toEqual({});
    expect(result.hooks.on.source).toBe('default');
  });

  it('DescribeConfig_HooksOverride_ShowsSource', () => {
    const config = resolveConfig({
      hooks: { on: { 'workflow.transition': [{ command: 'echo test' }] } },
    });
    const result = buildConfigDescription(config);

    expect(result.hooks.on.source).toBe('.exarchos.yml');
  });

  it('DescribeConfig_PruneDefaults_AllDefault', () => {
    const result = buildConfigDescription(DEFAULTS);
    expect(result.prune.maxBatchSize.value).toBe(25);
    expect(result.prune.requireDryRun.value).toBe(true);
    expect(result.prune.malformedHandling.value).toBe('report');
    expect(result.prune.phaseExclusions.value).toEqual(['delegate', 'review', 'synthesize']);
  });

  it('DescribeConfig_PruneOverride_ShowsSource', () => {
    const config = resolveConfig({ prune: { 'max-batch-size': 7 } });
    const result = buildConfigDescription(config);

    expect(result.prune.maxBatchSize.value).toBe(7);
    expect(result.prune.maxBatchSize.source).toBe('.exarchos.yml');
    expect(result.prune.requireDryRun.source).toBe('default');
  });

  it('DescribeConfig_StaleAfterDaysRemoved_OmitsAnnotatedField', () => {
    // DR-9: the removed `staleAfterDays` knob must no longer appear in the
    // annotated config description — the surface disappears with the config
    // field, not just the value.
    const result = buildConfigDescription(DEFAULTS);
    expect('staleAfterDays' in result.prune).toBe(false);
    // Surviving prune knobs are still annotated.
    expect('maxBatchSize' in result.prune).toBe(true);
  });

  it('DescribeConfig_CheckpointDefaults_AllDefault', () => {
    const result = buildConfigDescription(DEFAULTS);
    expect(result.checkpoint.operationThreshold.value).toBe(20);
    expect(result.checkpoint.operationThreshold.source).toBe('default');
    expect(result.checkpoint.enforceOnPhaseTransition.value).toBe(true);
    expect(result.checkpoint.enforceOnWaveDispatch.value).toBe(true);
  });

  it('DescribeConfig_CheckpointOverride_ShowsSource', () => {
    const config = resolveConfig({ checkpoint: { 'operation-threshold': 10 } });
    const result = buildConfigDescription(config);

    expect(result.checkpoint.operationThreshold.value).toBe(10);
    expect(result.checkpoint.operationThreshold.source).toBe('.exarchos.yml');
  });

  it('DescribeConfig_AgentsDefaults_AllDefault', () => {
    const result = buildConfigDescription(DEFAULTS);
    expect(result.agents.defaultModel.value).toBe('opus');
    expect(result.agents.defaultModel.source).toBe('default');
    expect(result.agents.models.source).toBe('default');
  });

  it('DescribeConfig_AgentsOverride_ShowsSource', () => {
    const config = resolveConfig({
      agents: { 'default-model': 'sonnet', models: { implementer: 'opus' } },
    });
    const result = buildConfigDescription(config);

    expect(result.agents.defaultModel.value).toBe('sonnet');
    expect(result.agents.defaultModel.source).toBe('.exarchos.yml');
    expect(result.agents.models.source).toBe('.exarchos.yml');
  });

  it('DescribeConfig_PluginsDefaults_AllDefault', () => {
    const result = buildConfigDescription(DEFAULTS);
    expect(result.plugins.impeccable.enabled.value).toBe(true);
    expect(result.plugins.impeccable.enabled.source).toBe('default');
  });

  it('DescribeConfig_PluginsOverride_ShowsSource', () => {
    const config = resolveConfig({ plugins: { impeccable: { enabled: false } } });
    const result = buildConfigDescription(config);

    expect(result.plugins.impeccable.enabled.value).toBe(false);
    expect(result.plugins.impeccable.enabled.source).toBe('.exarchos.yml');
  });
});

// ─── #1360 — describe('update') reservedFields block (PR 2 / T4) ───────────
//
// `exarchos_workflow.describe({actions:['update']})` enumerates the
// `RESERVED_FIELDS_DESCRIPTOR` under a `reservedFields` key so agents
// discover the boundary (top-level immutable keys, the underscore rule,
// alternate write paths) without trial-and-error.
describe('describe(update).reservedFields (#1360)', () => {
  it('Describe_ActionUpdate_ReturnsReservedFieldsBlock', async () => {
    const { handleDescribe } = await import('../../../src/describe/handler.js');
    const { TOOL_REGISTRY } = await import('../../../src/registry.js');
    const { RESERVED_FIELDS_DESCRIPTOR } = await import('../../../src/workflow/schemas.js');

    const workflowTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_workflow');
    expect(workflowTool).toBeDefined();

    const result = await handleDescribe({ actions: ['update'] }, workflowTool!.actions);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data as Record<string, unknown>;
    const updateDesc = data.update as Record<string, unknown>;
    expect(updateDesc).toBeDefined();
    expect(updateDesc.reservedFields).toBeDefined();

    const reservedFields = updateDesc.reservedFields as Record<string, unknown>;
    expect(reservedFields.topLevelImmutable).toEqual(
      RESERVED_FIELDS_DESCRIPTOR.topLevelImmutable,
    );
    expect(reservedFields.underscorePrefixRule).toBe(
      RESERVED_FIELDS_DESCRIPTOR.underscorePrefixRule,
    );
    expect(reservedFields.examples).toEqual(RESERVED_FIELDS_DESCRIPTOR.examples);
    expect(reservedFields.alternateWritePaths).toEqual(
      RESERVED_FIELDS_DESCRIPTOR.alternateWritePaths,
    );
  });
});
