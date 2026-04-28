/**
 * Presence test for `runtimes/copilot.yaml`.
 *
 * GitHub Copilot CLI exposes the `task` tool with a `--agent <name>`
 * programmatic flag that locally spawns a custom agent in the current
 * session (isolated context, results returned inline). This is the
 * primitive Exarchos uses for worktree fan-out. The other Copilot
 * delegation primitive, `/delegate`, ships work asynchronously to the
 * cloud Copilot Coding Agent and opens a PR — wrong shape for an
 * in-session orchestrator, so we deliberately do not use it.
 *
 * Capability-mapping detail (mirrors `copilotAdapter.supportLevels`)
 * lives in `servers/exarchos-mcp/src/runtimes/copilot.test.ts` (Task 7e);
 * this presence test only covers the load-bearing field smoke checks.
 *
 * Implements: DR-4, DR-5 (copilot branch); Task 7e of
 * docs/plans/2026-04-25-delegation-runtime-parity.md
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

  it('CopilotYaml_SpawnAgentCall_UsesLocalTaskAgentPrimitive', () => {
    const runtime = loadRuntime(COPILOT_YAML);
    // Local custom-agent dispatch via the `task` tool with `--agent` flag.
    // See `servers/exarchos-mcp/src/runtimes/copilot.test.ts` for the
    // adapter-alignment + capability-mapping assertions.
    expect(runtime.placeholders.SPAWN_AGENT_CALL).toContain('task --agent');
    expect(runtime.placeholders.SPAWN_AGENT_CALL).not.toContain('/delegate');
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
