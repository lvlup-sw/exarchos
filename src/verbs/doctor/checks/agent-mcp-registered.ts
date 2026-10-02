/**
 * Doctor check: does each detected runtime config list exarchos in `mcpServers`?
 * Only configs that are present and valid count. Another check reports malformed configs.
 * The check gives Pass when all list exarchos. It gives Warning with an `exarchos init` fix
 * when some do not. It gives Skipped when no config is present or all are malformed.
 */

import type { CheckFn } from './__shared__/make-stub-probes.js';

export const agentMcpRegistered: CheckFn = async (probes, signal) => {
  const start = Date.now();
  const detected = await probes.detector(signal);
  const present = detected.filter((e) => e.configPresent);
  const envs = present.filter((e) => e.configValid);
  const base = { category: 'agent' as const, name: 'agent-mcp-registered' };

  if (present.length === 0) {
    return {
      ...base,
      status: 'Skipped',
      message: 'No agent runtime configs present in this project',
      reason: 'No agent runtime configs present in this project',
      durationMs: Date.now() - start,
    };
  }
  if (envs.length === 0) {
    return {
      ...base,
      status: 'Skipped',
      message: 'Agent runtime configs present but all are malformed',
      reason: 'All detected runtime configs are malformed',
      durationMs: Date.now() - start,
    };
  }

  const missing = envs.filter((e) => !e.mcpRegistered);
  if (missing.length === 0) {
    const names = envs.map((e) => e.name).join(', ');
    return {
      ...base,
      status: 'Pass',
      message: `exarchos registered in ${envs.length} agent runtime(s): ${names}`,
      durationMs: Date.now() - start,
    };
  }

  const names = missing.map((e) => e.name).join(', ');
  const first = missing[0]!;
  return {
    ...base,
    status: 'Warning',
    message: `exarchos not registered in ${names} (${first.configPath})`,
    fix: `Run exarchos init --runtime ${first.name}`,
    durationMs: Date.now() - start,
  };
};
