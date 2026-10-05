/**
 * Tests for `content/harness/runtimes/copilot.yaml`.
 *
 * - `SPAWN_AGENT_CALL` must use the local Copilot CLI primitive `task --agent <name>`, not `/delegate`.
 *   `/delegate` sends the work to the cloud Copilot Coding Agent, which opens a PR.
 * - The spawn call must give the bare agent name, because the local agent loader of Copilot uses the
 *   file name `<name>.agent.md` as the key.
 * - `supportedCapabilities` must be a YAML mapping that agrees with the `supportLevels` of `CopilotAdapter`.
 *   It holds six native and two advisory entries, and omits the three unsupported capabilities.
 * - The YAML must not hold the comment text that justified `/delegate`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { CopilotAdapter } from '../../../../src/runtime/agents/adapters/copilot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** The path of the Copilot runtime map. The repository root is four directories above this file. */
const COPILOT_YAML_PATH = resolve(
  __dirname,
  '../../../../content/harness/runtimes/copilot.yaml');

function loadCopilotYamlText(): string {
  return readFileSync(COPILOT_YAML_PATH, 'utf8');
}

function loadCopilotYaml(): Record<string, unknown> {
  const parsed = yamlParse(loadCopilotYamlText());
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Expected ${COPILOT_YAML_PATH} to parse to an object, got ${
        parsed === null ? 'null' : typeof parsed
      }`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Returns the agent name from an adapter path of the form `.github/agents/<name>.agent.md`. */
function bareAgentName(adapterPath: string): string {
  const filename = adapterPath.split('/').pop() ?? '';
  return filename.replace(/\.agent\.md$/, '');
}

describe('content/harness/runtimes/copilot.yaml — local task --agent primitive', () => {
  /**
   * Copilot CLI runs a local custom agent through the `task` tool with the `--agent <name>` flag.
   * `/delegate` is remote and asynchronous, so it does not fit the in-session worktree fan-out.
   * Reference: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli
   */
  it('CopilotYaml_SpawnAgentCall_UsesLocalTaskAgentNotDelegate', () => {
    const data = loadCopilotYaml();
    const placeholders = data.placeholders as Record<string, unknown>;
    const spawn = placeholders?.SPAWN_AGENT_CALL;

    expect(typeof spawn).toBe('string');
    const spawnStr = spawn as string;

    expect(spawnStr).toContain('task --agent');

    expect(spawnStr).not.toContain('/delegate');
  });

  /**
   * The value after `--agent` must be the bare agent name from the adapter path, not the full file path.
   * The test accepts the literal `--agent implementer`, or any `{{word}}` placeholder after `--agent`.
   */
  it('CopilotYaml_SpawnAgentCall_ReferencesGeneratedAgentName', () => {
    const data = loadCopilotYaml();
    const placeholders = data.placeholders as Record<string, unknown>;
    const spawn = placeholders?.SPAWN_AGENT_CALL as string;

    const adapter = new CopilotAdapter();
    const expectedName = bareAgentName(adapter.agentFilePath('implementer'));
    expect(expectedName).toBe('implementer');

    const referencesBareName =
      spawn.includes(`--agent ${expectedName}`) ||
      /--agent\s+\{\{\s*\w+\s*\}\}/.test(spawn);
    expect(referencesBareName).toBe(true);
  });

  /**
   * `supportedCapabilities` must be a YAML mapping, not a list, because the renderer reads one support level per capability.
   * The mapping must hold the six native keys and the two advisory keys, and no other key.
   */
  it('CopilotYaml_SupportedCapabilities_SixNativeTwoAdvisory', () => {
    const data = loadCopilotYaml();
    const supported = data.supportedCapabilities;

    expect(supported).toBeDefined();
    expect(supported).not.toBeNull();
    expect(Array.isArray(supported)).toBe(false);
    expect(typeof supported).toBe('object');

    const map = supported as Record<string, unknown>;

    const expectedNative = [
      'fs:read',
      'fs:write',
      'shell:exec',
      'subagent:spawn',
      'mcp:exarchos',
      'mcp:exarchos:readonly',
    ];
    const expectedAdvisory = ['isolation:worktree', 'session:resume'];

    for (const key of expectedNative) {
      expect(map, `missing native capability '${key}'`).toHaveProperty(key);
      expect(map[key], `'${key}' should be 'native'`).toBe('native');
    }
    for (const key of expectedAdvisory) {
      expect(map, `missing advisory capability '${key}'`).toHaveProperty(key);
      expect(map[key], `'${key}' should be 'advisory'`).toBe('advisory');
    }

    expect(Object.keys(map).sort()).toEqual(
      [...expectedNative, ...expectedAdvisory].sort(),
    );
  });

  /** The YAML must omit each capability that the adapter marks `unsupported`, and must agree on each other level. */
  it('CopilotYaml_AdapterAlignment_MatchesSupportLevels', () => {
    const data = loadCopilotYaml();
    const supported = data.supportedCapabilities as Record<string, unknown>;
    const adapter = new CopilotAdapter();

    for (const [cap, level] of Object.entries(adapter.supportLevels)) {
      if (level === 'unsupported') {
        expect(
          Object.prototype.hasOwnProperty.call(supported, cap),
          `unsupported capability '${cap}' must NOT appear in supportedCapabilities`,
        ).toBe(false);
        continue;
      }
      expect(
        supported[cap],
        `copilot.yaml.supportedCapabilities['${cap}'] should match adapter level '${level}'`,
      ).toBe(level);
    }
  });

  /**
   * The YAML text must not hold the phrases of a comment block that justified `/delegate` over the local `task` tool.
   * Each pattern ignores case.
   */
  it('CopilotYaml_StaleJustificationComment_Removed', () => {
    const text = loadCopilotYamlText();

    const forbiddenPhrases = [
      /async\s+cloud\s+worker/i,
      /we\s+pick\s+\/delegate/i,
      /may\s+be\s+used\s+by\s+a\s+future\s+variant/i,
      /knowingly\s+picked\s+the\s+wrong\s+primitive/i,
      /Why we pick \/delegate over the `task` tool/i,
    ];
    for (const pattern of forbiddenPhrases) {
      expect(
        text,
        `stale justification phrase ${pattern} must not appear in copilot.yaml`,
      ).not.toMatch(pattern);
    }
  });
});
