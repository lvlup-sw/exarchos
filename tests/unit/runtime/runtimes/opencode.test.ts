/**
 * Tests for `content/harness/runtimes/opencode.yaml`.
 *
 * - `supportedCapabilities` must be a YAML mapping that agrees with `OpenCodeAdapter.supportLevels`.
 *   It holds six native and two advisory entries. It omits the three `unsupported` capabilities:
 *   the two Claude-only signal hooks and `team:agent-teams`.
 * - `SPAWN_AGENT_CALL` must set `subagent_type` to the `{{agent}}` token, not to `exarchos-implementer`.
 *   The adapter writes each agent file to `.opencode/agents/<id>.md` with no plugin prefix.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { OpenCodeAdapter } from '../../../../src/runtime/agents/adapters/opencode.js';
import type { Capability } from '../../../../src/runtime/agents/capabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** The path of the OpenCode runtime map. The repository root is four directories above this file. */
const OPENCODE_YAML_PATH = resolve(
  __dirname,
  '../../../../content/harness/runtimes/opencode.yaml');

/** The expected native capabilities. The three lists repeat the levels of `OpenCodeAdapter` by hand. */
const EXPECTED_NATIVE = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'subagent:spawn',
  'mcp:exarchos',
  'mcp:exarchos:readonly',
] as const;

const EXPECTED_ADVISORY = [
  'isolation:worktree',
  'session:resume',
] as const;

const EXPECTED_UNSUPPORTED = [
  'subagent:completion-signal',
  'subagent:start-signal',
  'team:agent-teams',
] as const;

function loadOpencodeYaml(): Record<string, unknown> {
  const raw = readFileSync(OPENCODE_YAML_PATH, 'utf8');
  const parsed = yamlParse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Expected ${OPENCODE_YAML_PATH} to parse to an object, got ${
        parsed === null ? 'null' : typeof parsed
      }`,
    );
  }
  return parsed as Record<string, unknown>;
}

describe('content/harness/runtimes/opencode.yaml supportedCapabilities', () => {
  /**
   * `supportedCapabilities` must be a YAML mapping, not a list, because the renderer reads one support level per capability.
   * The mapping must hold the six native keys and the two advisory keys, and no other key.
   */
  it('OpencodeYaml_SupportedCapabilities_SixNativeTwoAdvisory', () => {
    const data = loadOpencodeYaml();
    const supported = data.supportedCapabilities;

    expect(supported).toBeDefined();
    expect(supported).not.toBeNull();
    expect(Array.isArray(supported)).toBe(false);
    expect(typeof supported).toBe('object');

    const map = supported as Record<string, unknown>;

    for (const cap of EXPECTED_NATIVE) {
      expect(map, `missing native capability '${cap}'`).toHaveProperty(cap);
      expect(map[cap], `capability '${cap}' should be 'native'`).toBe('native');
    }

    for (const cap of EXPECTED_ADVISORY) {
      expect(map, `missing advisory capability '${cap}'`).toHaveProperty(cap);
      expect(map[cap], `capability '${cap}' should be 'advisory'`).toBe(
        'advisory',
      );
    }

    for (const cap of EXPECTED_UNSUPPORTED) {
      expect(
        map,
        `unsupported capability '${cap}' must be absent from YAML`,
      ).not.toHaveProperty(cap);
    }

    const expectedKeys = [...EXPECTED_NATIVE, ...EXPECTED_ADVISORY].sort();
    expect(Object.keys(map).sort()).toEqual(expectedKeys);
  });

  /**
   * The check runs in both directions. The YAML must agree with each adapter level and omit each `unsupported` capability.
   * Each YAML key must be a capability that the adapter marks native or advisory.
   */
  it('OpencodeYaml_AdapterAlignment_MatchesSupportLevels', () => {
    const data = loadOpencodeYaml();
    const supported = data.supportedCapabilities as Record<string, unknown>;

    for (const [cap, level] of Object.entries(OpenCodeAdapter.supportLevels)) {
      if (level === 'unsupported') {
        expect(
          supported,
          `unsupported capability '${cap}' must not appear in opencode.yaml`,
        ).not.toHaveProperty(cap);
        continue;
      }
      expect(
        supported[cap],
        `opencode.yaml.supportedCapabilities['${cap}'] should match adapter level '${level}'`,
      ).toBe(level);
    }

    for (const cap of Object.keys(supported)) {
      const level = OpenCodeAdapter.supportLevels[cap as Capability];
      expect(
        level,
        `opencode.yaml has key '${cap}' that the adapter does not classify`,
      ).toBeDefined();
      expect(level).not.toBe('unsupported');
    }
  });

  /**
   * `subagent_type` must hold the `{{agent}}` token in single or double quotes, with any whitespace.
   * It must not hold `exarchos-implementer`, because the adapter writes no agent file with that name.
   * The last check pins only the path form: the file name of the implementer agent path is `implementer`.
   */
  it('OpencodeYaml_SpawnAgentCall_ReferencesGeneratedAgentName', () => {
    const data = loadOpencodeYaml();
    const placeholders = data.placeholders as Record<string, string>;
    const spawnCall = placeholders.SPAWN_AGENT_CALL;

    expect(typeof spawnCall).toBe('string');

    const subagentTypePattern = /subagent_type\s*:\s*['"]\{\{\s*agent\s*\}\}['"]/;
    expect(spawnCall).toMatch(subagentTypePattern);

    expect(spawnCall).not.toMatch(
      /subagent_type\s*:\s*['"]exarchos-implementer['"]/,
    );

    const agentPath = OpenCodeAdapter.agentFilePath('implementer');
    const agentName = basename(agentPath, extname(agentPath));
    expect(agentName).toBe('implementer');
  });
});
