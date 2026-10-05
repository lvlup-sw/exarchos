/**
 * Presence test for `content/harness/runtimes/copilot.yaml`. It is a smoke check of the main fields.
 * Exarchos uses the Copilot CLI call `task --agent <name>`, which starts a custom agent in the current session.
 * Exarchos does not use `/delegate`, because that command sends the work to the cloud Copilot Coding Agent.
 * `tests/unit/runtime/runtimes/copilot.test.ts` holds the capability-mapping assertions.
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from '../../../../src/install/runtimes/load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '../../../../content/harness/runtimes');
const COPILOT_YAML = resolve(RUNTIMES_DIR, 'copilot.yaml');

describe('content/harness/runtimes/copilot.yaml presence', () => {
  it('LoadAllRuntimes_CopilotYamlPresent_HasSubagents', () => {
    const runtime = loadRuntime(COPILOT_YAML);

    expect(runtime.name).toBe('copilot');
    expect(runtime.capabilities.hasSubagents).toBe(true);
  });

  it('CopilotYaml_SpawnAgentCall_UsesLocalTaskAgentPrimitive', () => {
    const runtime = loadRuntime(COPILOT_YAML);
    expect(runtime.placeholders.SPAWN_AGENT_CALL).toContain('task --agent');
    expect(runtime.placeholders.SPAWN_AGENT_CALL).not.toContain('/delegate');
  });

  /** The path agrees with the other Copilot configuration under `~/.copilot/`, such as agents and `lsp-config.json`. */
  it('CopilotYaml_SkillsInstallPath_CopilotConfig', () => {
    const runtime = loadRuntime(COPILOT_YAML);
    expect(runtime.skillsInstallPath).toBeDefined();
    expect(runtime.skillsInstallPath.length).toBeGreaterThan(0);
    expect(runtime.skillsInstallPath).toBe('~/.copilot/skills');
  });
});
