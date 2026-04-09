/**
 * Presence test for `runtimes/copilot.yaml`.
 *
 * GitHub Copilot CLI exposes a `/delegate` slash command that delegates a
 * task asynchronously to the Copilot coding agent (the background /
 * pull-request flavor). This is Exarchos's chosen delegation primitive on
 * Copilot because our worktree-fanout flow is already async-friendly and
 * because `/delegate` is the user-visible, documented surface. In-session
 * subagents also exist via the `task` tool / custom-agent mechanism but
 * require more setup.
 *
 * Implements: DR-4, DR-5 (copilot branch)
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '..', '..', 'runtimes');
const COPILOT_YAML = resolve(RUNTIMES_DIR, 'copilot.yaml');

describe('runtimes/copilot.yaml presence', () => {
  it('LoadAllRuntimes_CopilotYamlPresent_HasSubagents', () => {
    const runtime = loadRuntime(COPILOT_YAML);

    expect(runtime.name).toBe('copilot');
    expect(runtime.capabilities.hasSubagents).toBe(true);
  });

  it('CopilotYaml_SpawnAgentCall_UsesDelegateSlashCommand', () => {
    const runtime = loadRuntime(COPILOT_YAML);
    expect(runtime.placeholders.SPAWN_AGENT_CALL).toContain('/delegate');
  });

  it('CopilotYaml_SkillsInstallPath_CopilotConfig', () => {
    const runtime = loadRuntime(COPILOT_YAML);
    expect(runtime.skillsInstallPath).toBeDefined();
    expect(runtime.skillsInstallPath.length).toBeGreaterThan(0);
    // Prefer `~/.copilot/skills` to match the rest of the `~/.copilot/**`
    // config family (agents, lsp-config.json, etc.).
    expect(runtime.skillsInstallPath).toBe('~/.copilot/skills');
  });
});
