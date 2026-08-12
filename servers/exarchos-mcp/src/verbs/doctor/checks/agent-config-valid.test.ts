import { describe, it, expect } from 'vitest';
import type { AgentEnvironment } from '../../../runtime/agent-environment-detector.js';
import { makeStubProbes } from './__shared__/make-stub-probes.js';
import { agentConfigValid } from './agent-config-valid.js';

const controller = () => new AbortController().signal;

function env(overrides: Partial<AgentEnvironment> & { name: AgentEnvironment['name'] }): AgentEnvironment {
  return {
    configPath: `/stub/${overrides.name}`,
    configPresent: false,
    configValid: false,
    mcpRegistered: false,
    ...overrides,
  };
}

describe('agentConfigValid', () => {
  it('AgentConfigValid_AllDetectedEnvsConfigValid_ReturnsPass', async () => {
    const probes = makeStubProbes({
      detector: async () => [
        env({ name: 'claude-code', configPresent: true, configValid: true, mcpRegistered: true }),
        env({ name: 'cursor', configPresent: true, configValid: true, mcpRegistered: true }),
        env({ name: 'codex', configPresent: false, configValid: false }),
        env({ name: 'copilot', configPresent: false, configValid: false }),
        env({ name: 'opencode', configPresent: false, configValid: false }),
      ],
    });

    const result = await agentConfigValid(probes, controller());

    expect(result.category).toBe('agent');
    expect(result.name).toBe('agent-config-valid');
    expect(result.status).toBe('Pass');
    expect(result.message).toContain('claude-code');
    expect(result.message).toContain('cursor');
    expect(result.fix).toBeUndefined();
  });

  it('AgentConfigValid_ClaudeJsonMalformed_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      detector: async () => [
        env({
          name: 'claude-code',
          configPath: '/home/user/.claude.json',
          configPresent: true,
          configValid: false,
        }),
        env({ name: 'cursor', configPresent: true, configValid: true, mcpRegistered: true }),
        env({ name: 'codex', configPresent: false, configValid: false }),
        env({ name: 'copilot', configPresent: false, configValid: false }),
        env({ name: 'opencode', configPresent: false, configValid: false }),
      ],
    });

    const result = await agentConfigValid(probes, controller());

    expect(result.status).toBe('Warning');
    expect(result.message).toContain('claude-code');
    expect(result.fix).toBe('Run exarchos init --runtime claude-code to regenerate');
  });

  it('AgentConfigValid_NoAgentEnvironmentsDetected_ReturnsSkipped', async () => {
    const probes = makeStubProbes({
      detector: async () => [
        env({ name: 'claude-code', configPresent: false, configValid: false }),
        env({ name: 'cursor', configPresent: false, configValid: false }),
        env({ name: 'codex', configPresent: false, configValid: false }),
        env({ name: 'copilot', configPresent: false, configValid: false }),
        env({ name: 'opencode', configPresent: false, configValid: false }),
      ],
    });

    const result = await agentConfigValid(probes, controller());

    expect(result.status).toBe('Skipped');
    expect(result.reason).toBe('No agent runtime configs present in this project');
  });
});
