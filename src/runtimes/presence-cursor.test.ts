/**
 * Presence test for `runtimes/cursor.yaml`.
 *
 * Cursor 2.5 (early 2026) shipped native sub-agents: Markdown with YAML
 * frontmatter at `.cursor/agents/<name>.md`, invoked via the `Task` tool.
 * Exarchos targets that primitive directly — `cursor.yaml` declares
 * `hasSubagents: true` and renders `SPAWN_AGENT_CALL` as a native
 * Cursor `Task({ ... })` invocation, mirroring Claude's shape.
 *
 * `supportedCapabilities` mirrors `CursorAdapter.supportLevels` from
 * `servers/exarchos-mcp/src/agents/adapters/cursor.ts` so the YAML and
 * adapter can never drift on the capability classification.
 *
 * Implements: DR-4, DR-5 (cursor), DR-6, OQ-4
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import { loadRuntime } from './load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '..', '..', 'runtimes');
const CURSOR_YAML = resolve(RUNTIMES_DIR, 'cursor.yaml');

/**
 * Read `cursor.yaml` as a raw object so tests can assert on fields that
 * may not yet be modeled in `RuntimeMapSchema` (e.g. `supportedCapabilities`).
 */
function loadCursorYamlRaw(): Record<string, unknown> {
  const raw = readFileSync(CURSOR_YAML, 'utf8');
  const parsed = yamlLoad(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('cursor.yaml did not parse to an object');
  }
  return parsed as Record<string, unknown>;
}

describe('runtimes/cursor.yaml presence', () => {
  it('CursorYaml_HasSubagents_True', () => {
    const runtime = loadRuntime(CURSOR_YAML);
    // Cursor 2.5+ ships native sub-agents — the stale `false` claim must be gone.
    expect(runtime.capabilities.hasSubagents).toBe(true);
  });

  it('CursorYaml_SpawnAgentCall_UsesNativeTaskTool', () => {
    const runtime = loadRuntime(CURSOR_YAML);
    const spawn = runtime.placeholders.SPAWN_AGENT_CALL;

    // Native Cursor 2.5 Task-tool invocation, not the prose fallback.
    expect(spawn).toMatch(/Task\(\s*\{|Task\(/);

    // The prose-degradation marker phrases must be GONE.
    expect(spawn).not.toContain('no in-session subagent primitive');
    expect(spawn).not.toContain('sequentially');
    expect(spawn).not.toContain('sequential execution');
  });

  it('CursorYaml_SpawnAgentCall_ReferencesGeneratedAgentName', async () => {
    const runtime = loadRuntime(CURSOR_YAML);
    const spawn = runtime.placeholders.SPAWN_AGENT_CALL;

    // The Cursor adapter (Task 4d) writes `.cursor/agents/<id>.md` with
    // frontmatter `name: <id>`. The spawn template must accept that
    // generated name via the `{{agent}}` placeholder rendered at dispatch.
    expect(spawn).toContain('{{agent}}');

    const { CursorAdapter } = await import(
      '../../servers/exarchos-mcp/src/agents/adapters/cursor.js'
    );
    const path = CursorAdapter.agentFilePath('implementer');
    const match = path.match(/([^/]+)\.md$/);
    expect(match).not.toBeNull();
    const agentName = match![1];
    expect(agentName).toBe('implementer');

    // Renderer substitution: `{{agent}}` → adapter-generated name yields
    // a call that references the literal agent name.
    expect(spawn.replaceAll('{{agent}}', agentName)).toContain(agentName);
  });

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

    // Per discovery §3 + Task 4f + #1192 T09 readonly tier:
    // 6 native + 2 advisory + 0 unsupported (omitted).
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

  it('CursorYaml_AdapterAlignment_MatchesSupportLevels', async () => {
    const raw = loadCursorYamlRaw();
    const yamlMap = raw.supportedCapabilities as Record<string, string>;

    const { CursorAdapter } = await import(
      '../../servers/exarchos-mcp/src/agents/adapters/cursor.js'
    );
    const adapterLevels = CursorAdapter.supportLevels;

    // Every entry in the YAML must match the adapter's classification.
    for (const [cap, level] of Object.entries(yamlMap)) {
      expect(adapterLevels[cap as keyof typeof adapterLevels]).toBe(level);
    }

    // Every native/advisory adapter capability must be present in the YAML;
    // unsupported capabilities are intentionally omitted.
    for (const [cap, level] of Object.entries(adapterLevels)) {
      if (level === 'unsupported') {
        expect(yamlMap[cap]).toBeUndefined();
      } else {
        expect(yamlMap[cap]).toBe(level);
      }
    }
  });
});
