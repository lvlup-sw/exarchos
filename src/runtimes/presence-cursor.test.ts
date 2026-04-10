/**
 * Presence test for `runtimes/cursor.yaml`.
 *
 * Cursor CLI has no in-session subagent primitive — delegation degrades
 * to a sequential-execution fallback with a visible warning so operators
 * know they are not getting parallelism.
 *
 * Implements: DR-4, DR-5 (cursor), DR-6, OQ-4
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './load.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUNTIMES_DIR = resolve(__dirname, '..', '..', 'runtimes');
const CURSOR_YAML = resolve(RUNTIMES_DIR, 'cursor.yaml');

describe('runtimes/cursor.yaml presence', () => {
  it('LoadAllRuntimes_CursorYamlPresent_HasNoSubagents', () => {
    const runtime = loadRuntime(CURSOR_YAML);

    expect(runtime.name).toBe('cursor');
    expect(runtime.capabilities.hasSubagents).toBe(false);
  });

  it('CursorYaml_SpawnAgentCall_UsesSequentialFallback', () => {
    const runtime = loadRuntime(CURSOR_YAML);
    expect(runtime.placeholders.SPAWN_AGENT_CALL).toContain('sequentially');
  });

  it('CursorYaml_SpawnAgentCall_ContainsWarningNote', () => {
    const runtime = loadRuntime(CURSOR_YAML);
    expect(runtime.placeholders.SPAWN_AGENT_CALL).toContain('Cursor');
  });
});
