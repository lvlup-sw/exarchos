/**
 * Holds the Buildkite pull request lane in step with `ci.yml`.
 *
 * Each `run` step of `ci.yml` must map to a lane step in `tools/ci/pr-lane.json`, or carry a reason in its `postMerge` table.
 * Thus a new `ci.yml` step fails here until someone decides where it runs before merge.
 * The lane must never collect coverage, and `ci.yml` must keep the coverage run and the coverage ratchet after merge.
 */
import { describe, it, expect } from 'vitest';
import { spawnAsync } from '../../tools/test-helpers/spawn.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  forcedCoreFiles,
  globToRegExp,
  loadManifest,
  parseArgs,
  relativeImports,
  resolveMode,
  selectSelfTests,
  staticPlan,
  testsPlan,
  workerCount,
} from '../../tools/ci/pr-lane.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CI_TEXT = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const RUNNER_TEXT = readFileSync(join(REPO_ROOT, 'tools', 'ci', 'pr-lane.mjs'), 'utf8');

/** The `tests:` targets that the runner implements. */
const TEST_TARGETS = new Set(['unit', 'acceptance', 'binary', 'process', 'outcome', 'core-forced']);

/** The shape of the lane manifest that these checks read. */
interface LaneManifest {
  static: {
    build: Array<{ id: string; run: string }>;
    gates: Array<{ id: string; run: string; exclusive?: boolean }>;
    selfTests: Array<{ id: string; run: string; paths: string[] }>;
    selfTestSharedTriggers: string[];
  };
  tests: { forcedCore: string[]; gates?: Array<{ id: string; run: string }> };
  postMerge: Record<string, string>;
  ciCoverage: Record<string, string>;
}

/** A `ci.yml` step with the key that the manifest uses for it and its first command. */
interface CiStep {
  key: string;
  command: string;
}

/**
 * Normalizes one command line of `ci.yml` to the form of the manifest keys.
 */
function normalize(line: string): string {
  return line
    .replaceAll('"$GITHUB_WORKSPACE/', '')
    .replaceAll('$GITHUB_WORKSPACE/', '')
    .replaceAll('"', '')
    .replace(/^npx (--no-install )?/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lists every `run` step of `ci.yml`. A step with one command line uses that line as its key. A longer step uses its name.
 */
function ciSteps(text: string): CiStep[] {
  const doc = yaml.load(text) as { jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }> };
  const out: CiStep[] = [];
  for (const [job, body] of Object.entries(doc.jobs)) {
    for (const step of body.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      const lines = step.run.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));
      const first = lines[0];
      if (first === undefined) continue;
      const command = normalize(first);
      const label = lines.length > 1 && step.name !== undefined ? step.name : command;
      out.push({ key: `${job}: ${label}`, command });
    }
  }
  return out;
}

/**
 * Returns each mismatch between `ci.yml` and the manifest. An empty list means the two agree.
 */
function parityProblems(text: string, manifest: LaneManifest): string[] {
  const problems: string[] = [];
  const steps = ciSteps(text);
  const keys = new Set(steps.map((step) => step.key));
  const gateIds = new Set([...manifest.static.build, ...manifest.static.gates].map((step) => step.id));
  const selfTests = new Map(manifest.static.selfTests.map((selfTest) => [selfTest.id, selfTest]));
  const testGateIds = new Set((manifest.tests.gates ?? []).map((gate) => gate.id));
  for (const step of steps) {
    const target = manifest.ciCoverage[step.key];
    const reason = manifest.postMerge[step.key];
    if (target === undefined && reason === undefined) problems.push(`unmapped ci.yml step: ${step.key}`);
    if (target !== undefined && reason !== undefined) problems.push(`step is both mapped and post-merge: ${step.key}`);
    if (/^bash tests\/scripts\/.*\.test\.sh$/.test(step.command)) {
      const selfTest = target?.startsWith('selftest:') ? selfTests.get(target.slice('selftest:'.length)) : undefined;
      if (selfTest === undefined || selfTest.run !== step.command) problems.push(`self-test without a matching lane self-test: ${step.key}`);
    }
  }
  for (const key of [...Object.keys(manifest.ciCoverage), ...Object.keys(manifest.postMerge)]) {
    if (!keys.has(key)) problems.push(`stale manifest entry: ${key}`);
  }
  for (const [key, target] of Object.entries(manifest.ciCoverage)) {
    const [kind, id = ''] = target.split(':');
    const known =
      (kind === 'install' && id === '') ||
      (kind === 'static' && gateIds.has(id)) ||
      (kind === 'selftest' && selfTests.has(id)) ||
      (kind === 'tests' && (TEST_TARGETS.has(id) || testGateIds.has(id)));
    if (!known) problems.push(`unknown lane target ${target} for ${key}`);
  }
  return problems;
}

/** The manifest as checked in. */
const MANIFEST = loadManifest() as LaneManifest;

/** Resource limits of a 4-vCPU, 16 GiB agent. */
const MEDIUM = { cpus: 4, memoryBytes: 16 * 1024 ** 3 };

/** Resource limits of a 2-vCPU, 4 GiB agent. */
const SMALL = { cpus: 2, memoryBytes: 4 * 1024 ** 3 };

describe('pull request lane parity with ci.yml', () => {
  it('maps every ci.yml run step to a lane step or a post-merge reason, with no stale entries', () => {
    expect(parityProblems(CI_TEXT, MANIFEST)).toEqual([]);
  });

  it('reports a seeded unmapped step, a stale entry, and an unknown target', () => {
    const seeded = structuredClone(MANIFEST);
    delete seeded.ciCoverage['grep-gates: node tools/audit/gates/check-no-state-json.mjs'];
    seeded.ciCoverage['grep-gates: node tools/audit/gates/check-removed.mjs'] = 'static:no-state-json';
    seeded.ciCoverage['test-root: npm run desc:budget-guard'] = 'static:no-such-step';
    const problems = parityProblems(CI_TEXT, seeded);
    expect(problems).toContain('unmapped ci.yml step: grep-gates: node tools/audit/gates/check-no-state-json.mjs');
    expect(problems).toContain('stale manifest entry: grep-gates: node tools/audit/gates/check-removed.mjs');
    expect(problems).toContain('unknown lane target static:no-such-step for test-root: npm run desc:budget-guard');
  });

  it('reports a self-test that maps to a lane step that runs another command', () => {
    const seeded = structuredClone(MANIFEST);
    seeded.ciCoverage['grep-gates: bash tests/scripts/lint-comments.test.sh'] = 'selftest:type-debt-self-test';
    expect(parityProblems(CI_TEXT, seeded)).toContain('self-test without a matching lane self-test: grep-gates: bash tests/scripts/lint-comments.test.sh');
  });

  it('runs every core file that a ci.yml step re-asserts in the forced core list', () => {
    const forced = new Set(forcedCoreFiles(MANIFEST));
    const files = ciSteps(CI_TEXT)
      .filter((step) => MANIFEST.ciCoverage[step.key] === 'tests:core-forced')
      .flatMap((step) => step.command.split(' ').filter((token) => token.endsWith('.test.ts') && existsSync(join(REPO_ROOT, token))));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((file) => !forced.has(file))).toEqual([]);
  });

  it('names only existing unit test files, each with a reason, in the network-only list', () => {
    const networkOnly = (loadManifest() as { tests: { networkOnly?: Record<string, string> } }).tests.networkOnly ?? {};
    const entries = Object.entries(networkOnly);
    expect(entries.length).toBeGreaterThan(0);
    for (const [file, reason] of entries) {
      expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
      expect(file, file).toMatch(/^tests\/scripts\/.*\.test\.ts$/);
      expect(reason.length, file).toBeGreaterThan(20);
    }
  });
});

describe('pull request lane never collects coverage', () => {
  it('keeps --coverage out of the manifest and the runner', () => {
    expect(JSON.stringify(MANIFEST.static)).not.toContain('--coverage');
    expect(JSON.stringify(MANIFEST.tests)).not.toContain('--coverage');
    expect(RUNNER_TEXT).not.toMatch(/--coverage\b/);
  });

  it('keeps the coverage run and the blocking coverage ratchet in ci.yml after merge', () => {
    expect(CI_TEXT).toMatch(/run: npm run test:coverage/);
    expect(CI_TEXT).toMatch(/check-coverage-ratchet\.mjs/);
    expect(MANIFEST.postMerge['test-mcp: npm run test:coverage']).toBeDefined();
  });

  it('plans no coverage and stops at the first failure in both modes of the tests suite', () => {
    for (const mode of ['selected', 'full'] as const) {
      const steps = testsPlan(MANIFEST, {
        base: 'base',
        mode,
        changed: ['src/index.ts'],
        present: ['src/index.ts'],
        limits: MEDIUM,
        binDir: '/tmp/bin',
        scratch: '/tmp/scratch',
        forced: ['tests/unit/install/advisory-registry.test.ts'],
      });
      const vitestSteps = steps.filter((step) => step.run.includes('vitest'));
      expect(vitestSteps.length).toBeGreaterThan(3);
      for (const step of vitestSteps) {
        expect(step.run).not.toContain('--coverage');
        expect(step.run).toContain('--bail=1');
      }
    }
  });
});

describe('pull request lane selection', () => {
  it('matches globs by path segment', () => {
    expect(globToRegExp('tests/unit/install/**').test('tests/unit/install/a/b.test.ts')).toBe(true);
    expect(globToRegExp('tsconfig*.json').test('tsconfig.scripts.json')).toBe(true);
    expect(globToRegExp('tsconfig*.json').test('tests/tsconfig.json')).toBe(false);
    expect(globToRegExp('vitest.config.*').test('vitest.config.ts')).toBe(true);
  });

  it('resolves auto mode to full for a lockfile, config or runner change, and to selected otherwise', () => {
    const globs = (loadManifest() as { fullModeGlobs: string[] }).fullModeGlobs;
    expect(resolveMode('auto', ['package-lock.json'], globs)).toBe('full');
    expect(resolveMode('auto', ['tools/ci/pr-lane.mjs'], globs)).toBe('full');
    expect(resolveMode('auto', ['src/index.ts', 'docs/a.md'], globs)).toBe('selected');
    expect(resolveMode('selected', ['package-lock.json'], globs)).toBe('selected');
  });

  it('runs a self-test only when its gate, its test or a shared trigger changes, and all of them in full mode', () => {
    expect(selectSelfTests(MANIFEST, 'selected', ['src/index.ts'])).toEqual([]);
    const byGate = selectSelfTests(MANIFEST, 'selected', ['tools/audit/gates/check-type-debt.mjs']).map((s) => s.id);
    expect(byGate).toEqual(['type-debt-self-test']);
    expect(selectSelfTests(MANIFEST, 'selected', ['tools/audit/lib/git-base.mjs'])).toHaveLength(MANIFEST.static.selfTests.length);
    expect(selectSelfTests(MANIFEST, 'full', [])).toHaveLength(MANIFEST.static.selfTests.length);
  });

  it('runs the acceptance suite in full when shipped content changes, and the process tiers only for binary inputs', () => {
    const plan = (changed: string[]) =>
      testsPlan(MANIFEST, { base: 'b', mode: 'selected', changed, present: changed, limits: MEDIUM, binDir: '/b', scratch: '/s', forced: [] });
    const content = plan(['content/skills/x/SKILL.md']).map((s) => s.id + ':' + (s.run.includes(' related ') ? 'related' : 'run'));
    expect(content).toContain('acceptance:run');
    expect(content.some((entry) => entry.startsWith('process'))).toBe(false);
    const source = plan(['src/index.ts']).map((s) => s.id);
    expect(source).toEqual(expect.arrayContaining(['process', 'outcome', 'core']));
  });

  it('passes the base to the comment lint and sizes vitest workers from the agent limits', () => {
    const plan = staticPlan(MANIFEST, { base: 'abc123', mode: 'selected', changed: [], limits: SMALL });
    expect(plan.exclusive.find((step) => step.id === 'lint-comments')?.run).toContain('--base abc123');
    expect(plan.exclusive.find((step) => step.id === 'architecture')?.run).toContain('--maxWorkers=1');
    expect(workerCount(MEDIUM, 3)).toBe(4);
    expect(workerCount(SMALL, 3)).toBe(1);
  });

  it('refuses a missing base, an unknown suite and an unknown mode', () => {
    expect(() => parseArgs(['static'])).toThrow(/--base is required/);
    expect(() => parseArgs(['lint', '--base', 'x'])).toThrow(/usage/);
    expect(() => parseArgs(['tests', '--base', 'x', '--mode', 'fast'])).toThrow(/unknown mode/);
    expect(parseArgs(['tests', '--base', 'x']).mode).toBe('auto');
  });

  it('prints the same unit file list in a dry run as in a real run', async () => {
    const run = await spawnAsync(process.execPath, [join(REPO_ROOT, 'tools', 'ci', 'pr-lane.mjs'), 'tests', '--base', 'HEAD', '--dry-run'], {
      cwd: REPO_ROOT,
      timeout: 25_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const unit = run.stdout.split('\n').find((line) => line.startsWith('- unit: ')) ?? '';
    expect(unit).toMatch(/--project unit '/);
    expect(unit).not.toContain('tests/architecture/');
  }, 30_000);

  it('forces a core test that reads the tree through a helper module, such as the suite-invariants corpus', () => {
    const forced = forcedCoreFiles(MANIFEST);
    expect(forced).toContain('tests/core/integration/suite-invariants.test.ts');
  });

  it('resolves relative imports to the .ts source and the index module', () => {
    const text = "import { a } from './corpus.js';\nconst b = await import('../lib');\nimport c from 'node:fs';";
    const targets = relativeImports('tests/core/integration/x.test.ts', text);
    expect(targets).toContain('tests/core/integration/corpus.ts');
    expect(targets).toContain('tests/core/lib/index.ts');
    expect(targets.some((target) => target.includes('node:fs'))).toBe(false);
  });

  it('runs the knip sweep on the 16 GiB tests agent and not on the 4 GiB static agent', () => {
    const plan = staticPlan(MANIFEST, { base: 'b', mode: 'full', changed: [], limits: SMALL });
    const staticIds = [...plan.build, ...plan.parallel, ...plan.selfTests, ...plan.exclusive].map((step) => step.id);
    expect(staticIds).not.toContain('validate-no-legacy');
    const testIds = testsPlan(MANIFEST, { base: 'b', mode: 'selected', changed: [], present: [], limits: MEDIUM, binDir: '/b', scratch: '/s', forced: [] }).map((step) => step.id);
    expect(testIds).toContain('validate-no-legacy');
  });
});
