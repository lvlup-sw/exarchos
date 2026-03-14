import { describe, it, expect } from 'vitest';
import { buildConfigDescription } from './describe-config.js';
import { DEFAULTS, resolveConfig } from '../config/resolve.js';

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
    expect(result).toHaveProperty('review');
    expect(result).toHaveProperty('vcs');
    expect(result).toHaveProperty('workflow');
    expect(result).toHaveProperty('tools');
    expect(result).toHaveProperty('hooks');
  });

  it('DescribeConfig_GateOverride_ShowsGateAndDimension', () => {
    const config = resolveConfig({
      review: { gates: { 'tdd-compliance': { blocking: false } } },
    });
    const result = buildConfigDescription(config);

    expect(result.review.gates['tdd-compliance'].blocking.value).toBe(false);
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
});
