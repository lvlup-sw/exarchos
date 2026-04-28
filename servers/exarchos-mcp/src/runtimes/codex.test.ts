// ─── codex.yaml supportedCapabilities contract tests (Task 7b) ─────────────
//
// Asserts that `runtimes/codex.yaml` declares a `supportedCapabilities` map
// that mirrors the `codexAdapter.supportLevels` three-state classification
// from Task 4f. The YAML map is the user-facing surface that downstream
// consumers (skill renderer, capability-matrix README generator, install
// validation) read — it MUST stay in lockstep with the adapter that
// actually emits agent definition files.
//
// Codex's classification (see docs/research/2026-04-25-delegation-platform-
// agnosticity.md §3 and docs/designs/2026-04-25-delegation-runtime-parity.md
// §4):
//
//   native (5):
//     - fs:read, fs:write, shell:exec, subagent:spawn, mcp:exarchos
//   advisory (2):
//     - isolation:worktree, session:resume
//   unsupported (3, omitted from the YAML map):
//     - subagent:completion-signal, subagent:start-signal, team:agent-teams
//
// The YAML map only enumerates `native` and `advisory` capabilities;
// `unsupported` capabilities are deliberately absent so consumers can
// detect them by absence instead of by an explicit "unsupported" sentinel.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { codexAdapter } from '../agents/adapters/codex.js';
import { Capability } from '../agents/capabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// servers/exarchos-mcp/src/runtimes → repo root is four parents up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const CODEX_YAML_PATH = resolve(REPO_ROOT, 'runtimes', 'codex.yaml');

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

describe('runtimes/codex.yaml supportedCapabilities (Task 7b)', () => {
  it('CodexYaml_SupportedCapabilities_FiveNativeTwoAdvisory', () => {
    const yaml = loadCodexYaml();

    expect(yaml.supportedCapabilities).toBeDefined();
    const map = yaml.supportedCapabilities ?? {};

    // Native (5): the runtime has a first-class primitive for each.
    expect(map['fs:read']).toBe('native');
    expect(map['fs:write']).toBe('native');
    expect(map['shell:exec']).toBe('native');
    expect(map['subagent:spawn']).toBe('native');
    expect(map['mcp:exarchos']).toBe('native');

    // Advisory (2): the spec may declare these but Codex has no primitive
    // to enforce them — orchestrator-managed.
    expect(map['isolation:worktree']).toBe('advisory');
    expect(map['session:resume']).toBe('advisory');

    // Exactly 7 keys total (5 native + 2 advisory).
    expect(Object.keys(map)).toHaveLength(7);
  });

  it('CodexYaml_SupportedCapabilities_ExcludesClaudeOnlyCapabilities', () => {
    const yaml = loadCodexYaml();
    const map = yaml.supportedCapabilities ?? {};

    // Unsupported capabilities are omitted — consumers detect by absence.
    expect(map['subagent:completion-signal']).toBeUndefined();
    expect(map['subagent:start-signal']).toBeUndefined();
    expect(map['team:agent-teams']).toBeUndefined();
  });

  it('CodexYaml_AdapterAlignment_MatchesSupportLevels', () => {
    const yaml = loadCodexYaml();
    const map = yaml.supportedCapabilities ?? {};

    // For every capability in the canonical vocabulary, the YAML and the
    // adapter must agree. `unsupported` collapses to "not present in the
    // YAML map" — that is the contract.
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
