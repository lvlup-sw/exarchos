/**
 * Presence test for `runtimes/generic.yaml`.
 *
 * This is the lowest-common-denominator runtime map: no subagents, no slash
 * commands, no hooks, no skill chaining. Any target runtime the installer
 * does not explicitly recognise falls back to this map.
 *
 * Implements: DR-4, DR-5 (generic branch)
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Production runtimes directory lives at the repo root of the worktree. From
// `src/runtimes/` that's two levels up.
const RUNTIMES_DIR = resolve(__dirname, '..', '..', 'runtimes');
const GENERIC_YAML = resolve(RUNTIMES_DIR, 'generic.yaml');

describe('runtimes/generic.yaml presence', () => {
  it('LoadAllRuntimes_GenericYamlPresent_HasCanonicalCapabilities', () => {
    const runtime = loadRuntime(GENERIC_YAML);

    expect(runtime.name).toBe('generic');
    expect(runtime.capabilities.hasSubagents).toBe(false);
    expect(runtime.capabilities.hasSlashCommands).toBe(false);
    expect(runtime.capabilities.hasHooks).toBe(false);
    expect(runtime.capabilities.hasSkillChaining).toBe(false);
    expect(runtime.capabilities.mcpPrefix).toBe('mcp__exarchos__');

    expect(runtime.skillsInstallPath).toBeDefined();
    expect(runtime.skillsInstallPath.length).toBeGreaterThan(0);
  });
});
