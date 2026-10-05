/**
 * Tests that `content/harness/runtimes/claude.yaml` declares `supportedCapabilities` as a YAML mapping
 * that agrees with `claudeAdapter.supportLevels`. The skills renderer reads the mapping to gate the
 * `<!-- requires:CAP -->` and `<!-- requires:native:CAP -->` blocks.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { claudeAdapter } from '../../../../src/runtime/agents/adapters/claude.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** The path of the Claude runtime map. The repository root is four directories above this file. */
const CLAUDE_YAML_PATH = resolve(
  __dirname,
  '../../../../content/harness/runtimes/claude.yaml');

const REQUIRED_CAPABILITY_KEYS = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'subagent:spawn',
  'subagent:completion-signal',
  'subagent:start-signal',
  'mcp:exarchos',
  'mcp:exarchos:readonly',
  'isolation:worktree',
  'team:agent-teams',
  'session:resume',
] as const;

function loadClaudeYaml(): Record<string, unknown> {
  const raw = readFileSync(CLAUDE_YAML_PATH, 'utf8');
  const parsed = yamlParse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Expected ${CLAUDE_YAML_PATH} to parse to an object, got ${
        parsed === null ? 'null' : typeof parsed
      }`,
    );
  }
  return parsed as Record<string, unknown>;
}

describe('content/harness/runtimes/claude.yaml supportedCapabilities', () => {
  /**
   * `supportedCapabilities` must be a YAML mapping, not a list, because the renderer reads one support level per capability.
   * The mapping must hold the eleven capability keys and no other key.
   */
  it('ClaudeYaml_SupportedCapabilities_AllElevenAreNative', () => {
    const data = loadClaudeYaml();
    const supported = data.supportedCapabilities;

    expect(supported).toBeDefined();
    expect(supported).not.toBeNull();
    expect(Array.isArray(supported)).toBe(false);
    expect(typeof supported).toBe('object');

    const map = supported as Record<string, unknown>;

    for (const key of REQUIRED_CAPABILITY_KEYS) {
      expect(map, `missing capability key '${key}'`).toHaveProperty(key);
      expect(map[key], `capability '${key}' should be 'native'`).toBe('native');
    }

    expect(Object.keys(map).sort()).toEqual([...REQUIRED_CAPABILITY_KEYS].sort());
  });

  /**
   * The YAML level must equal the adapter level for each capability that the adapter supports.
   * The loop skips an `unsupported` capability and does not check that the YAML omits it.
   */
  it('ClaudeYaml_AdapterAlignment_MatchesSupportLevels', () => {
    const data = loadClaudeYaml();
    const supported = data.supportedCapabilities as Record<string, unknown>;

    for (const [cap, level] of Object.entries(claudeAdapter.supportLevels)) {
      if (level === 'unsupported') {
        continue;
      }
      expect(
        supported[cap],
        `claude.yaml.supportedCapabilities['${cap}'] should match adapter level '${level}'`,
      ).toBe(level);
    }
  });
});
