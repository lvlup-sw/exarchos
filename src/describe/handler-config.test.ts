import { describe, it, expect } from 'vitest';
import { handleDescribe } from './handler.js';
import { DEFAULTS, resolveConfig } from '../config/resolve.js';
import { TOOL_REGISTRY } from '../registry.js';

const workflowActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!.actions;

describe('handleDescribe — config wiring (R8)', () => {
  it('describe_ConfigTrue_ReturnsAnnotatedConfig', async () => {
    const projectConfig = resolveConfig({
      vcs: { provider: 'gitlab' },
      workflow: { 'max-fix-cycles': 5 },
    });

    const result = await handleDescribe(
      { config: true },
      workflowActions,
      { projectConfig },
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.config).toBeDefined();

    const config = data.config as Record<string, unknown>;
    const vcs = config.vcs as Record<string, unknown>;
    const provider = vcs.provider as { value: string; source: string };
    expect(provider.value).toBe('gitlab');
    expect(provider.source).toBe('.exarchos.yml');

    const workflow = config.workflow as Record<string, unknown>;
    const maxFixCycles = workflow.maxFixCycles as { value: number; source: string };
    expect(maxFixCycles.value).toBe(5);
    expect(maxFixCycles.source).toBe('.exarchos.yml');
  });

  it('describe_ConfigTrue_NoProjectConfig_ReturnsMessage', async () => {
    const result = await handleDescribe(
      { config: true },
      workflowActions,
      { includeStateSchema: true }, // no projectConfig
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.config).toBeDefined();

    const config = data.config as Record<string, unknown>;
    expect(config.message).toContain('No .exarchos.yml');
  });

  it('describe_ConfigTrueWithDefaults_AllSourcesAreDefault', async () => {
    const result = await handleDescribe(
      { config: true },
      workflowActions,
      { projectConfig: DEFAULTS },
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const config = data.config as Record<string, unknown>;
    const vcs = config.vcs as Record<string, unknown>;
    const provider = vcs.provider as { value: string; source: string };
    expect(provider.value).toBe('github');
    expect(provider.source).toBe('default');
  });

  it('describe_ConfigFalseOrAbsent_NoConfigInResponse', async () => {
    // config: false should not include config
    // But we still need at least one of actions/topology/playbook/config
    // So config:false alone would fail validation. Let's combine with topology.
    const result = await handleDescribe(
      { topology: 'all' },
      workflowActions,
      { projectConfig: DEFAULTS },
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.config).toBeUndefined();
    expect(data.topology).toBeDefined();
  });

  it('describe_ConfigWithTopology_ReturnsBoth', async () => {
    const projectConfig = resolveConfig({ tools: { 'auto-merge': false } });

    const result = await handleDescribe(
      { config: true, topology: 'all' },
      workflowActions,
      { projectConfig },
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.config).toBeDefined();
    expect(data.topology).toBeDefined();

    const config = data.config as Record<string, unknown>;
    const tools = config.tools as Record<string, unknown>;
    const autoMerge = tools.autoMerge as { value: boolean; source: string };
    expect(autoMerge.value).toBe(false);
    expect(autoMerge.source).toBe('.exarchos.yml');
  });
});
