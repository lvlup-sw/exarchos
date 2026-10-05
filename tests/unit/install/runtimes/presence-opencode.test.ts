/**
 * Presence test for `content/harness/runtimes/opencode.yaml`.
 * OpenCode has subagents (through a `Task`-shaped tool) and slash commands, but no skill chaining.
 * Its global skills path is under `~/.config/opencode/`.
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from '../../../../src/install/runtimes/load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '../../../../content/harness/runtimes');
const OPENCODE_YAML = resolve(RUNTIMES_DIR, 'opencode.yaml');

describe('content/harness/runtimes/opencode.yaml presence', () => {
  it('LoadAllRuntimes_OpencodeYamlPresent_HasSubagents', () => {
    const runtime = loadRuntime(OPENCODE_YAML);

    expect(runtime.name).toBe('opencode');
    expect(runtime.capabilities.hasSubagents).toBe(true);
  });

  it('OpencodeYaml_SpawnAgentCall_MatchesClaudeTaskSyntax', () => {
    const runtime = loadRuntime(OPENCODE_YAML);
    expect(runtime.placeholders.SPAWN_AGENT_CALL).toContain('Task({');
  });

  it('OpencodeYaml_SkillsInstallPath_GlobalConfig', () => {
    const runtime = loadRuntime(OPENCODE_YAML);
    expect(runtime.skillsInstallPath).toBe('~/.config/opencode/skills');
  });
});
