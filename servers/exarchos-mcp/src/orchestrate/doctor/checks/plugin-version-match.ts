/**
 * plugin-version-match — compares the installed plugin's package.json
 * version (from the Claude Code plugin cache) against the running
 * version (the repo-root package.json the MCP server was built from).
 * Mismatch warns; absent installation skips rather than fails, since
 * running from source is a legitimate dev-mode configuration.
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
