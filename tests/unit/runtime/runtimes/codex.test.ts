/**
 * Tests that the `supportedCapabilities` map in `content/harness/runtimes/codex.yaml` agrees with
 * `codexAdapter.supportLevels`. The skills renderer reads the YAML map, and the adapter emits the agent
 * definition files, so the two must agree.
 *
 * The Codex levels:
 * - native: `fs:read`, `fs:write`, `shell:exec`, `subagent:spawn`, `mcp:exarchos`, `mcp:exarchos:readonly`
 * - advisory: `isolation:worktree`, `session:resume`
 * - unsupported: `subagent:completion-signal`, `subagent:start-signal`, `team:agent-teams`
 *
 * The YAML map omits each `unsupported` capability, so a consumer detects it by its absence.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { codexAdapter } from '../../../../src/runtime/agents/adapters/codex.js';
import { Capability } from '../../../../src/runtime/agents/capabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** The repository root is four directories above this file. */
const REPO_ROOT = resolve(__dirname, '../../../..');
const CODEX_YAML_PATH = resolve(REPO_ROOT, 'content/harness/runtimes', 'codex.yaml');

interface CodexYamlShape {
  readonly supportedCapabilities?: Record<string, string>;
}

function loadCodexYaml(): CodexYamlShape {
  const raw = readFileSync(CODEX_YAML_PATH, 'utf8');
  const parsed = parseYaml(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Expected codex.yaml to parse to an object, got ${parsed === null ? 'null' : typeof parsed}`,
    );
  }
  return parsed as CodexYamlShape;
}

describe('content/harness/runtimes/codex.yaml supportedCapabilities (Task 7b)', () => {
  /**
   * Codex has a first-class primitive for each native capability and none for an advisory capability.
   * The map must hold exactly these eight keys.
   */
  it('CodexYaml_SupportedCapabilities_SixNativeTwoAdvisory', () => {
    const yaml = loadCodexYaml();

    expect(yaml.supportedCapabilities).toBeDefined();
    const map = yaml.supportedCapabilities ?? {};

    expect(map['fs:read']).toBe('native');
    expect(map['fs:write']).toBe('native');
    expect(map['shell:exec']).toBe('native');
    expect(map['subagent:spawn']).toBe('native');
    expect(map['mcp:exarchos']).toBe('native');
    expect(map['mcp:exarchos:readonly']).toBe('native');

    expect(map['isolation:worktree']).toBe('advisory');
    expect(map['session:resume']).toBe('advisory');

    expect(Object.keys(map)).toHaveLength(8);
  });

  it('CodexYaml_SupportedCapabilities_ExcludesClaudeOnlyCapabilities', () => {
    const yaml = loadCodexYaml();
    const map = yaml.supportedCapabilities ?? {};

    expect(map['subagent:completion-signal']).toBeUndefined();
    expect(map['subagent:start-signal']).toBeUndefined();
    expect(map['team:agent-teams']).toBeUndefined();
  });

  /**
   * For each capability in the vocabulary, the YAML level must equal the adapter level.
   * For an `unsupported` adapter level, the YAML must omit the key.
   */
  it('CodexYaml_AdapterAlignment_MatchesSupportLevels', () => {
    const yaml = loadCodexYaml();
    const map = yaml.supportedCapabilities ?? {};

    for (const cap of Capability.options) {
      const adapterLevel = codexAdapter.supportLevels[cap];
      const yamlLevel = map[cap];

      if (adapterLevel === 'unsupported') {
        expect(
          yamlLevel,
          `codex.yaml.supportedCapabilities should NOT contain ${cap} — adapter classifies it as unsupported`,
        ).toBeUndefined();
      } else {
        expect(
          yamlLevel,
          `codex.yaml.supportedCapabilities[${cap}] should equal adapter.supportLevels[${cap}] (${adapterLevel})`,
        ).toBe(adapterLevel);
      }
    }
  });
});
