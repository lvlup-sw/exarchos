/**
 * agent-config-valid — do all detected agent runtime configs parse as
 * valid? Iterates `probes.detector()` output once. `configPresent:false`
 * runtimes are excluded (absence is not a validity problem); if every
 * remaining env has `configValid:true` we Pass, any `false` yields
 * Warning naming the offending runtime(s), and zero presence Skips.
 */

import type { CheckFn } from './__shared__/make-stub-probes.js';

export const agentConfigValid: CheckFn = async (probes, signal) => {
  const start = Date.now();
  const envs = (await probes.detector(signal)).filter((e) => e.configPresent);
  const base = { category: 'agent' as const, name: 'agent-config-valid' };

  if (envs.length === 0) {
    return {
      ...base,
      status: 'Skipped',
      message: 'No agent runtime configs present in this project',
      reason: 'No agent runtime configs present in this project',
      durationMs: Date.now() - start,
    };
  }

  const invalid = envs.filter((e) => !e.configValid);
  if (invalid.length === 0) {
    const names = envs.map((e) => e.name).join(', ');
    return {
      ...base,
      status: 'Pass',
      message: `${envs.length} agent runtime config(s) valid: ${names}`,
      durationMs: Date.now() - start,
    };
  }

  const names = invalid.map((e) => e.name).join(', ');
  const first = invalid[0]!;
  return {
    ...base,
    status: 'Warning',
    message: `${names} config malformed (${first.configPath})`,
    fix: `Run exarchos init --runtime ${first.name} to regenerate`,
    durationMs: Date.now() - start,
  };
};
