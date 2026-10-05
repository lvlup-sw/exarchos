/**
 * Presence test for `content/harness/runtimes/codex.yaml`.
 * Codex CLI has a multi-agent tool family: `spawn_agent`, `wait_agent`, `close_agent`, `send_input` and `resume_agent`.
 * The tool name in `codex-rs/tools/src/agent_tool.rs` of openai/codex is the literal string `spawn_agent`.
 * Thus the runtime map declares `hasSubagents: true` and delegates through `spawn_agent`.
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from '../../../../src/install/runtimes/load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '../../../../content/harness/runtimes');
const CODEX_YAML = resolve(RUNTIMES_DIR, 'codex.yaml');

describe('content/harness/runtimes/codex.yaml presence', () => {
  it('LoadAllRuntimes_CodexYamlPresent_HasSubagents', () => {
    const runtime = loadRuntime(CODEX_YAML);

    expect(runtime.name).toBe('codex');
    expect(runtime.capabilities.hasSubagents).toBe(true);
  });

  it('CodexYaml_SpawnAgentCall_UsesMultiAgentPrimitive', () => {
    const runtime = loadRuntime(CODEX_YAML);
    expect(runtime.placeholders.SPAWN_AGENT_CALL).toContain('spawn_agent');
  });

  it('CodexYaml_SkillsInstallPath_AgentsStandard', () => {
    const runtime = loadRuntime(CODEX_YAML);
    expect(runtime.skillsInstallPath).toBe('$HOME/.agents/skills');
  });
});
