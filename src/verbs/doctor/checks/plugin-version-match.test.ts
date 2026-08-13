/**
 * RED tests for plugin-version-match. Exercises the three branches:
 * (1) installed matches running → Pass, (2) versions differ → Warning
 * with reinstall fix, (3) installed missing → Skipped with source/dev
 * reason. Uses makeStubProbes so every non-plugin probe throws if
 * accidentally touched (DIM-4/T-4.2: ≤3 overrides per test).
 */

import { describe, it, expect } from 'vitest';
import { makeStubProbes } from './__shared__/make-stub-probes.js';
import { pluginVersionMatch } from './plugin-version-match.js';

const signal = () => new AbortController().signal;

describe('pluginVersionMatch', () => {
  it('PluginVersionMatch_InstalledMatchesRunning_ReturnsPass', async () => {
    const probes = makeStubProbes({
      plugin: {
        installedVersion: async () => '2.7.1',
        runningVersion: async () => '2.7.1',
      },
    });

    const result = await pluginVersionMatch(probes, signal());

    expect(result.category).toBe('plugin');
    expect(result.name).toBe('plugin-version-match');
    expect(result.status).toBe('Pass');
    expect(result.message).toBe('Plugin v2.7.1 matches installed version');
    expect(result.fix).toBeUndefined();
  });

  it('PluginVersionMatch_VersionMismatch_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      plugin: {
        installedVersion: async () => '2.6.1',
        runningVersion: async () => '2.7.1',
      },
    });

    const result = await pluginVersionMatch(probes, signal());

    expect(result.status).toBe('Warning');
    expect(result.category).toBe('plugin');
    expect(result.message).toBe(
      'Installed plugin v2.6.1 does not match running v2.7.1. Reinstall exarchos plugin to match running version',
    );
    expect(result.fix).toBe('Reinstall exarchos plugin to match running version');
  });

  it('PluginVersionMatch_InstalledPluginNotFound_ReturnsSkipped', async () => {
    const probes = makeStubProbes({
      plugin: {
        installedVersion: async () => null,
        runningVersion: async () => '2.7.1',
      },
    });

    const result = await pluginVersionMatch(probes, signal());

    expect(result.status).toBe('Skipped');
    expect(result.reason).toBe('Plugin not installed locally; running from source or dev mode');
  });
});
