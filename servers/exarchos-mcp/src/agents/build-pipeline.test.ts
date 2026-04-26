// ─── Build pipeline wiring contract tests ──────────────────────────────────
//
// These tests pin the build-pipeline contract for the unified per-runtime
// agent generator (Task 6 of the delegation-runtime-parity plan):
//
//   1. The root `package.json` exposes `npm run generate:agents` which
//      invokes `servers/exarchos-mcp/src/agents/generate-agents.ts` (the
//      composition root introduced in Task 5).
//   2. `npm run build:skills` depends on `generate:agents` so the
//      regeneration runs as part of the standard build pipeline. This is
//      the gate that lets Task 13 enforce drift-free in CI.
//   3. The generator script can be invoked end-to-end (it has a CLI shim
//      that resolves `outputRoot` from the cwd / argv) and writes the
//      expected per-runtime files for all 4 specs × 5 runtimes = 20.
//
// The third test is an integration test: it spawns the script as a real
// subprocess against an `os.tmpdir()` sandbox so the assertion covers
// `import.meta.url`-equals-script gating, real fs writes, and process
// exit code. We seed the sandbox with a minimal `.claude-plugin/plugin.json`
// because the composition root refuses to run without one.
//
// See docs/plans/2026-04-25-delegation-runtime-parity.md Task 6 and
// docs/designs/2026-04-25-delegation-runtime-parity.md §5.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ─── Locate repo root ──────────────────────────────────────────────────────
//
// This test file lives at:
//   <repoRoot>/servers/exarchos-mcp/src/agents/build-pipeline.test.ts
// so the repo root is four directories up from this file.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const GENERATOR_PATH = path.join(
  REPO_ROOT,
  'servers',
  'exarchos-mcp',
  'src',
  'agents',
  'generate-agents.ts',
);

// Expected output paths (relative to outputRoot). 4 specs × 5 runtimes.
const EXPECTED_FILES: readonly string[] = [
  // Claude
  'agents/implementer.md',
  'agents/fixer.md',
  'agents/reviewer.md',
  'agents/scaffolder.md',
  // Codex
  '.codex/agents/implementer.toml',
  '.codex/agents/fixer.toml',
  '.codex/agents/reviewer.toml',
  '.codex/agents/scaffolder.toml',
  // OpenCode
  '.opencode/agents/implementer.md',
  '.opencode/agents/fixer.md',
  '.opencode/agents/reviewer.md',
  '.opencode/agents/scaffolder.md',
  // Cursor
  '.cursor/agents/implementer.md',
  '.cursor/agents/fixer.md',
  '.cursor/agents/reviewer.md',
  '.cursor/agents/scaffolder.md',
  // Copilot
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
    it('root package.json defines `generate:agents` invoking the unified composition root', () => {
      const scripts = readRootScripts();
      const generateAgents = scripts['generate:agents'];
      expect(
        generateAgents,
        'root package.json must define `scripts["generate:agents"]`',
      ).toBeDefined();
      // The script body must invoke the unified composition root at
      // `servers/exarchos-mcp/src/agents/generate-agents.ts`. We accept
      // any reasonable runner (`tsx`, `node --import tsx`, `bun run`,
      // etc.) so long as the target file is referenced.
      expect(
        generateAgents,
        '`generate:agents` must invoke servers/exarchos-mcp/src/agents/generate-agents.ts',
      ).toMatch(
        /servers\/exarchos-mcp\/src\/agents\/generate-agents\.ts/,
      );
    });
  });

  describe('BuildPipeline_BuildSkills_DependsOnGenerateAgents', () => {
    it('root `build:skills` script chains/composes `generate:agents`', () => {
      const scripts = readRootScripts();
      const buildSkills = scripts['build:skills'];
      expect(
        buildSkills,
        'root package.json must define `scripts["build:skills"]`',
      ).toBeDefined();
      // Accept either explicit chaining (`npm run generate:agents && ...`),
      // composition via `npm-run-all`, or a `prebuild:skills` hook script.
      const directlyChained =
        buildSkills !== undefined &&
        /(npm|pnpm|yarn|bun)\s+run\s+generate:agents/.test(buildSkills);
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

    beforeAll(() => {
      sandbox = fs.mkdtempSync(
        path.join(os.tmpdir(), 'exarchos-build-pipeline-'),
      );
      // Composition root requires a plugin.json to exist before it
      // updates the `agents` field. Seed a minimal manifest.
      fs.mkdirSync(path.join(sandbox, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(sandbox, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'exarchos', agents: [] }, null, 2) + '\n',
        'utf-8',
      );
    });

    afterAll(() => {
      if (sandbox && fs.existsSync(sandbox)) {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('spawning the generator writes all 20 expected files and exits 0', () => {
      // Resolve `tsx`'s loader entry via Node's standard module
      // resolution from this test file's location. CI installs deps
      // only inside `servers/exarchos-mcp/`, so a hardcoded
      // `<REPO_ROOT>/node_modules/tsx/...` path misses on the runner
      // when the root-level install did not run. Resolving via
      // `createRequire(import.meta.url)` finds tsx in whichever
      // node_modules the test is actually being executed from.
      const requireFromTest = createRequire(import.meta.url);
      const tsxPackageJson = requireFromTest.resolve('tsx/package.json');
      const tsxEntry = path.join(path.dirname(tsxPackageJson), 'dist', 'loader.mjs');
      const result = spawnSync(
        process.execPath,
        ['--import', `file://${tsxEntry}`, GENERATOR_PATH],
        {
          cwd: sandbox,
          env: {
            ...process.env,
            EXARCHOS_OUTPUT_ROOT: sandbox,
          },
          encoding: 'utf-8',
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
      // Spot-check: at least one of every runtime's files is non-empty.
      for (const rel of EXPECTED_FILES) {
        const stat = fs.statSync(path.join(sandbox, rel));
        expect(stat.size, `${rel} should be non-empty`).toBeGreaterThan(0);
      }
    });
  });
});
