/**
 * Presence test for `runtimes/codex.yaml`.
 *
 * Codex CLI exposes a first-class multi-agent surface via the `spawn_agent`
 * / `close_agent` / `wait_agent` / `send_input` / `resume_agent` tool
 * family (see `codex-rs/core/src/tools/handlers/multi_agents.rs` and
 * `codex-rs/tools/src/agent_tool.rs` in openai/codex). This runtime map
 * therefore advertises `hasSubagents: true` and routes delegation through
 * `spawn_agent`.
 *
 * Implements: DR-4, DR-5 (codex branch), OQ-1
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '..', '..', 'runtimes');
const CODEX_YAML = resolve(RUNTIMES_DIR, 'codex.yaml');

describe('runtimes/codex.yaml presence', () => {
  it('LoadAllRuntimes_CodexYamlPresent_HasSubagents', () => {
    const runtime = loadRuntime(CODEX_YAML);

    expect(runtime.name).toBe('codex');
    expect(runtime.capabilities.hasSubagents).toBe(true);
  });

  it('CodexYaml_SpawnAgentCall_UsesMultiAgentPrimitive', () => {
    const runtime = loadRuntime(CODEX_YAML);
    // Recon (openai/codex @ main, codex-rs/tools/src/agent_tool.rs) confirmed
    // the function-call tool name is the literal string "spawn_agent".
    expect(runtime.placeholders.SPAWN_AGENT_CALL).toContain('spawn_agent');
  });

  it('CodexYaml_SkillsInstallPath_AgentsStandard', () => {
    const runtime = loadRuntime(CODEX_YAML);
    expect(runtime.skillsInstallPath).toBe('$HOME/.agents/skills');
  });
});
