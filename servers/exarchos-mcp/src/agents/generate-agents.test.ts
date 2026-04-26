// ─── Unified composition-root contract tests ───────────────────────────────
//
// `generate-agents.ts` is the singular composition root that fans an
// `AgentSpec` out across every `RuntimeAdapter`, validates each
// (spec, runtime) pair, and writes the per-runtime agent definition
// files (Claude, Codex, OpenCode, Cursor, Copilot).
//
// These tests pin the operability contract: aggregated validation
// errors (DIM-2 observability), idempotent writes, deterministic
// iteration, and Claude-only plugin manifest registration.
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §5 and Task
// 5 in docs/plans/2026-04-25-delegation-runtime-parity.md.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import matter from 'gray-matter';
import { parse as parseToml } from '@iarna/toml';
import {
  generateAgents,
  GenerateAgentsError,
} from './generate-agents.js';
import {
  IMPLEMENTER,
  FIXER,
  REVIEWER,
  SCAFFOLDER,
} from './definitions.js';
import type { AgentSpec } from './types.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import { CursorAdapter } from './adapters/cursor.js';
import { CopilotAdapter } from './adapters/copilot.js';
import type { RuntimeAdapter, Runtime } from './adapters/types.js';

// ─── Test utilities ────────────────────────────────────────────────────────

const ALL_ADAPTERS: readonly RuntimeAdapter[] = [
  claudeAdapter,
  codexAdapter,
  OpenCodeAdapter,
  CursorAdapter,
  new CopilotAdapter(),
];

const CANONICAL_SPECS: readonly AgentSpec[] = [
  IMPLEMENTER,
  FIXER,
  REVIEWER,
  SCAFFOLDER,
];

function makeTempDir(): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const dir = path.join(os.tmpdir(), `exarchos-generate-agents-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTempPluginJson(dir: string): string {
  const pluginDir = path.join(dir, '.claude-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginJsonPath = path.join(pluginDir, 'plugin.json');
  fs.writeFileSync(
    pluginJsonPath,
    JSON.stringify(
      {
        name: 'exarchos',
        agents: [],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return pluginJsonPath;
}

function rmrf(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('generateAgents', () => {
  let tmp: string;
  let pluginJsonPath: string;

  beforeEach(() => {
    tmp = makeTempDir();
    pluginJsonPath = makeTempPluginJson(tmp);
  });

  afterEach(() => {
    rmrf(tmp);
  });

  it('GenerateAgents_AllRuntimesAllSpecs_ProducesTwentyFiles', () => {
    generateAgents({
      outputRoot: tmp,
      specs: CANONICAL_SPECS,
      adapters: ALL_ADAPTERS,
      pluginJsonPath,
    });

    // 5 runtimes × 4 specs = 20 files, each at the adapter-defined path.
    const expected: string[] = [];
    for (const adapter of ALL_ADAPTERS) {
      for (const spec of CANONICAL_SPECS) {
        expected.push(path.join(tmp, adapter.agentFilePath(spec.id)));
      }
    }
    expect(expected.length).toBe(20);

    for (const filePath of expected) {
      expect(fs.existsSync(filePath), `expected file at ${filePath}`).toBe(
        true,
      );
      // Each file must have non-empty contents.
      expect(fs.readFileSync(filePath, 'utf-8').length).toBeGreaterThan(0);
    }
  });

  it('GenerateAgents_OutputContent_MatchesAdapterLowerSpec', () => {
    generateAgents({
      outputRoot: tmp,
      specs: CANONICAL_SPECS,
      adapters: ALL_ADAPTERS,
      pluginJsonPath,
    });

    // Confirm generator is a thin orchestrator: output must equal the
    // adapter's `lowerSpec(spec).contents` byte-for-byte. Pick the
    // Claude/IMPLEMENTER pair as the canonical regression check.
    const expectedContents = claudeAdapter.lowerSpec(IMPLEMENTER).contents;
    const written = fs.readFileSync(
      path.join(tmp, claudeAdapter.agentFilePath(IMPLEMENTER.id)),
      'utf-8',
    );
    expect(written).toBe(expectedContents);
  });

  it('GenerateAgents_UnsupportedCapability_ProducesAggregatedBuildError', () => {
    // `team:agent-teams` is native on Claude but unsupported on every
    // other tier-1 runtime. Injecting a synthetic spec that declares it
    // exercises aggregation: a generator that fails on the first error
    // and hides the others is a DIM-2 observability violation.
    const synthetic: AgentSpec = {
      ...IMPLEMENTER,
      id: 'implementer', // keep id stable; IDs are a closed set
      capabilities: [...IMPLEMENTER.capabilities, 'team:agent-teams'],
    };

    let caught: unknown;
    try {
      generateAgents({
        outputRoot: tmp,
        specs: [synthetic],
        adapters: ALL_ADAPTERS,
        pluginJsonPath,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GenerateAgentsError);
    if (!(caught instanceof GenerateAgentsError)) return;

    // Every non-Claude runtime must appear in both the failures array
    // and the aggregated message.
    const failingRuntimes = ['codex', 'opencode', 'cursor', 'copilot'];
    for (const runtime of failingRuntimes) {
      expect(caught.message).toContain(runtime);
    }
    // The offending capability and spec id are named in the message.
    expect(caught.message).toContain('team:agent-teams');
    expect(caught.message).toContain('implementer');

    // Structured failures expose runtime + specId + capability + reason
    // + fixHint per offending runtime.
    expect(caught.failures.length).toBe(failingRuntimes.length);
    const failingByRuntime = new Map(
      caught.failures.map((f) => [f.runtime, f]),
    );
    for (const runtime of failingRuntimes) {
      const entry = failingByRuntime.get(runtime);
      expect(entry, `expected failure entry for ${runtime}`).toBeDefined();
      if (!entry) continue;
      expect(entry.specId).toBe('implementer');
      expect(entry.capability).toBe('team:agent-teams');
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.fixHint.length).toBeGreaterThan(0);
    }
  });

  it('GenerateAgents_MissingAdapter_ThrowsBuildError', () => {
    // Empty adapter registry. Generator must reject up-front; it cannot
    // silently emit zero files.
    let caught: unknown;
    try {
      generateAgents({
        outputRoot: tmp,
        specs: CANONICAL_SPECS,
        adapters: [],
        pluginJsonPath,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GenerateAgentsError);
    if (!(caught instanceof GenerateAgentsError)) return;

    // Message must name at least one missing tier-1 runtime by name so
    // operators can see what's missing.
    expect(caught.message).toMatch(/claude|codex|opencode|cursor|copilot/);
  });

  it('GenerateAgents_Idempotency_RunningTwiceProducesSameOutput', () => {
    generateAgents({
      outputRoot: tmp,
      specs: CANONICAL_SPECS,
      adapters: ALL_ADAPTERS,
      pluginJsonPath,
    });

    // Snapshot every file's contents.
    const firstPass = new Map<string, string>();
    for (const adapter of ALL_ADAPTERS) {
      for (const spec of CANONICAL_SPECS) {
        const filePath = path.join(tmp, adapter.agentFilePath(spec.id));
        firstPass.set(filePath, fs.readFileSync(filePath, 'utf-8'));
      }
    }

    // Run again into the same directory — must not error and must
    // produce byte-identical contents (catches accidental ordering
    // nondeterminism, e.g. Map iteration without sorted keys).
    expect(() =>
      generateAgents({
        outputRoot: tmp,
        specs: CANONICAL_SPECS,
        adapters: ALL_ADAPTERS,
        pluginJsonPath,
      }),
    ).not.toThrow();

    for (const [filePath, original] of firstPass) {
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
    }
  });

  it('GenerateAgents_PluginJsonUpdate_OnlyClaudeAgentsRegistered', () => {
    generateAgents({
      outputRoot: tmp,
      specs: CANONICAL_SPECS,
      adapters: ALL_ADAPTERS,
      pluginJsonPath,
    });

    const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
    const agents: string[] = manifest.agents;
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBe(CANONICAL_SPECS.length);

    // Other runtimes have no plugin.json equivalent — only Claude agents
    // are declared.
    for (const spec of CANONICAL_SPECS) {
      const expected = `./agents/${spec.id}.md`;
      expect(agents).toContain(expected);
    }
    for (const entry of agents) {
      // Nothing pointing at codex, opencode, cursor, or copilot paths.
      expect(entry).not.toMatch(/\.codex|\.opencode|\.cursor|\.github\/agents/);
    }
  });

  it('GenerateAgents_OutputDirectory_CreatedRecursively', () => {
    // Use a path whose parents do not exist; generator must `mkdir -p`
    // every per-runtime subtree before writing.
    const deep = path.join(tmp, 'does', 'not', 'exist', 'yet');
    expect(fs.existsSync(deep)).toBe(false);

    // Place plugin.json under the deep root too — the generator will
    // create the .claude-plugin/ parent on demand if asked.
    const deepPluginDir = path.join(deep, '.claude-plugin');
    fs.mkdirSync(deepPluginDir, { recursive: true });
    const deepPluginJson = path.join(deepPluginDir, 'plugin.json');
    fs.writeFileSync(
      deepPluginJson,
      JSON.stringify({ name: 'exarchos', agents: [] }, null, 2) + '\n',
      'utf-8',
    );

    generateAgents({
      outputRoot: deep,
      specs: CANONICAL_SPECS,
      adapters: ALL_ADAPTERS,
      pluginJsonPath: deepPluginJson,
    });

    // Every runtime path was created and a file written under it.
    for (const adapter of ALL_ADAPTERS) {
      for (const spec of CANONICAL_SPECS) {
        const filePath = path.join(deep, adapter.agentFilePath(spec.id));
        expect(fs.existsSync(filePath), `missing ${filePath}`).toBe(true);
      }
    }
  });

  it('GenerateAgents_AdvisoryCapability_NotEmittedInTools', () => {
    // Regression for the 4f integration: advisory capabilities (e.g.
    // `isolation:worktree`, `session:resume` on OpenCode) must NOT
    // surface in the rendered tool entries — the runtime has no
    // primitive to expose.
    generateAgents({
      outputRoot: tmp,
      specs: CANONICAL_SPECS,
      adapters: ALL_ADAPTERS,
      pluginJsonPath,
    });

    const opencodePath = path.join(
      tmp,
      OpenCodeAdapter.agentFilePath(IMPLEMENTER.id),
    );
    const contents = fs.readFileSync(opencodePath, 'utf-8');

    // OpenCode emits `tools` as a boolean map. Advisory capabilities
    // must not appear as keys/values in that map.
    const fmMatch = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fmMatch).not.toBeNull();
    const frontmatter = fmMatch ? fmMatch[1] : '';

    // The capability strings themselves should not surface as tool
    // entries (the runtime body may still mention them in the system
    // prompt, but the structured tool map must not include them).
    const toolsMatch = frontmatter.match(/tools:\s*\n([\s\S]*?)(?:\n[a-zA-Z]|$)/);
    const toolsBlock = toolsMatch ? toolsMatch[1] : '';
    expect(toolsBlock).not.toContain('isolation:worktree');
    expect(toolsBlock).not.toContain('session:resume');
  });
});

// ─── Per-runtime smoke validation ──────────────────────────────────────────
//
// Parse every (runtime × spec) artifact emitted by the adapter
// `lowerSpec` path and assert it is structurally well-formed for the
// runtime that consumes it: required frontmatter (or TOML) keys present,
// values of the expected type, and a non-empty body.
//
// Why this gate exists: a typo in any adapter would otherwise ship
// malformed YAML/TOML to a runtime and only be caught when a user tried
// to dispatch the agent. The smoke tests parse with `gray-matter` (for
// markdown-with-frontmatter runtimes) or `@iarna/toml` (for codex), so
// any structural breakage surfaces here at build time.
//
// Required-field expectations are derived by reading each adapter's
// `lowerSpec`:
//   • Claude (`agents/<id>.md`): YAML `name`, `description`, `model`;
//     non-empty body.
//   • OpenCode (`.opencode/agents/<id>.md`): YAML `mode` ('subagent'),
//     `description`, `tools` (object map); non-empty body.
//   • Cursor (`.cursor/agents/<id>.md`): YAML `name`, `description`,
//     `model`; non-empty body.
//   • Copilot (`.github/agents/<id>.agent.md`): YAML `description`,
//     `tools` (string array); non-empty body. Copilot's adapter omits
//     `name` because the file path encodes it.
//   • Codex (`.codex/agents/<id>.toml`): top-level (NOT under `[agent]`)
//     `name`, `description`, `developer_instructions`. Codex does not
//     emit `model` from `lowerSpec`.

const RUNTIMES = ['claude', 'codex', 'opencode', 'cursor', 'copilot'] as const;
const SPECS = ['implementer', 'fixer', 'reviewer', 'scaffolder'] as const;

const SMOKE_ADAPTERS: Record<Runtime, RuntimeAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: OpenCodeAdapter,
  cursor: CursorAdapter,
  copilot: new CopilotAdapter(),
};

const SMOKE_SPECS: Record<(typeof SPECS)[number], AgentSpec> = {
  implementer: IMPLEMENTER,
  fixer: FIXER,
  reviewer: REVIEWER,
  scaffolder: SCAFFOLDER,
};

interface FrontmatterCheck {
  data: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(contents: string): FrontmatterCheck {
  const parsed = matter(contents);
  return {
    data: parsed.data as Record<string, unknown>,
    body: parsed.content,
  };
}

function expectNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  expect(typeof value, `${label} must be a string`).toBe('string');
  expect(
    (value as string).trim().length,
    `${label} must be non-empty`,
  ).toBeGreaterThan(0);
}

describe('Per-runtime smoke validation', () => {
  for (const runtime of RUNTIMES) {
    for (const spec of SPECS) {
      it(`GenerateAgents_${runtime}_${spec}_WellFormed`, () => {
        const adapter = SMOKE_ADAPTERS[runtime];
        const agentSpec = SMOKE_SPECS[spec];
        const lowered = adapter.lowerSpec(agentSpec);

        // Path basics: every adapter must produce a non-empty path with
        // an extension. Catches "" or undefined slipping through.
        expect(lowered.path.length).toBeGreaterThan(0);
        expect(path.extname(lowered.path).length).toBeGreaterThan(0);
        expect(lowered.contents.length).toBeGreaterThan(0);

        if (runtime === 'codex') {
          // Codex emits TOML. Parse and assert the top-level keys
          // produced by `codex.ts` (no `[agent]` table; `model` is not
          // emitted by `lowerSpec`).
          let parsed: Record<string, unknown>;
          try {
            parsed = parseToml(lowered.contents) as Record<string, unknown>;
          } catch (err) {
            throw new Error(
              `codex/${spec} TOML failed to parse: ${(err as Error).message}`,
            );
          }
          expectNonEmptyString(parsed.name, `codex/${spec} name`);
          expectNonEmptyString(
            parsed.description,
            `codex/${spec} description`,
          );
          expectNonEmptyString(
            parsed.developer_instructions,
            `codex/${spec} developer_instructions`,
          );
          // The agent id is a closed set; the file's `name` must equal
          // the spec id so dispatch-by-name works.
          expect(parsed.name).toBe(agentSpec.id);
          return;
        }

        // All non-codex runtimes emit Markdown with YAML frontmatter.
        const { data, body } = parseFrontmatter(lowered.contents);

        // Body must carry the agent's instructions — empty body would
        // mean the runtime sees a system-prompt-less agent.
        expect(
          body.trim().length,
          `${runtime}/${spec} body must be non-empty`,
        ).toBeGreaterThan(0);

        // Common requirement across all four markdown runtimes.
        expectNonEmptyString(
          data.description,
          `${runtime}/${spec} description`,
        );

        if (runtime === 'claude') {
          expectNonEmptyString(data.name, `claude/${spec} name`);
          expectNonEmptyString(data.model, `claude/${spec} model`);
          // The Claude generator namespaces names as `exarchos-<id>`.
          expect(data.name).toBe(`exarchos-${agentSpec.id}`);
        } else if (runtime === 'cursor') {
          expectNonEmptyString(data.name, `cursor/${spec} name`);
          expectNonEmptyString(data.model, `cursor/${spec} model`);
          expect(data.name).toBe(agentSpec.id);
        } else if (runtime === 'opencode') {
          // OpenCode encodes the agent name in the file path; the
          // structured fields the runtime depends on are `mode`,
          // `description`, and the `tools` boolean map.
          expectNonEmptyString(data.mode, `opencode/${spec} mode`);
          expect(data.mode).toBe('subagent');
          expect(
            typeof data.tools === 'object' && data.tools !== null,
            `opencode/${spec} tools must be an object map`,
          ).toBe(true);
          // Every value in the tools map must be a boolean (OpenCode
          // contract — runtime ignores non-boolean entries silently,
          // which is exactly the kind of bug this gate catches).
          for (const [tool, enabled] of Object.entries(
            data.tools as Record<string, unknown>,
          )) {
            expect(
              typeof enabled,
              `opencode/${spec} tools.${tool} must be boolean`,
            ).toBe('boolean');
          }
        } else if (runtime === 'copilot') {
          // Copilot's adapter omits `name` (file path encodes it) but
          // requires `description` and a `tools` array. The runtime
          // rejects custom agents that lack either.
          expect(
            Array.isArray(data.tools),
            `copilot/${spec} tools must be an array`,
          ).toBe(true);
          for (const tool of data.tools as unknown[]) {
            expectNonEmptyString(tool, `copilot/${spec} tools entry`);
          }
        }
      });
    }
  }
});
