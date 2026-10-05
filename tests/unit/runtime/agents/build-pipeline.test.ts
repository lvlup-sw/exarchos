/**
 * Build-pipeline contract tests for the per-runtime agent generator.
 * The root `package.json` must define `generate:agents`, and that script must run `src/runtime/agents/generate-agents.ts`.
 * `build:skills` must run `generate:agents`, so each standard build regenerates the agent files.
 * The last test spawns the generator as a subprocess in a temp directory.
 * It covers the entry-point check of the script, the file writes and the exit code.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** The repo root, four directories up from this test file. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const GENERATOR_PATH = path.join(
  REPO_ROOT,
  'src',
  'runtime',
  'agents',
  'generate-agents.ts',
);

/**
 * Expected output paths, relative to the output root: four specs for each of five runtimes.
 * `rendered/agents/` is the Claude tree, and `.github/agents/` is the Copilot tree.
 */
const EXPECTED_FILES: readonly string[] = [
  'rendered/agents/implementer.md',
  'rendered/agents/fixer.md',
  'rendered/agents/reviewer.md',
  'rendered/agents/scaffolder.md',
  '.codex/agents/implementer.toml',
  '.codex/agents/fixer.toml',
  '.codex/agents/reviewer.toml',
  '.codex/agents/scaffolder.toml',
  '.opencode/agents/implementer.md',
  '.opencode/agents/fixer.md',
  '.opencode/agents/reviewer.md',
  '.opencode/agents/scaffolder.md',
  '.cursor/agents/implementer.md',
  '.cursor/agents/fixer.md',
  '.cursor/agents/reviewer.md',
  '.cursor/agents/scaffolder.md',
  '.github/agents/implementer.agent.md',
  '.github/agents/fixer.agent.md',
  '.github/agents/reviewer.agent.md',
  '.github/agents/scaffolder.agent.md',
];

interface ScriptsBlock {
  readonly [name: string]: string;
}

function readRootScripts(): ScriptsBlock {
  const raw = fs.readFileSync(ROOT_PACKAGE_JSON, 'utf-8');
  const parsed = JSON.parse(raw) as { scripts?: ScriptsBlock };
  if (!parsed.scripts || typeof parsed.scripts !== 'object') {
    throw new Error(
      `root package.json at ${ROOT_PACKAGE_JSON} has no scripts block`,
    );
  }
  return parsed.scripts;
}

describe('build pipeline wiring (Task 6)', () => {
  describe('BuildPipeline_PackageJson_DefinesGenerateAgentsScript', () => {
    /** The test accepts any runner, because it matches only the path of the generator file. */
    it('root package.json defines `generate:agents` invoking the unified composition root', () => {
      const scripts = readRootScripts();
      const generateAgents = scripts['generate:agents'];
      expect(
        generateAgents,
        'root package.json must define `scripts["generate:agents"]`',
      ).toBeDefined();
      expect(
        generateAgents,
        '`generate:agents` must invoke src/runtime/agents/generate-agents.ts',
      ).toMatch(
        /src\/runtime\/agents\/generate-agents\.ts/,
      );
    });
  });

  describe('BuildPipeline_BuildSkills_DependsOnGenerateAgents', () => {
    /** The test accepts a chained `generate:agents` call, an `npm-run-all` composition, or a `prebuild:skills` hook. */
    it('root `build:skills` script chains/composes `generate:agents`', () => {
      const scripts = readRootScripts();
      const buildSkills = scripts['build:skills'];
      expect(
        buildSkills,
        'root package.json must define `scripts["build:skills"]`',
      ).toBeDefined();
      const directlyChained =
        buildSkills !== undefined &&
        /(npm|pnpm|yarn|bun)\s+(?:run\s+)?generate:agents/.test(buildSkills);
      const composedViaRunAll =
        buildSkills !== undefined &&
        /run-[ps]\b.*generate:agents/.test(buildSkills);
      const hasPreHook =
        typeof scripts['prebuild:skills'] === 'string' &&
        /generate:agents/.test(scripts['prebuild:skills']);
      expect(
        directlyChained || composedViaRunAll || hasPreHook,
        '`build:skills` must run `generate:agents` first (chained, run-all, or pre-hook)',
      ).toBe(true);
    });
  });

  describe('BuildPipeline_GenerateAgentsScript_RunsWithoutError', () => {
    let sandbox: string;

    /** The generator throws when `.claude-plugin/plugin.json` is missing, so the sandbox gets a minimal manifest. */
    beforeAll(() => {
      sandbox = fs.mkdtempSync(
        path.join(os.tmpdir(), 'exarchos-build-pipeline-'),
      );
      fs.mkdirSync(path.join(sandbox, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(sandbox, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'exarchos', agents: [] }, null, 2) + '\n',
        'utf-8',
      );
    });

    afterAll(() => {
      if (sandbox && fs.existsSync(sandbox)) {
        rmrf(sandbox);
      }
    });

    /**
     * The test resolves the `tsx` loader with `createRequire` from this file, so it finds `tsx` in the `node_modules` that runs the test.
     * Each expected file must exist and must not be empty.
     */
    it('spawning the generator writes all 20 expected files and exits 0', async () => {
      const requireFromTest = createRequire(import.meta.url);
      const tsxPackageJson = requireFromTest.resolve('tsx/package.json');
      const tsxEntry = path.join(path.dirname(tsxPackageJson), 'dist', 'loader.mjs');
      const result = await spawnAsync(
        process.execPath,
        ['--import', `file://${tsxEntry}`, GENERATOR_PATH],
        {
          cwd: sandbox,
          env: {
            ...process.env,
            EXARCHOS_OUTPUT_ROOT: sandbox,
          },
          timeout: 30_000,
        },
      );
      expect(
        result.status,
        `generator failed (exit ${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      for (const rel of EXPECTED_FILES) {
        const absPath = path.join(sandbox, rel);
        expect(
          fs.existsSync(absPath),
          `expected ${rel} to exist after generation`,
        ).toBe(true);
      }
      for (const rel of EXPECTED_FILES) {
        const stat = fs.statSync(path.join(sandbox, rel));
        expect(stat.size, `${rel} should be non-empty`).toBeGreaterThan(0);
      }
    });
  });
});
