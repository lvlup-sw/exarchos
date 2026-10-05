/**
 * Presence test for `content/harness/runtimes/cursor.yaml`.
 * Cursor 2.5 has native sub-agents: Markdown files with YAML frontmatter at `.cursor/agents/<name>.md`, called through `Task`.
 * Thus `cursor.yaml` declares `hasSubagents: true`, and `SPAWN_AGENT_CALL` is a `Task({ ... })` call as for Claude.
 * `supportedCapabilities` must agree with `CursorAdapter.supportLevels` in `src/runtime/agents/adapters/cursor.ts`.
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import { loadRuntime } from '../../../../src/install/runtimes/load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '../../../../content/harness/runtimes');
const CURSOR_YAML = resolve(RUNTIMES_DIR, 'cursor.yaml');

/** Reads `cursor.yaml` as a raw object, without `RuntimeMapSchema` validation. */
function loadCursorYamlRaw(): Record<string, unknown> {
  const raw = readFileSync(CURSOR_YAML, 'utf8');
  const parsed = yamlLoad(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('cursor.yaml did not parse to an object');
  }
  return parsed as Record<string, unknown>;
}

describe('content/harness/runtimes/cursor.yaml presence', () => {
  it('CursorYaml_HasSubagents_True', () => {
    const runtime = loadRuntime(CURSOR_YAML);
    expect(runtime.capabilities.hasSubagents).toBe(true);
  });

  /** The spawn call is a `Task(` call, and it holds no phrase of the prose fallback for sequential work. */
  it('CursorYaml_SpawnAgentCall_UsesNativeTaskTool', () => {
    const runtime = loadRuntime(CURSOR_YAML);
    const spawn = runtime.placeholders.SPAWN_AGENT_CALL;

    expect(spawn).toMatch(/Task\(\s*\{|Task\(/);

    expect(spawn).not.toContain('no in-session subagent primitive');
    expect(spawn).not.toContain('sequentially');
    expect(spawn).not.toContain('sequential execution');
  });

  /** The Cursor adapter writes `.cursor/agents/<id>.md`. The spawn template takes that id through the `{{agent}}` placeholder. */
  it('CursorYaml_SpawnAgentCall_ReferencesGeneratedAgentName', async () => {
    const runtime = loadRuntime(CURSOR_YAML);
    const spawn = runtime.placeholders.SPAWN_AGENT_CALL;

    expect(spawn).toContain('{{agent}}');

    const { CursorAdapter } = await import(
      '../../../../src/runtime/agents/adapters/cursor.js'
    );
    const path = CursorAdapter.agentFilePath('implementer');
    const match = path.match(/([^/]+)\.md$/);
    expect(match).not.toBeNull();
    const agentName = match![1];
    expect(agentName).toBe('implementer');

    expect(spawn.replaceAll('{{agent}}', agentName)).toContain(agentName);
  });

  /** The YAML omits an unsupported capability, so no entry has the value `unsupported`. */
  it('CursorYaml_SupportedCapabilities_SixNativeTwoAdvisory', () => {
    const raw = loadCursorYamlRaw();
    const sc = raw.supportedCapabilities;
    expect(sc).toBeDefined();
    expect(typeof sc).toBe('object');
    expect(sc).not.toBeNull();
    expect(Array.isArray(sc)).toBe(false);

    const map = sc as Record<string, string>;
    const native = Object.entries(map).filter(([, v]) => v === 'native');
    const advisory = Object.entries(map).filter(([, v]) => v === 'advisory');
    const unsupported = Object.entries(map).filter(([, v]) => v === 'unsupported');

    expect(native).toHaveLength(6);
    expect(advisory).toHaveLength(2);
    expect(unsupported).toHaveLength(0);

    const nativeKeys = native.map(([k]) => k).sort();
    expect(nativeKeys).toEqual(
      [
        'fs:read',
        'fs:write',
        'mcp:exarchos',
        'mcp:exarchos:readonly',
        'shell:exec',
        'subagent:spawn',
      ].sort(),
    );

    const advisoryKeys = advisory.map(([k]) => k).sort();
    expect(advisoryKeys).toEqual(['isolation:worktree', 'session:resume'].sort());
  });

  /**
   * The check runs in both directions. Each YAML entry agrees with the adapter.
   * Each native or advisory capability of the adapter is in the YAML, and each unsupported one is absent.
   */
  it('CursorYaml_AdapterAlignment_MatchesSupportLevels', async () => {
    const raw = loadCursorYamlRaw();
    const yamlMap = raw.supportedCapabilities as Record<string, string>;

    const { CursorAdapter } = await import(
      '../../../../src/runtime/agents/adapters/cursor.js'
    );
    const adapterLevels = CursorAdapter.supportLevels;

    for (const [cap, level] of Object.entries(yamlMap)) {
      expect(adapterLevels[cap as keyof typeof adapterLevels]).toBe(level);
    }

    for (const [cap, level] of Object.entries(adapterLevels)) {
      if (level === 'unsupported') {
        expect(yamlMap[cap]).toBeUndefined();
      } else {
        expect(yamlMap[cap]).toBe(level);
      }
    }
  });
});
