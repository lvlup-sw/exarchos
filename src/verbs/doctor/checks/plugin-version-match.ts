/**
 * Compares the installed plugin version with the running version.
 * A mismatch gives a warning. If no plugin is installed, the check skips, because a run from source is a valid dev mode.
 */

import type { CheckFn } from './__shared__/make-stub-probes.js';

export const pluginVersionMatch: CheckFn = async (probes, _signal) => {
  const start = Date.now();
  const [installed, running] = await Promise.all([
    probes.plugin.installedVersion(),
    probes.plugin.runningVersion(),
  ]);
  const base = { category: 'plugin' as const, name: 'plugin-version-match' };

  if (installed === null) {
    const reason = 'Plugin not installed locally; running from source or dev mode';
    return { ...base, status: 'Skipped', message: reason, reason, durationMs: Date.now() - start };
  }
  if (running === null) {
    return {
      ...base,
      status: 'Warning',
      message: `Installed plugin v${installed}; unable to determine running plugin version`,
      fix: 'Ensure repository package.json is readable, then rerun exarchos doctor',
      durationMs: Date.now() - start,
    };
  }
  if (installed === running) {
    return {
      ...base,
      status: 'Pass',
      message: `Plugin v${running} matches installed version`,
      durationMs: Date.now() - start,
    };
  }
  const fix = 'Reinstall exarchos plugin to match running version';
  return {
    ...base,
    status: 'Warning',
    message: `Installed plugin v${installed} does not match running v${running}. ${fix}`,
    fix,
    durationMs: Date.now() - start,
  };
};
