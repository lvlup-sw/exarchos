/**
 * Presence test for `runtimes/claude.yaml`.
 *
 * Claude Code is the reference runtime: it supports every capability we
 * care about (subagents via `Task`, slash commands, hooks, skill chaining
 * via `Skill`). Exarchos ships as a Claude Code plugin, so `mcpPrefix`
 * uses the plugin-scoped naming convention.
 *
 * Implements: DR-4, DR-5 (claude branch)
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '..', '..', 'runtimes');
const CLAUDE_YAML = resolve(RUNTIMES_DIR, 'claude.yaml');

describe('runtimes/claude.yaml presence', () => {
  it('LoadAllRuntimes_ClaudeYamlPresent_HasClaudeCapabilities', () => {
    const runtime = loadRuntime(CLAUDE_YAML);

    expect(runtime.name).toBe('claude');
    expect(runtime.capabilities.hasSubagents).toBe(true);
    expect(runtime.capabilities.hasSlashCommands).toBe(true);
    expect(runtime.capabilities.hasHooks).toBe(true);
    expect(runtime.capabilities.hasSkillChaining).toBe(true);
  });

  it('ClaudeYaml_McpPrefix_MatchesPluginNaming', () => {
    const runtime = loadRuntime(CLAUDE_YAML);
    expect(runtime.capabilities.mcpPrefix).toBe('mcp__plugin_exarchos_exarchos__');
  });

  it('ClaudeYaml_SpawnAgentCall_UsesTaskTool', () => {
    const runtime = loadRuntime(CLAUDE_YAML);
    expect(runtime.placeholders.SPAWN_AGENT_CALL).toContain('Task({');
  });

  it('ClaudeYaml_ChainToken_UsesSkillInvocation', () => {
    const runtime = loadRuntime(CLAUDE_YAML);
    expect(runtime.placeholders.CHAIN).toContain('Skill({');
  });
});
