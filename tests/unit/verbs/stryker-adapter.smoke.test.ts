// Smoke tests for the Stryker mutation adapter `tools/audit/core/stryker-adapter.mjs`.
// The composed tests run the real adapter script and parse its output with `parseMutationReport`.
// Nothing mocks Stryker.
// - Runner present: a real run over a two-commit diff in an isolated fixture repo gives real mutant
//   counts. Without the `@stryker-mutator/core` devDependency, this test fails.
// - Binary absent: the adapter fails closed with a non-zero exit and nothing parseable on stdout.
// - Empty diff: `--since=HEAD` against this repo prints the empty report and exits 0.
// A provenance test checks that `resolveVerificationRuntime` resolves the `mutation` field to this
// adapter and not to the built-in `npx stryker run` fallback.

import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMutationReport } from '../../../src/verbs/gates/mutation-adequacy.js';
import { resolveVerificationRuntime } from '../../../src/config/test-runtime-resolver.js';
import {
  parseSinceArg,
  isMutatableServerSource,
  computeMutateGlobs,
  EMPTY_REPORT,
  MAX_MUTATE_FILES,
} from '../../../tools/audit/core/stryker-adapter.mjs';
import { execFileAsync, spawnAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

/** The package root, which is also the repository root. */
const REAL_SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPO_ROOT = REAL_SERVER_DIR;
const ADAPTER_SCRIPT = path.join(REAL_SERVER_DIR, 'tools', 'audit', 'core', 'stryker-adapter.mjs');

function runNode(
  args: readonly string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return spawnAsync(process.execPath, [ADAPTER_SCRIPT, ...args], { cwd });
}

describe('stryker-adapter pure helpers', () => {
  it('parseSinceArg extracts the value of a handler-appended --since=<base> flag', () => {
    expect(parseSinceArg(['--since=abc123'])).toBe('abc123');
    expect(parseSinceArg(['run', '--since=main', '--other'])).toBe('main');
    expect(parseSinceArg([])).toBeUndefined();
    expect(parseSinceArg(['--other=x'])).toBeUndefined();
  });

  /** A `src/` directory under another root is not the production `src/`. */
  it('isMutatableServerSource restricts to changed src/** production files', () => {
    expect(isMutatableServerSource('src/foo.ts')).toBe(true);
    expect(isMutatableServerSource('src/foo.test.ts')).toBe(false);
    expect(isMutatableServerSource('src/foo.d.ts')).toBe(false);
    expect(isMutatableServerSource('src/foo.type-test.ts')).toBe(false);
    expect(isMutatableServerSource('src/foo.bench.ts')).toBe(false);
    expect(isMutatableServerSource('tools/audit/core/other.ts')).toBe(false);
    expect(isMutatableServerSource('tools/conformance/src/foo.ts')).toBe(false);
    expect(isMutatableServerSource('servers/exarchos-mcp/README.md')).toBe(false);
  });

  /** Only `src/foo.ts` qualifies. The others are a test file, a deleted file, and a file outside `src/`. */
  it('computeMutateGlobs filters to still-existing, mutatable files and strips the server prefix', () => {
    const changed = [
      'src/foo.ts',
      'src/foo.test.ts',
      'src/deleted.ts',
      'docs/guides/toolchain-resolution.md',
    ];
    const exists = (f: string) => f !== 'src/deleted.ts';
    const { files, truncated, totalQualifying } = computeMutateGlobs(changed, exists);
    expect(files).toEqual(['src/foo.ts']);
    expect(truncated).toBe(false);
    expect(totalQualifying).toBe(1);
  });

  it('computeMutateGlobs caps at MAX_MUTATE_FILES (mutant-count bound) and reports truncation', () => {
    const changed = Array.from(
      { length: MAX_MUTATE_FILES + 5 },
      (_, i) => `src/f${String(i).padStart(3, '0')}.ts`,
    );
    const { files, truncated, totalQualifying } = computeMutateGlobs(changed, () => true);
    expect(files).toHaveLength(MAX_MUTATE_FILES);
    expect(truncated).toBe(true);
    expect(totalQualifying).toBe(MAX_MUTATE_FILES + 5);
  });

  it('EMPTY_REPORT is a valid, parseable Stryker report with zero mutants', () => {
    const parsed = parseMutationReport(JSON.stringify(EMPTY_REPORT));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.carrier).toEqual({ mutationScore: 0, killed: 0, survived: 0, noCoverage: 0, total: 0 });
    }
  });
});

describe('resolveVerificationRuntime mutation-field provenance (DR-7)', () => {
  it('resolves this repo\'s .exarchos.yml adapter entry, not the built-in npx fallback', () => {
    const runtime = resolveVerificationRuntime(REPO_ROOT);
    expect(runtime.mutation).toBe('node tools/audit/core/stryker-adapter.mjs');
    expect(runtime.mutation).not.toBe('npx stryker run');
  });

  /** The built-in node default is `npx stryker run`, and the injected config value must win over it. */
  it('config-tier mutation: beats the built-in node registry default generically', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mutation-provenance-'));
    try {
      writeFileSync(path.join(tmp, 'package.json'), '{"name":"fixture"}\n');
      const runtime = resolveVerificationRuntime(tmp, {
        loadConfig: () => ({
          config: { mutation: 'node tools/audit/core/stryker-adapter.mjs' },
          source: path.join(tmp, '.exarchos.yml'),
        }),
      });
      expect(runtime.mutation).toBe('node tools/audit/core/stryker-adapter.mjs');
    } finally {
      rmrf(tmp);
    }
  });
});

describe('stryker-adapter composed path — empty mutatable surface', () => {
  it('a genuinely empty diff (--since=HEAD) prints the empty-valid report and exits 0, never invoking Stryker', async () => {
    const result = await runNode(['--since=HEAD'], REPO_ROOT);
    expect(result.status).toBe(0);
    const parsed = parseMutationReport(result.stdout);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.carrier.total).toBe(0);
    }
  });
});

/**
 * Runs the adapter against an isolated temp root with no pinned binary. The test does not rename the
 * shared `node_modules/.bin/stryker`, because that races other test files and can corrupt `node_modules`.
 * The adapter checks for `node_modules/.bin/stryker` under `process.cwd()`. Without `--since` the
 * adapter starts Stryker at once, with no git diff.
 */
describe.skipIf(process.platform === 'win32')('stryker-adapter composed path — devDep absent', () => {
  it('fails CLOSED (non-zero exit, no parseable report) when the local pinned binary is missing', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'stryker-missing-bin-'));
    try {
      const result = await runNode([], tmpRoot);
      expect(result.status).not.toBe(0);
      expect(result.stdout.trim()).toBe('');
      const parsed = parseMutationReport(result.stdout);
      expect(parsed.ok).toBe(false);
    } finally {
      rmrf(tmpRoot);
    }
  });
});

/**
 * Builds an isolated fixture repo with its own git history and a minimal Stryker and Vitest config.
 * A symlink to `node_modules` lets the real pinned binary resolve without an install. The fixture runs
 * a copy of the real adapter script. The head commit adds a covered `double` function, so Stryker has
 * mutants to kill.
 */
describe.skipIf(process.platform === 'win32')('stryker-adapter composed path — runner present', () => {
  it('produces a parseable carrier with real mutant counts over a tiny 2-commit diff', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'stryker-adapter-smoke-'));
    try {
      const serverDir = path.join(tmpRoot);
      mkdirSync(path.join(serverDir, 'src', 'fixture'), { recursive: true });
      mkdirSync(path.join(serverDir, 'scripts'), { recursive: true });
      symlinkSync(path.join(REAL_SERVER_DIR, 'node_modules'), path.join(serverDir, 'node_modules'), 'dir');

      writeFileSync(
        path.join(serverDir, 'vitest.config.mjs'),
        "export default { test: { include: ['src/fixture/**/*.test.ts'], globals: false, environment: 'node' } };\n",
      );
      writeFileSync(
        path.join(serverDir, 'stryker.conf.mjs'),
        [
          'export default {',
          "  packageManager: 'npm',",
          "  testRunner: 'vitest',",
          "  reporters: ['json'],",
          "  jsonReporter: { fileName: 'reports/mutation/mutation.json' },",
          "  mutate: ['src/fixture/add.ts'],",
          '  concurrency: 2,',
          '  timeoutMS: 10000,',
          "  vitest: { configFile: 'vitest.config.mjs' },",
          '};',
          '',
        ].join('\n'),
      );
      writeFileSync(
        path.join(serverDir, 'src', 'fixture', 'add.ts'),
        'export function add(a, b) {\n  return a + b;\n}\n',
      );
      writeFileSync(
        path.join(serverDir, 'src', 'fixture', 'add.test.ts'),
        [
          "import { describe, it, expect } from 'vitest';",
          "import { add } from './add.js';",
          "describe('add', () => {",
          "  it('adds two numbers', () => {",
          '    expect(add(2, 3)).toBe(5);',
          '  });',
          '});',
          '',
        ].join('\n'),
      );
      copyFileSync(ADAPTER_SCRIPT, path.join(serverDir, 'scripts', 'stryker-adapter.mjs'));

      const git = (args: readonly string[]): Promise<string> =>
        execFileAsync('git', args, { cwd: tmpRoot });
      await git(['init', '-q']);
      await git(['config', 'user.email', 'smoke@example.com']);
      await git(['config', 'user.name', 'smoke']);
      await git(['add', '-A']);
      await git(['commit', '-q', '-m', 'base', '--no-verify']);
      const baseSha = (await git(['rev-parse', 'HEAD'])).trim();

      writeFileSync(
        path.join(serverDir, 'src', 'fixture', 'add.ts'),
        'export function add(a, b) {\n  return a + b;\n}\nexport function double(x) {\n  return x * 2;\n}\n',
      );
      writeFileSync(
        path.join(serverDir, 'src', 'fixture', 'add.test.ts'),
        [
          "import { describe, it, expect } from 'vitest';",
          "import { add, double } from './add.js';",
          "describe('add', () => {",
          "  it('adds two numbers', () => {",
          '    expect(add(2, 3)).toBe(5);',
          '  });',
          "  it('doubles a number', () => {",
          '    expect(double(4)).toBe(8);',
          '  });',
          '});',
          '',
        ].join('\n'),
      );
      await git(['add', '-A']);
      await git(['commit', '-q', '-m', 'head', '--no-verify']);

      const fixtureAdapter = path.join(serverDir, 'scripts', 'stryker-adapter.mjs');
      const stdout = await execFileAsync(process.execPath, [fixtureAdapter, `--since=${baseSha}`], {
        cwd: tmpRoot,
      });

      const parsed = parseMutationReport(stdout);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.carrier.total).toBeGreaterThan(0);
        expect(parsed.carrier.killed).toBeGreaterThan(0);
      }
    } finally {
      rmrf(tmpRoot);
    }
  }, 60_000);
});
