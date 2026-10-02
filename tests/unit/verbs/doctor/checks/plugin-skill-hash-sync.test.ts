/**
 * Tests for the plugin-skill-hash-sync check. An in-sync probe gives Pass. A
 * probe that reports drift gives a Warning that names the `build:skills` fix.
 * `makeStubProbes` makes each probe that a test does not override throw.
 */

import { describe, it, expect } from 'vitest';
import { makeStubProbes } from '../../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import { pluginSkillHashSync } from '../../../../../src/verbs/doctor/checks/plugin-skill-hash-sync.js';

const signal = () => new AbortController().signal;

describe('pluginSkillHashSync', () => {
  it('PluginSkillHashSync_InSync_ReturnsPass', async () => {
    const probes = makeStubProbes({
      skills: {
        guardStatus: async () => ({ inSync: true }),
      },
    });

    const result = await pluginSkillHashSync(probes, signal());

    expect(result.category).toBe('plugin');
    expect(result.name).toBe('plugin-skill-hash-sync');
    expect(result.status).toBe('Pass');
    expect(result.message).toBe('Installed skills hashes match source (no drift)');
    expect(result.fix).toBeUndefined();
  });

  it('PluginSkillHashSync_DriftDetected_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      skills: {
        guardStatus: async () => ({
          inSync: false,
          driftedPaths: ['skills/claude/debug/SKILL.md', 'skills/codex/debug/SKILL.md'],
        }),
      },
    });

    const result = await pluginSkillHashSync(probes, signal());

    expect(result.status).toBe('Warning');
    expect(result.category).toBe('plugin');
    expect(result.message).toBe(
      '2 skill file(s) drifted from source. Run npm run build:skills to regenerate',
    );
    expect(result.fix).toBe('Run npm run build:skills to regenerate');
  });
});
