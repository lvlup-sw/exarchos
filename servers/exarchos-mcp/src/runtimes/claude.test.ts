// ─── runtimes/claude.yaml supportedCapabilities tests ──────────────────────
//
// Asserts that `runtimes/claude.yaml` declares a `supportedCapabilities`
// YAML mapping (NOT a list) that mirrors `claudeAdapter.supportLevels`.
// This declaration is consumed by the prose renderer (Tasks 8/9) to gate
// `<!-- requires:* -->` and `<!-- requires:native:* -->` blocks.
//
// Implements: Task 7a of docs/plans/2026-04-25-delegation-runtime-parity.md.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { claudeAdapter } from '../agents/adapters/claude.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// `runtimes/claude.yaml` lives at the repo root, four levels up from this
// test file (servers/exarchos-mcp/src/runtimes/claude.test.ts).
const CLAUDE_YAML_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'runtimes',
  'claude.yaml',
);

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

describe('runtimes/claude.yaml supportedCapabilities', () => {
  it('ClaudeYaml_SupportedCapabilities_AllElevenAreNative', () => {
    const data = loadClaudeYaml();
    const supported = data.supportedCapabilities;

    // Must be a YAML mapping (object), not a list/array. The prose renderer
    // (Tasks 8/9) needs per-capability support-level strings to gate
    // `<!-- requires:* -->` vs `<!-- requires:native:* -->` blocks.
    expect(supported).toBeDefined();
    expect(supported).not.toBeNull();
    expect(Array.isArray(supported)).toBe(false);
    expect(typeof supported).toBe('object');

    const map = supported as Record<string, unknown>;

    for (const key of REQUIRED_CAPABILITY_KEYS) {
      expect(map, `missing capability key '${key}'`).toHaveProperty(key);
      expect(map[key], `capability '${key}' should be 'native'`).toBe('native');
    }

    // No additional keys beyond the canonical eleven.
    expect(Object.keys(map).sort()).toEqual([...REQUIRED_CAPABILITY_KEYS].sort());
  });

  it('ClaudeYaml_AdapterAlignment_MatchesSupportLevels', () => {
    const data = loadClaudeYaml();
    const supported = data.supportedCapabilities as Record<string, unknown>;

    for (const [cap, level] of Object.entries(claudeAdapter.supportLevels)) {
      if (level === 'unsupported') {
        // Unsupported capabilities are absent from the YAML by contract.
        continue;
      }
      expect(
        supported[cap],
        `claude.yaml.supportedCapabilities['${cap}'] should match adapter level '${level}'`,
      ).toBe(level);
    }
  });
});
