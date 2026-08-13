// ─── stryker-adapter — composed-path smoke test (DR-7, task 012) ───────────
//
// Exercises the FULL composed path — resolver → handler `defaultRunMutation`
// → adapter → real pinned Stryker binary → `parseMutationReport` — on a tiny,
// isolated fixture scope, in both directions the DR-7 acceptance criteria
// name:
//
//   - "runner present" → a real, non-mocked Stryker run over a 2-commit diff
//     produces a parseable carrier with real mutant counts.
//   - "devDep absent" → with the local pinned binary hidden, the adapter
//     fails CLOSED (non-zero exit, nothing parseable on stdout) rather than
//     silently reporting a false pass. Deleting the real
//     `@stryker-mutator/core` devDependency reproduces this exact failure
//     mode, which is also why the FIRST test in this file goes red the
//     moment that devDep (or its installed binary) disappears — it depends
//     on the real binary actually running, not a hand-mock.
//
// A third direction — a real `git diff` against THIS repo that is genuinely
// empty (`--since=HEAD`) — proves the "empty mutatable surface" path never
// invokes Stryker and never degrades. Plus a provenance check that
// `resolveVerificationRuntime`'s `mutation` field actually resolves to this
// adapter, not the built-in registry's `npx stryker run` fallback.
//
// Boundary-task discipline: nothing here mocks Stryker itself — the "runner
// present" test spawns the real local pinned binary via the real adapter.
// The only things doubled are the git-diff filtering (pure-function unit
// tests below, given an injected file-existence check) and the isolated
// fixture repo the positive test builds so its runtime is independent of the
// server package's ~700-file test suite.
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMutationReport } from './gates/mutation-adequacy.js';
import { resolveVerificationRuntime } from '../config/test-runtime-resolver.js';
import {
  parseSinceArg,
  isMutatableServerSource,
  computeMutateGlobs,
  EMPTY_REPORT,
  MAX_MUTATE_FILES,
} from '../../scripts/core/stryker-adapter.mjs';

const REAL_SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(REAL_SERVER_DIR, '..', '..');
const ADAPTER_SCRIPT = path.join(REAL_SERVER_DIR, 'scripts', 'stryker-adapter.mjs');

function runNode(args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [ADAPTER_SCRIPT, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// ─── Pure helpers (fast, no subprocess) ─────────────────────────────────────

describe('stryker-adapter pure helpers', () => {
  it('parseSinceArg extracts the value of a handler-appended --since=<base> flag', () => {
    expect(parseSinceArg(['--since=abc123'])).toBe('abc123');
    expect(parseSinceArg(['run', '--since=main', '--other'])).toBe('main');
    expect(parseSinceArg([])).toBeUndefined();
    expect(parseSinceArg(['--other=x'])).toBeUndefined();
  });

  it('isMutatableServerSource restricts to changed src/** production files', () => {
    expect(isMutatableServerSource('src/foo.ts')).toBe(true);
    expect(isMutatableServerSource('src/foo.test.ts')).toBe(false);
    expect(isMutatableServerSource('src/foo.d.ts')).toBe(false);
    expect(isMutatableServerSource('src/foo.type-test.ts')).toBe(false);
    expect(isMutatableServerSource('src/foo.bench.ts')).toBe(false);
    expect(isMutatableServerSource('scripts/core/other.ts')).toBe(false);
    expect(isMutatableServerSource('src/foo.ts')).toBe(false);
    expect(isMutatableServerSource('servers/exarchos-mcp/README.md')).toBe(false);
  });

  it('computeMutateGlobs filters to still-existing, mutatable files and strips the server prefix', () => {
    const changed = [
      'src/foo.ts', // qualifies
      'src/foo.test.ts', // excluded: test file
      'src/deleted.ts', // excluded: no longer exists
      'docs/guides/toolchain-resolution.md', // excluded: outside server src
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

// ─── resolveVerificationRuntime provenance (DR-7 acceptance criteria) ──────

describe('resolveVerificationRuntime mutation-field provenance (DR-7)', () => {
  it('resolves this repo\'s .exarchos.yml adapter entry, not the built-in npx fallback', () => {
    const runtime = resolveVerificationRuntime(REPO_ROOT);
    expect(runtime.mutation).toBe('node scripts/core/stryker-adapter.mjs');
    expect(runtime.mutation).not.toBe('npx stryker run');
  });

  it('config-tier mutation: beats the built-in node registry default generically', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mutation-provenance-'));
    try {
      writeFileSync(path.join(tmp, 'package.json'), '{"name":"fixture"}\n');
      const runtime = resolveVerificationRuntime(tmp, {
        loadConfig: () => ({
          config: { mutation: 'node scripts/core/stryker-adapter.mjs' },
          source: path.join(tmp, '.exarchos.yml'),
        }),
      });
      // Without the injected config, node's built-in registry default is
      // `npx stryker run` (toolchains.ts) — the config-tier value must win.
      expect(runtime.mutation).toBe('node scripts/core/stryker-adapter.mjs');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Composed path — real repo, empty diff (fast, no fixture needed) ──────

describe('stryker-adapter composed path — empty mutatable surface', () => {
  it('a genuinely empty diff (--since=HEAD) prints the empty-valid report and exits 0, never invoking Stryker', () => {
    const result = runNode(['--since=HEAD'], REPO_ROOT);
    expect(result.status).toBe(0);
    const parsed = parseMutationReport(result.stdout);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.carrier.total).toBe(0);
    }
  });
});

// ─── Composed path — devDep absent (fail-closed direction) ─────────────────
//
// Linux/macOS only (DR-7 frames the composed-path smoke test as a Linux-only
// lane). Runs the adapter against an ISOLATED temp root whose server dir has
// no pinned binary — never renaming the SHARED `node_modules/.bin/stryker`
// (which would race concurrent test files and leave node_modules corrupted if
// the process died before restoring it, #1719).

describe.skipIf(process.platform === 'win32')('stryker-adapter composed path — devDep absent', () => {
  it('fails CLOSED (non-zero exit, no parseable report) when the local pinned binary is missing', () => {
    // The adapter's missing-binary branch fires purely on
    // `existsSync(<root>/servers/exarchos-mcp/node_modules/.bin/stryker)`, so
    // an empty temp root exercises it with zero effect on shared state.
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'stryker-missing-bin-'));
    try {
      // No `--since`: the full-tree lane, which invokes runStryker immediately
      // (no diff computation) — the fastest deterministic way to reach the
      // "binary missing" branch without depending on repo git history.
      const result = runNode([], tmpRoot);
      expect(result.status).not.toBe(0);
      expect(result.stdout.trim()).toBe('');
      const parsed = parseMutationReport(result.stdout);
      expect(parsed.ok).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── Composed path — runner present, real mutant counts ────────────────────
//
// Linux/macOS only: builds an isolated fixture repo (own git history, own
// minimal Stryker + Vitest config, symlinked node_modules so the real pinned
// binary resolves without a second `npm install`) so the run stays fast and
// independent of the server package's full test suite. If the real
// `@stryker-mutator/core` devDependency (or its installed binary) is
// deleted, THIS test goes red — it runs the genuine local pinned binary via
// the unmodified, real adapter script, not a hand-mock.

describe.skipIf(process.platform === 'win32')('stryker-adapter composed path — runner present', () => {
  it('produces a parseable carrier with real mutant counts over a tiny 2-commit diff', () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'stryker-adapter-smoke-'));
    try {
      const serverDir = path.join(tmpRoot, 'servers', 'exarchos-mcp');
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
          "import { add } from '../orchestrate/add.js';",
          "describe('add', () => {",
          "  it('adds two numbers', () => {",
          '    expect(add(2, 3)).toBe(5);',
          '  });',
          '});',
          '',
        ].join('\n'),
      );
      // Copy the REAL, unmodified adapter script into the fixture — the
      // composed path runs the exact file this task ships, not a stand-in.
      copyFileSync(ADAPTER_SCRIPT, path.join(serverDir, 'scripts', 'stryker-adapter.mjs'));

      const git = (args: readonly string[]): string =>
        execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      git(['init', '-q']);
      git(['config', 'user.email', 'smoke@example.com']);
      git(['config', 'user.name', 'smoke']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base', '--no-verify']);
      const baseSha = git(['rev-parse', 'HEAD']).trim();

      // A real, behavior-preserving content change to the same file: adds a
      // second, fully-covered function, so the diff is genuine and Stryker
      // has real (killable) mutants to work with.
      writeFileSync(
        path.join(serverDir, 'src', 'fixture', 'add.ts'),
        'export function add(a, b) {\n  return a + b;\n}\nexport function double(x) {\n  return x * 2;\n}\n',
      );
      writeFileSync(
        path.join(serverDir, 'src', 'fixture', 'add.test.ts'),
        [
          "import { describe, it, expect } from 'vitest';",
          "import { add, double } from '../orchestrate/add.js';",
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
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'head', '--no-verify']);

      const fixtureAdapter = path.join(serverDir, 'scripts', 'stryker-adapter.mjs');
      const stdout = execFileSync(process.execPath, [fixtureAdapter, `--since=${baseSha}`], {
        cwd: tmpRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const parsed = parseMutationReport(stdout);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.carrier.total).toBeGreaterThan(0);
        expect(parsed.carrier.killed).toBeGreaterThan(0);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
