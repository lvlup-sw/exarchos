// ─── runtimes/opencode.yaml supportedCapabilities + Task-call tests ─────────
//
// Two assertions:
//
//   1. `runtimes/opencode.yaml` declares a `supportedCapabilities` YAML
//      mapping (NOT a list) that mirrors `OpenCodeAdapter.supportLevels`.
//      OpenCode classifies five capabilities as `native`
//      (fs:read/fs:write/shell:exec/subagent:spawn/mcp:exarchos) and two
//      as `advisory` (isolation:worktree/session:resume). The three
//      Claude-only primitives (subagent completion/start signals,
//      team:agent-teams) are `unsupported` and MUST be absent from the
//      YAML — the prose renderer's contract is that the map only carries
//      `native`/`advisory`, and `unsupported` capabilities are omitted.
//
//   2. The `SPAWN_AGENT_CALL` placeholder references the bare on-disk
//      agent name that `OpenCodeAdapter.lowerSpec` actually writes
//      (`.opencode/agents/<id>.md`). The pre-Task-7c YAML pointed at
//      `subagent_type: "exarchos-implementer"`, but OpenCode has no
//      plugin-prefix namespace, so no file of that name exists on disk —
//      this is the broken-pointer issue called out in discovery §3.
//
// Implements: Task 7c of docs/plans/2026-04-25-delegation-runtime-parity.md.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yamlParse } from 'yaml';
import { OpenCodeAdapter } from '../agents/adapters/opencode.js';
import type { Capability } from '../agents/capabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// `runtimes/opencode.yaml` lives at the repo root, four levels up from this
// test file (servers/exarchos-mcp/src/runtimes/opencode.test.ts).
const OPENCODE_YAML_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'runtimes',
  'opencode.yaml',
);

/** OpenCode's expected support classification (mirrors OpenCodeAdapter). */
const EXPECTED_NATIVE = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'subagent:spawn',
  'mcp:exarchos',
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

describe('runtimes/opencode.yaml supportedCapabilities', () => {
  it('OpencodeYaml_SupportedCapabilities_FiveNativeTwoAdvisory', () => {
    const data = loadOpencodeYaml();
    const supported = data.supportedCapabilities;

    // Must be a YAML mapping (object), not a list/array. The prose renderer
    // (Tasks 8/9) needs per-capability support-level strings to gate
    // `<!-- requires:* -->` vs `<!-- requires:native:* -->` blocks.
    expect(supported).toBeDefined();
    expect(supported).not.toBeNull();
    expect(Array.isArray(supported)).toBe(false);
    expect(typeof supported).toBe('object');

    const map = supported as Record<string, unknown>;

    // Five native capabilities.
    for (const cap of EXPECTED_NATIVE) {
      expect(map, `missing native capability '${cap}'`).toHaveProperty(cap);
      expect(map[cap], `capability '${cap}' should be 'native'`).toBe('native');
    }

    // Two advisory capabilities.
    for (const cap of EXPECTED_ADVISORY) {
      expect(map, `missing advisory capability '${cap}'`).toHaveProperty(cap);
      expect(map[cap], `capability '${cap}' should be 'advisory'`).toBe(
        'advisory',
      );
    }

    // Unsupported Claude-only primitives must NOT appear.
    for (const cap of EXPECTED_UNSUPPORTED) {
      expect(
        map,
        `unsupported capability '${cap}' must be absent from YAML`,
      ).not.toHaveProperty(cap);
    }

    // No additional keys beyond the seven canonical entries.
    const expectedKeys = [...EXPECTED_NATIVE, ...EXPECTED_ADVISORY].sort();
    expect(Object.keys(map).sort()).toEqual(expectedKeys);
  });

  it('OpencodeYaml_AdapterAlignment_MatchesSupportLevels', () => {
    const data = loadOpencodeYaml();
    const supported = data.supportedCapabilities as Record<string, unknown>;

    // Every adapter classification must agree with the YAML — except
    // `unsupported`, which by contract is absent from the YAML.
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

    // And every YAML entry must correspond to a known capability the
    // adapter classifies as native or advisory — no orphan keys.
    for (const cap of Object.keys(supported)) {
      const level = OpenCodeAdapter.supportLevels[cap as Capability];
      expect(
        level,
        `opencode.yaml has key '${cap}' that the adapter does not classify`,
      ).toBeDefined();
      expect(level).not.toBe('unsupported');
    }
  });

  it('OpencodeYaml_SpawnAgentCall_ReferencesGeneratedAgentName', () => {
    const data = loadOpencodeYaml();
    const placeholders = data.placeholders as Record<string, string>;
    const spawnCall = placeholders.SPAWN_AGENT_CALL;

    expect(typeof spawnCall).toBe('string');

    // Resolve the bare on-disk agent name the OpenCode adapter writes
    // for the implementer spec. e.g. `.opencode/agents/implementer.md`
    // → `implementer`.
    const agentPath = OpenCodeAdapter.agentFilePath('implementer');
    const agentName = basename(agentPath, extname(agentPath));

    // SPAWN_AGENT_CALL must reference the generated agent name as the
    // `subagent_type` argument. Robust to formatting (single vs double
    // quotes, whitespace) but strict on the bare name token.
    const subagentTypePattern = new RegExp(
      `subagent_type\\s*:\\s*['"]${agentName}['"]`,
    );
    expect(spawnCall).toMatch(subagentTypePattern);

    // And it must NOT reference the legacy plugin-namespaced
    // `exarchos-implementer` name — that name has no file under
    // `.opencode/agents/` and is the broken-pointer issue Task 7c
    // explicitly fixes (discovery §3).
    expect(spawnCall).not.toMatch(
      /subagent_type\s*:\s*['"]exarchos-implementer['"]/,
    );
  });
});
