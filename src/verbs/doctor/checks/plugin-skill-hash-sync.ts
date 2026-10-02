/**
 * plugin-skill-hash-sync: reports drift between `content/` and the rendered
 * skills. The probe detects the drift with an mtime heuristic. This check maps
 * the probe result to a CheckResult.
 */

import type { CheckFn } from './__shared__/make-stub-probes.js';

export const pluginSkillHashSync: CheckFn = async (probes, signal) => {
  const start = Date.now();
  const status = await probes.skills.guardStatus(signal);
  const base = { category: 'plugin' as const, name: 'plugin-skill-hash-sync' };

  if (status.inSync) {
    return {
      ...base,
      status: 'Pass',
      message: 'Installed skills hashes match source (no drift)',
      durationMs: Date.now() - start,
    };
  }
  const count = status.driftedPaths?.length ?? 0;
  return {
    ...base,
    status: 'Warning',
    message: `${count} skill file(s) drifted from source. Run npm run build:skills to regenerate`,
    fix: 'Run npm run build:skills to regenerate',
    durationMs: Date.now() - start,
  };
};
