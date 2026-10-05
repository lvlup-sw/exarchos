// `generateAgents` is the composition root for agent generation. It validates each spec and runtime
// pair, lowers each `AgentSpec` through each `RuntimeAdapter`, and writes the agent files of Claude,
// Codex, OpenCode, Cursor and Copilot.
//
// The tests pin these contracts. Validation reports every failure at once. A second run writes the
// same files. Only the Claude agents go into `plugin.json`. A failed manifest write rolls back the
// files that the run created.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import matter from 'gray-matter';
import { parse as parseToml } from '@iarna/toml';

/**
 * A partial mock of `writePluginManifest`. The mock factory gives it the real implementation, and
 * the rollback tests install an implementation that throws.
 */
const writePluginManifestMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/runtime/agents/plugin-manifest.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/runtime/agents/plugin-manifest.js')>();
  writePluginManifestMock.mockImplementation(actual.writePluginManifest);
  return {
    ...actual,
    writePluginManifest: writePluginManifestMock,
  };
});

import {
  generateAgents,
  GenerateAgentsError,
} from '../../../../src/runtime/agents/generate-agents.js';
import {
  IMPLEMENTER,
  FIXER,
  REVIEWER,
  SCAFFOLDER,
  WORKTREE_BOUNDARY_COMMAND,
} from '../../../../src/runtime/agents/definitions.js';
import type { AgentSpec } from '../../../../src/runtime/agents/types.js';
import { claudeAdapter } from '../../../../src/runtime/agents/adapters/claude.js';
import { codexAdapter } from '../../../../src/runtime/agents/adapters/codex.js';
import { OpenCodeAdapter } from '../../../../src/runtime/agents/adapters/opencode.js';
import { CursorAdapter } from '../../../../src/runtime/agents/adapters/cursor.js';
import { CopilotAdapter } from '../../../../src/runtime/agents/adapters/copilot.js';
import { RUNTIMES } from '../../../../src/runtime/agents/adapters/types.js';
import type { RuntimeAdapter, Runtime } from '../../../../src/runtime/agents/adapters/types.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

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
      expect(fs.readFileSync(filePath, 'utf-8').length).toBeGreaterThan(0);
    }
  });

  /**
   * The generator writes `lowerSpec(spec).contents` byte for byte, with no substitution at
   * generation time. The test reads only the Claude implementer file.
   */
  it('GenerateAgents_OutputContent_MatchesAdapterLowerSpec', () => {
    generateAgents({
      outputRoot: tmp,
      specs: CANONICAL_SPECS,
      adapters: ALL_ADAPTERS,
      pluginJsonPath,
    });

    const expectedContents = claudeAdapter.lowerSpec(IMPLEMENTER).contents;
    const written = fs.readFileSync(
      path.join(tmp, claudeAdapter.agentFilePath(IMPLEMENTER.id)),
      'utf-8',
    );
    expect(written).toBe(expectedContents);
  });

  /**
   * `team:agent-teams` is native on Claude and unsupported on the other four tier-1 runtimes. The
   * spy makes the resolver return it, so four adapters reject the spec. The error must carry all
   * four failures, because a generator that stops at the first failure hides the others. The
   * `finally` block restores the spy.
   */
  it('GenerateAgents_UnsupportedCapability_ProducesAggregatedBuildError', async () => {
    const synthetic: AgentSpec = {
      ...IMPLEMENTER,
      id: 'implementer',
    };
    const PostureMapping = await import('../../../../src/workflow/capabilities/posture-mapping.js');
    const spy = vi.spyOn(PostureMapping, 'resolveCapabilities').mockReturnValue(
      Object.freeze(
        new Set<import('../../../../src/runtime/agents/capabilities.js').Capability>([
          'fs:read',
          'fs:write',
          'shell:exec',
          'mcp:exarchos',
          'isolation:worktree',
          'session:resume',
          'team:agent-teams',
        ]),
      ),
    );

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
    } finally {
      spy.mockRestore();
    }

    expect(caught).toBeInstanceOf(GenerateAgentsError);
    if (!(caught instanceof GenerateAgentsError)) return;

    const failingRuntimes = ['codex', 'opencode', 'cursor', 'copilot'];
    for (const runtime of failingRuntimes) {
      expect(caught.message).toContain(runtime);
    }
    expect(caught.message).toContain('team:agent-teams');
    expect(caught.message).toContain('implementer');

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

  /**
   * With no adapter, the generator must throw and not finish with zero files. The message must name
   * a missing tier-1 runtime.
   */
  it('GenerateAgents_MissingAdapter_ThrowsBuildError', () => {
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

    expect(caught.message).toMatch(/claude|codex|opencode|cursor|copilot/);
  });

  /**
   * A second run into the same directory must give byte-identical files. This catches an iteration
   * order that is not deterministic.
   */
  it('GenerateAgents_Idempotency_RunningTwiceProducesSameOutput', () => {
    generateAgents({
      outputRoot: tmp,
      specs: CANONICAL_SPECS,
      adapters: ALL_ADAPTERS,
      pluginJsonPath,
    });

    const firstPass = new Map<string, string>();
    for (const adapter of ALL_ADAPTERS) {
      for (const spec of CANONICAL_SPECS) {
        const filePath = path.join(tmp, adapter.agentFilePath(spec.id));
        firstPass.set(filePath, fs.readFileSync(filePath, 'utf-8'));
      }
    }

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

  /** Only Claude has a plugin manifest, so `agents` must hold no path of another runtime. */
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

    for (const spec of CANONICAL_SPECS) {
      const expected = `./rendered/agents/${spec.id}.md`;
      expect(agents).toContain(expected);
    }
    for (const entry of agents) {
      expect(entry).not.toMatch(/\.codex|\.opencode|\.cursor|\.github\/agents/);
    }
  });

  /**
   * The test writes `plugin.json` below the deep root, and that write creates the root. The
   * generator must then create the directory of each runtime below the root.
   */
  it('GenerateAgents_OutputDirectory_CreatedRecursively', () => {
    const deep = path.join(tmp, 'does', 'not', 'exist', 'yet');
    expect(fs.existsSync(deep)).toBe(false);

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

    for (const adapter of ALL_ADAPTERS) {
      for (const spec of CANONICAL_SPECS) {
        const filePath = path.join(deep, adapter.agentFilePath(spec.id));
        expect(fs.existsSync(filePath), `missing ${filePath}`).toBe(true);
      }
    }
  });

  /**
   * Pins the output of `claudeAdapter.lowerSpec` byte for byte to the snapshot fixtures in
   * `__fixtures__/snapshots/claude/`. Claude users depend on the exact rendered Markdown, so an
   * unintended change in `adapters/claude.ts` must fail here.
   */
  describe('Claude snapshot regression', () => {
    const SPEC_BY_ID: Record<string, AgentSpec> = {
      implementer: IMPLEMENTER,
      fixer: FIXER,
      reviewer: REVIEWER,
      scaffolder: SCAFFOLDER,
    };

    it.each(['implementer', 'fixer', 'reviewer', 'scaffolder'])(
      'GenerateAgents_ClaudeOutput_%s_MatchesSnapshot',
      (specId) => {
        const fixturePath = path.join(
          import.meta.dirname,
          '__fixtures__',
          'snapshots',
          'claude',
          `${specId}.md`,
        );
        const expected = fs.readFileSync(fixturePath, 'utf-8');
        const spec = SPEC_BY_ID[specId];
        const actual = claudeAdapter.lowerSpec(spec).contents;
        expect(actual).toBe(expected);
      },
    );
  });

  /**
   * The PreToolUse worktree-boundary hook exists only on Claude. The other four tier-1 runtimes
   * treat `isolation:worktree` as advisory and render no hooks, so they cannot enforce the boundary.
   * The test pins this known gap. It fails when another adapter renders the guard command, which is
   * the signal to wire the guard into that runtime.
   */
  describe('Worktree-boundary cross-runtime parity (#1301 / INV-4)', () => {
    it('GenerateAgents_WorktreeBoundaryHook_EnforcedOnClaudeOnly', () => {
      const claudeOut = claudeAdapter.lowerSpec(IMPLEMENTER).contents;
      expect(claudeOut).toContain(WORKTREE_BOUNDARY_COMMAND);

      for (const adapter of [codexAdapter, CursorAdapter, new CopilotAdapter(), OpenCodeAdapter]) {
        const out = adapter.lowerSpec(IMPLEMENTER).contents;
        expect(out, `${adapter.runtime} unexpectedly renders the boundary hook`).not.toContain(
          WORKTREE_BOUNDARY_COMMAND,
        );
      }
    });
  });

  /**
   * OpenCode has no primitive for an advisory capability such as `isolation:worktree` or
   * `session:resume`. The `tools` map of the frontmatter must not hold one. The prompt body can
   * still name it.
   */
  it('GenerateAgents_AdvisoryCapability_NotEmittedInTools', () => {
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

    const fmMatch = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fmMatch).not.toBeNull();
    const frontmatter = fmMatch ? fmMatch[1] : '';

    const toolsMatch = frontmatter.match(/tools:\s*\n([\s\S]*?)(?:\n[a-zA-Z]|$)/);
    const toolsBlock = toolsMatch ? toolsMatch[1] : '';
    expect(toolsBlock).not.toContain('isolation:worktree');
    expect(toolsBlock).not.toContain('session:resume');
  });
});

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

/**
 * Parses the output of `lowerSpec` for each runtime and spec pair and checks the fields that the
 * runtime reads. A typo in an adapter fails here, not when a user dispatches the agent.
 *
 * - Each pair: a non-empty path with an extension. Each Markdown runtime: a non-empty body.
 * - Claude and Cursor: YAML `name`, `description` and `model`. A Claude name is `exarchos-<id>`.
 * - OpenCode: YAML `mode` (`subagent`), `description`, and a `tools` map of booleans.
 * - Copilot: YAML `description` and a `tools` array of strings.
 * - Codex: top-level TOML `name` (the spec id), `description` and `developer_instructions`.
 */
describe('Per-runtime smoke validation', () => {
  for (const runtime of RUNTIMES) {
    for (const spec of SPECS) {
      it(`GenerateAgents_${runtime}_${spec}_WellFormed`, () => {
        const adapter = SMOKE_ADAPTERS[runtime];
        const agentSpec = SMOKE_SPECS[spec];
        const lowered = adapter.lowerSpec(agentSpec);

        expect(lowered.path.length).toBeGreaterThan(0);
        expect(path.extname(lowered.path).length).toBeGreaterThan(0);
        expect(lowered.contents.length).toBeGreaterThan(0);

        if (runtime === 'codex') {
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
          expect(parsed.name).toBe(agentSpec.id);
          return;
        }

        const { data, body } = parseFrontmatter(lowered.contents);

        expect(
          body.trim().length,
          `${runtime}/${spec} body must be non-empty`,
        ).toBeGreaterThan(0);

        expectNonEmptyString(
          data.description,
          `${runtime}/${spec} description`,
        );

        if (runtime === 'claude') {
          expectNonEmptyString(data.name, `claude/${spec} name`);
          expectNonEmptyString(data.model, `claude/${spec} model`);
          expect(data.name).toBe(`exarchos-${agentSpec.id}`);
        } else if (runtime === 'cursor') {
          expectNonEmptyString(data.name, `cursor/${spec} name`);
          expectNonEmptyString(data.model, `cursor/${spec} model`);
          expect(data.name).toBe(agentSpec.id);
        } else if (runtime === 'opencode') {
          expectNonEmptyString(data.mode, `opencode/${spec} mode`);
          expect(data.mode).toBe('subagent');
          expect(
            typeof data.tools === 'object' && data.tools !== null,
            `opencode/${spec} tools must be an object map`,
          ).toBe(true);
          for (const [tool, enabled] of Object.entries(
            data.tools as Record<string, unknown>,
          )) {
            expect(
              typeof enabled,
              `opencode/${spec} tools.${tool} must be boolean`,
            ).toBe('boolean');
          }
        } else if (runtime === 'copilot') {
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

/**
 * When `writePluginManifest` throws after the agent files are written, `generateAgents` must remove
 * each file that the run created. It must not remove a file that existed before the run.
 *
 * `mockReset` in `afterEach` leaves the mock with no implementation, so keep this suite last in the
 * file.
 */
describe('generateAgents — manifest write failure rollback', () => {
  let tmp: string;
  let pluginJsonPath: string;

  beforeEach(() => {
    tmp = makeTempDir();
    pluginJsonPath = makeTempPluginJson(tmp);
  });

  afterEach(() => {
    rmrf(tmp);
    writePluginManifestMock.mockReset();
  });

  /**
   * No agent file exists before the run, so the rollback must remove all of them. The call assertion
   * on the mock proves that the run reached the manifest write. The manifest existed before the run,
   * so it must stay. The last assertion only proves that the mocked module resolves.
   */
  it('GenerateAgents_RollsBackArtifacts_OnManifestWriteFailure', async () => {
    const pluginManifest = await import('../../../../src/runtime/agents/plugin-manifest.js');
    writePluginManifestMock.mockImplementation(() => {
      throw new Error('simulated manifest write failure');
    });

    const expectedArtifacts: string[] = [];
    for (const adapter of ALL_ADAPTERS) {
      for (const spec of CANONICAL_SPECS) {
        expectedArtifacts.push(
          path.join(tmp, adapter.agentFilePath(spec.id)),
        );
      }
    }

    for (const p of expectedArtifacts) {
      expect(fs.existsSync(p), `expected ${p} not to exist pre-run`).toBe(
        false,
      );
    }

    let caught: unknown;
    try {
      generateAgents({
        outputRoot: tmp,
        specs: CANONICAL_SPECS,
        adapters: ALL_ADAPTERS,
        pluginJsonPath,
      });
    } catch (err) {
      caught = err;
    }

    expect(writePluginManifestMock).toHaveBeenCalled();
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /simulated manifest write failure/,
    );

    for (const p of expectedArtifacts) {
      expect(
        fs.existsSync(p),
        `expected ${p} to be rolled back (unlinked) after manifest failure`,
      ).toBe(false);
    }

    expect(fs.existsSync(pluginJsonPath)).toBe(true);
    expect(typeof pluginManifest.writePluginManifest).toBe('function');
  });

  /**
   * The run overwrites the pre-existing file at an agent path before the manifest write fails, but
   * the rollback must not remove it. The rollback must also leave a file that is not an agent target.
   */
  it('GenerateAgents_PreservesPreExistingFiles_OnManifestWriteFailure', () => {
    writePluginManifestMock.mockImplementation(() => {
      throw new Error('simulated manifest write failure');
    });

    const preexistingPath = path.join(
      tmp,
      claudeAdapter.agentFilePath(IMPLEMENTER.id),
    );
    fs.mkdirSync(path.dirname(preexistingPath), { recursive: true });
    const sentinel = 'PRE-EXISTING-SENTINEL\n';
    fs.writeFileSync(preexistingPath, sentinel, 'utf-8');

    const bystander = path.join(
      path.dirname(preexistingPath),
      'bystander.md',
    );
    fs.writeFileSync(bystander, 'BYSTANDER\n', 'utf-8');

    let caught: unknown;
    try {
      generateAgents({
        outputRoot: tmp,
        specs: CANONICAL_SPECS,
        adapters: ALL_ADAPTERS,
        pluginJsonPath,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);

    expect(
      fs.existsSync(preexistingPath),
      'pre-existing artifact file must NOT be unlinked by rollback',
    ).toBe(true);

    expect(fs.existsSync(bystander)).toBe(true);
    expect(fs.readFileSync(bystander, 'utf-8')).toBe('BYSTANDER\n');
  });
});
