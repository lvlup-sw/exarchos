/**
 * Governance tier: the import-boundary leg of `check_static_analysis` through the production composition.
 *
 * Each test drives the real `dispatch()` through `createPublicRootHarness`, on a fixture repository with a
 * `.dependency-cruiser.cjs` and an `error` rule. The npm scripts are real processes. A fixture with a local install
 * links `node_modules` to the dependency-cruiser of this checkout. The gate never fetches a package from the registry.
 *
 * Each case reads the reply and the durable `gate.executed` row of its task.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicRootHarness, type PublicRootHarness } from '../_harness.js';
import { deriveLocalOperatorIdentity } from '../../../../src/dispatch/caller-identity.js';
import { findLocalDepcruise } from '../../../../src/verbs/pure/static-analysis.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

type Rec = Record<string, unknown>;

const FEATURE_ID = 'gov-boundary-leg-composed';

/** A real npm script that exits 0. */
const OK = 'node -e ""';

/** The `node_modules` of this checkout. A fixture with a local install links to it. */
const CHECKOUT_NODE_MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../node_modules');

/** The dependency-cruiser bin of this checkout. Each case with a local install needs it, and none falls back to the registry. */
const CHECKOUT_DEPCRUISE = path.join(
  CHECKOUT_NODE_MODULES,
  '.bin',
  process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise',
);

/** The boundary config of a fixture: one `error` rule, and the `options` block when one is given. */
function cruiserConfig(options?: string): string {
  return [
    'module.exports = {',
    '  forbidden: [',
    "    { name: 'no-core-to-io', severity: 'error',",
    "      from: { path: '^(src|lib)/domain-core' }, to: { path: '^(src|lib)/io-adapters' } },",
    '  ],',
    ...(options === undefined ? [] : [`  options: ${options},`]),
    '};',
    '',
  ].join('\n');
}

/** One `error` rule: a module under `domain-core` imports a module under `io-adapters`. */
const CRUISER_CONFIG = cruiserConfig();

/** The same rule with an `includeOnly` filter that names a tree outside the scanned root, so the scan keeps no module. */
const CRUISER_CONFIG_THAT_KEEPS_NO_MODULE = cruiserConfig("{ includeOnly: '^packages/' }");

let harness: PublicRootHarness;
const scratchDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

interface FixtureOptions {
  readonly root: 'src' | 'lib';
  readonly violation: boolean;
  readonly localInstall: boolean;
  readonly exarchosYml?: string;
  readonly cleanSrcToo?: boolean;
  /** The boundary config text. The default is {@link CRUISER_CONFIG}. */
  readonly cruiserConfig?: string;
  /** Adds a `docs/` directory that holds only a README, so a `docs/**` root exists and holds no module. */
  readonly docsOnly?: boolean;
}

/**
 * Asserts that the gate finds the dependency-cruiser bin of the fixture itself, linked from this checkout.
 * A checkout with no bin fails here, and never passes with the `missing-tool` skip in place of the verdict under test.
 */
function expectTheFixtureBin(dir: string): void {
  expect(existsSync(CHECKOUT_DEPCRUISE), 'the checkout has no dependency-cruiser bin').toBe(true);
  expect(findLocalDepcruise(dir)).toBe(path.join(dir, 'node_modules', '.bin', path.basename(CHECKOUT_DEPCRUISE)));
}

/** Writes a `domain-core` module and an `io-adapters` module under `base`. The violation is the import of the second. */
async function writeModules(base: string, violation: boolean): Promise<void> {
  await fs.mkdir(path.join(base, 'domain-core'), { recursive: true });
  await fs.mkdir(path.join(base, 'io-adapters'), { recursive: true });
  await fs.writeFile(path.join(base, 'io-adapters', 'db.js'), 'export const db = {};\n', 'utf-8');
  await fs.writeFile(
    path.join(base, 'domain-core', 'order.js'),
    violation
      ? "import { db } from '../io-adapters/db.js';\nexport const order = db;\n"
      : 'export const order = {};\n',
    'utf-8',
  );
}

/** Makes a Node fixture repository with real npm scripts and the boundary config. */
async function fixture(opts: FixtureOptions): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gov-boundary-')));
  scratchDirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'gov-boundary-fixture',
      version: '1.0.0',
      private: true,
      scripts: { lint: OK, typecheck: OK, 'quality-check': OK },
    }),
    'utf-8',
  );
  await fs.writeFile(path.join(dir, '.dependency-cruiser.cjs'), opts.cruiserConfig ?? CRUISER_CONFIG, 'utf-8');
  await writeModules(path.join(dir, opts.root), opts.violation);
  if (opts.cleanSrcToo === true) await writeModules(path.join(dir, 'src'), false);
  if (opts.docsOnly === true) {
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'docs', 'README.md'), '# notes\n', 'utf-8');
  }
  if (opts.exarchosYml !== undefined) {
    await fs.writeFile(path.join(dir, '.exarchos.yml'), opts.exarchosYml, 'utf-8');
  }
  if (opts.localInstall) {
    await fs.symlink(CHECKOUT_NODE_MODULES, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return dir;
}

/** Runs `check_static_analysis` for one task, and returns the reply data and the `gate.executed` rows of the task. */
async function runGate(taskId: string, repoRoot: string): Promise<{ readonly data: Rec; readonly rows: readonly Rec[] }> {
  const obs = await harness.runAction(
    'exarchos_orchestrate',
    'check_static_analysis',
    { featureId: FEATURE_ID, taskId, repoRoot },
    { timeoutMs: 180_000 },
  );
  expect(obs.result?.success, JSON.stringify(obs.result?.error)).toBe(true);
  const rows = (await harness.events(FEATURE_ID))
    .filter((e) => e.type === 'gate.executed')
    .map((e) => e.data as Rec)
    .filter((d) => (d.details as Rec | undefined)?.taskId === taskId);
  return { data: (obs.result?.data ?? {}) as Rec, rows };
}

/**
 * The override is a context seam only. It gives a trusted local-operator identity, which the durable gate producer
 * requires. `npm_config_yes=false` makes any npx call in the leg refuse an install, so no case reaches the registry.
 */
beforeAll(async () => {
  for (const key of ['npm_config_yes']) savedEnv[key] = process.env[key];
  process.env.npm_config_yes = 'false';
  harness = await createPublicRootHarness({
    overrides: { callerIdentity: deriveLocalOperatorIdentity('gov-boundary-leg') },
  });
  await harness.runAction('exarchos_workflow', 'init', { featureId: FEATURE_ID, workflowType: 'feature' });
}, 120_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await harness?.dispose();
  for (const dir of scratchDirs) await rmrfAsync(dir).catch(() => undefined);
});

describe('governance — the boundary leg through the production composition', () => {
  /**
   * A boundary leg with no installed tool gives no verdict, and the gate still passes on the other checks.
   * BLOCKING ARM: the durable row of the task keeps the mark and the cause, so settle and other readers see the skip.
   * NEGATIVE TWIN: with a local install and a clean tree, the leg checks the modules, and the row is complete with no list.
   * @kill-seam: the completeness copy of the gate runner into the gate.executed details
   */
  it('Governance_BoundaryLegWithNoInstalledTool_RowKeepsTheDegradedMarkAndItsCause', async () => {
    expect(existsSync(CHECKOUT_DEPCRUISE), 'the checkout has no dependency-cruiser bin').toBe(true);
    const noInstall = await fixture({ root: 'src', violation: true, localInstall: false });
    expect(findLocalDepcruise(noInstall), 'a bin on the walk above the temp directory voids this case').toBeUndefined();

    const degraded = await runGate('T-boundary-no-install', noInstall);
    expect(degraded.data).toMatchObject({ passed: true, degraded: true, verdict: 'pass', completeness: 'degraded' });
    expect(degraded.data.advisorySkips).toEqual([
      expect.objectContaining({ name: 'Import boundaries', cause: 'missing-tool' }),
    ]);
    expect(degraded.rows).toHaveLength(1);
    expect(degraded.rows[0]).toMatchObject({
      passed: true,
      details: {
        verdict: 'pass',
        completeness: 'degraded',
        advisorySkips: [{ name: 'Import boundaries', cause: 'missing-tool' }],
      },
    });

    const clean = await runGate(
      'T-boundary-clean',
      await fixture({ root: 'src', violation: false, localInstall: true }),
    );
    expect(clean.data).toMatchObject({ passed: true, verdict: 'pass', completeness: 'complete' });
    expect(clean.data).not.toHaveProperty('advisorySkips');
    expect(String(clean.data.report)).toMatch(/- \*\*PASS\*\*: Import boundaries — \d+ modules? checked/);
    expect(clean.rows).toHaveLength(1);
    expect(clean.rows[0]).toMatchObject({ passed: true, details: { verdict: 'pass', completeness: 'complete' } });
    expect(clean.rows[0]?.details).not.toHaveProperty('advisorySkips');
  }, 400_000);

  /**
   * A project `.exarchos.yml` that does not load is never read as no config.
   * BLOCKING ARM: the leg fails, and the report names the file and the error. It does not scan the default roots, where
   * `src/` is clean, so a silent fallback gives a PASS here.
   * NEGATIVE TWIN: the same tree with a valid config scans the configured `lib/` root, and its violation fails the leg.
   * @kill-seam: the config read of the static-analysis gate, which caught the load error and used the default roots
   */
  it('Governance_ProjectConfigThatDoesNotLoad_FailsTheBoundaryLegAndNamesTheFile', async () => {
    expect(existsSync(CHECKOUT_DEPCRUISE), 'the checkout has no dependency-cruiser bin').toBe(true);
    const broken = await fixture({
      root: 'lib',
      violation: true,
      localInstall: true,
      cleanSrcToo: true,
      exarchosYml: "ownership:\n  firstParty:\n    - 'lib/**'\nnotARealKey: true\n",
    });

    const refused = await runGate('T-config-does-not-load', broken);
    const report = String(refused.data.report);
    expect(refused.data).toMatchObject({ passed: false, verdict: 'fail' });
    expect(report).toContain(
      `- **FAIL**: Import boundaries — the project config ${path.join(broken, '.exarchos.yml')} does not load`,
    );
    expect(report).toContain('notARealKey');
    expect(report).not.toContain('- **PASS**: Import boundaries');
    expect(refused.rows).toHaveLength(1);
    expect(refused.rows[0]).toMatchObject({ passed: false, details: { verdict: 'fail' } });

    const valid = await fixture({
      root: 'lib',
      violation: true,
      localInstall: true,
      cleanSrcToo: true,
      exarchosYml: "ownership:\n  firstParty:\n    - 'lib/**'\n",
    });
    const scoped = await runGate('T-config-loads', valid);
    const scopedReport = String(scoped.data.report);
    expect(scoped.data).toMatchObject({ passed: false, verdict: 'fail' });
    expect(scopedReport).toContain('error no-core-to-io: lib/domain-core/order.js → lib/io-adapters/db.js');
    expect(scopedReport).not.toContain('does not load');
  }, 400_000);

  /**
   * The installed dependency-cruiser of the fixture scans `src/` and reads an `error` violation from its JSON report.
   * BLOCKING ARM: the violation fails the gate, the report names the rule and the import, and the row of the task is a fail.
   * @kill-seam: the verdict of the boundary leg, read from the JSON report of the installed bin
   */
  it('Governance_BoundaryViolationWithTheInstalledTool_FailsTheGateAndTheRow', async () => {
    const violating = await fixture({ root: 'src', violation: true, localInstall: true });
    expectTheFixtureBin(violating);

    const failed = await runGate('T-boundary-violation', violating);
    const report = String(failed.data.report);
    expect(failed.data).toMatchObject({ passed: false, verdict: 'fail', completeness: 'complete', failCount: 1 });
    expect(failed.data).not.toHaveProperty('advisorySkips');
    expect(report).toContain(
      '- **FAIL**: Import boundaries — dependency-cruiser found 1 violation of error severity',
    );
    expect(report).toContain('error no-core-to-io: src/domain-core/order.js → src/io-adapters/db.js');
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]).toMatchObject({ passed: false, details: { verdict: 'fail', completeness: 'complete' } });
  }, 400_000);

  /** The same tree without the import passes the leg with the count of the two modules that the installed bin checked. */
  it('Governance_CleanTreeWithTheInstalledTool_PassesWithTheCountOfTheModules', async () => {
    const clean = await fixture({ root: 'src', violation: false, localInstall: true });
    expectTheFixtureBin(clean);

    const passed = await runGate('T-boundary-clean-count', clean);
    expect(passed.data).toMatchObject({
      passed: true,
      verdict: 'pass',
      completeness: 'complete',
      passCount: 4,
      failCount: 0,
    });
    expect(passed.data).not.toHaveProperty('advisorySkips');
    expect(String(passed.data.report)).toContain('- **PASS**: Import boundaries — 2 modules checked');
    expect(passed.rows).toHaveLength(1);
    expect(passed.rows[0]).toMatchObject({ passed: true, details: { verdict: 'pass', completeness: 'complete' } });
  }, 400_000);

  /**
   * A depcruise `includeOnly` filter that keeps no module of the scanned root gives no verdict, although the installed bin
   * ran, and `src/` holds a violation.
   * BLOCKING ARM: the leg is a degraded skip with the cause `zero-modules`, never a PASS. The row of the task keeps the mark
   * and the cause.
   * NEGATIVE TWIN: the same tree without the filter checks the modules, and the violation fails the leg.
   * @kill-seam: the zero-module arm of the boundary leg, and the completeness copy of the gate runner into the row
   */
  it('Governance_BoundaryFilterThatKeepsNoModule_DegradedSkipKeepsItsMarkInTheRow', async () => {
    const filtered = await fixture({
      root: 'src',
      violation: true,
      localInstall: true,
      cruiserConfig: CRUISER_CONFIG_THAT_KEEPS_NO_MODULE,
    });
    expectTheFixtureBin(filtered);

    const skipped = await runGate('T-boundary-filter-keeps-none', filtered);
    const report = String(skipped.data.report);
    expect(skipped.data).toMatchObject({ passed: true, degraded: true, verdict: 'pass', completeness: 'degraded' });
    expect(skipped.data.advisorySkips).toEqual([
      expect.objectContaining({ name: 'Import boundaries', cause: 'zero-modules' }),
    ]);
    expect(report).toContain('- **SKIP**: Import boundaries — dependency-cruiser gave no verdict: the scan checked no module');
    expect(report).not.toContain('- **PASS**: Import boundaries');
    expect(skipped.rows).toHaveLength(1);
    expect(skipped.rows[0]).toMatchObject({
      passed: true,
      details: {
        verdict: 'pass',
        completeness: 'degraded',
        advisorySkips: [{ name: 'Import boundaries', cause: 'zero-modules' }],
      },
    });

    const unfiltered = await fixture({ root: 'src', violation: true, localInstall: true });
    expectTheFixtureBin(unfiltered);
    const checked = await runGate('T-boundary-filter-absent', unfiltered);
    expect(checked.data).toMatchObject({ passed: false, verdict: 'fail', completeness: 'complete' });
    expect(String(checked.data.report)).toContain(
      'error no-core-to-io: src/domain-core/order.js → src/io-adapters/db.js',
    );
  }, 400_000);

  /**
   * A configured `ownership.firstParty` root that exists and holds no module gives no verdict, although `src/` holds a
   * violation.
   * BLOCKING ARM: the leg is a degraded skip with the cause `zero-modules`, never a clean PASS over an empty scan.
   * NEGATIVE TWIN: the same tree with the `src/**` root checks the modules, and the violation fails the leg.
   * @kill-seam: the zero-module arm of the boundary leg, which gave a clean PASS for a scan of no module
   */
  it('Governance_ConfiguredRootWithNoModule_DegradedSkipNotAPass', async () => {
    const emptyRoot = await fixture({
      root: 'src',
      violation: true,
      localInstall: true,
      docsOnly: true,
      exarchosYml: "ownership:\n  firstParty:\n    - 'docs/**'\n",
    });
    expectTheFixtureBin(emptyRoot);

    const skipped = await runGate('T-boundary-empty-root', emptyRoot);
    const report = String(skipped.data.report);
    expect(skipped.data).toMatchObject({ passed: true, degraded: true, verdict: 'pass', completeness: 'degraded' });
    expect(skipped.data.advisorySkips).toEqual([
      expect.objectContaining({ name: 'Import boundaries', cause: 'zero-modules' }),
    ]);
    expect(report).toContain('- **SKIP**: Import boundaries — dependency-cruiser gave no verdict: the scan checked no module');
    expect(report).not.toContain('- **PASS**: Import boundaries');
    expect(skipped.rows).toHaveLength(1);
    expect(skipped.rows[0]).toMatchObject({
      passed: true,
      details: { completeness: 'degraded', advisorySkips: [{ name: 'Import boundaries', cause: 'zero-modules' }] },
    });

    const srcRoot = await fixture({
      root: 'src',
      violation: true,
      localInstall: true,
      docsOnly: true,
      exarchosYml: "ownership:\n  firstParty:\n    - 'src/**'\n",
    });
    expectTheFixtureBin(srcRoot);
    const checked = await runGate('T-boundary-src-root', srcRoot);
    expect(checked.data).toMatchObject({ passed: false, verdict: 'fail', completeness: 'complete' });
    expect(String(checked.data.report)).toContain(
      'error no-core-to-io: src/domain-core/order.js → src/io-adapters/db.js',
    );
  }, 400_000);
});
