/**
 * Presence test for `content/harness/runtimes/generic.yaml`.
 * When the installer detects no agent runtime, it uses this map.
 * The map has no subagents, no slash commands, no hook system and no skill chaining.
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from '../../../../src/install/runtimes/load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '../../../../content/harness/runtimes');
const GENERIC_YAML = resolve(RUNTIMES_DIR, 'generic.yaml');

describe('content/harness/runtimes/generic.yaml presence', () => {
  it('LoadAllRuntimes_GenericYamlPresent_HasCanonicalCapabilities', () => {
    const runtime = loadRuntime(GENERIC_YAML);

    expect(runtime.name).toBe('generic');
    expect(runtime.capabilities.hasSubagents).toBe(false);
    expect(runtime.capabilities.hasSlashCommands).toBe(false);
    expect(runtime.capabilities.hasSkillChaining).toBe(false);
    expect(runtime.capabilities.mcpPrefix).toBe('mcp__exarchos__');

    expect(runtime.capabilities.hooks?.profile).toBe('none');
    expect(runtime.capabilities.hooks?.canInjectContext).toBe(false);
    expect(runtime.capabilities.hooks?.sessionStartEvent).toBeNull();
    expect(runtime.capabilities.hooks?.sessionEndEvent).toBeNull();

    expect(runtime.skillsInstallPath).toBeDefined();
    expect(runtime.skillsInstallPath.length).toBeGreaterThan(0);
  });
});
