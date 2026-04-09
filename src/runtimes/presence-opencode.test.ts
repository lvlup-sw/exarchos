/**
 * Presence test for `runtimes/opencode.yaml`.
 *
 * OpenCode is a Claude-Code-compatible runtime that supports subagents
 * (via a `Task`-shaped tool) and slash commands but does not expose the
 * Claude-specific hook / skill-chaining surface. Its global skill install
 * path lives under `~/.config/opencode/`.
 *
 * Implements: DR-4, DR-5, OQ-3
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '..', '..', 'runtimes');
const OPENCODE_YAML = resolve(RUNTIMES_DIR, 'opencode.yaml');

describe('runtimes/opencode.yaml presence', () => {
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
