/**
 * agent-mcp-registered — is exarchos listed in `mcpServers` for every
 * detected runtime config? Only runtimes with `configPresent` AND
 * `configValid` are eligible; malformed configs are the other check's
 * concern. Pass when all registered, Warning naming runtimes missing
 * exarchos with a runtime-targeted `exarchos init` fix, Skipped when no
 * eligible envs exist.
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
