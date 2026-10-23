/**
 * `.bun-version` is the one source of the Bun version for CI, the release and the Cursor setup.
 *
 * Every `oven-sh/setup-bun` step must read the file through `bun-version-file`. A literal
 * version in one step lets the binary that CI tests differ from the binary that ships. A step
 * before the checkout cannot read the file, and `setup-bun` then installs the latest Bun.
 * `.cursor/install.sh` pins a checksum for one version, so it keeps a literal that must match.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

/** The value every `setup-bun` step must pass as `bun-version-file`. */
const PIN_FILE = '.bun-version';

/** The `setup-bun` steps that exist today. Fewer found means the parse missed a workflow. */
const MIN_SETUP_STEPS = 12;

interface Step {
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface Workflow {
  readonly jobs?: Record<string, { readonly steps?: readonly Step[] }>;
}

interface PinScan {
  readonly setupSteps: number;
  readonly violations: string[];
}

/** Returns true for a `setup-bun` step, whether the action is pinned by tag or by commit. */
function isSetupBun(step: Step): boolean {
  return typeof step.uses === 'string' && step.uses.startsWith('oven-sh/setup-bun@');
}

/** Returns true for a checkout step. */
function isCheckout(step: Step): boolean {
  return typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@');
}

/** Counts the `setup-bun` steps of the workflows and lists every step that breaks the pin rule. */
function scanPins(workflows: Record<string, Workflow>): PinScan {
  let setupSteps = 0;
  const violations: string[] = [];
  for (const [file, workflow] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      const checkoutAt = steps.findIndex(isCheckout);
      steps.forEach((step, index) => {
        if (!isSetupBun(step)) return;
        setupSteps += 1;
        const where = `${file} ${jobName} step ${index}`;
        if (step.with?.['bun-version'] !== undefined) violations.push(`${where}: literal bun-version`);
        if (step.with?.['bun-version-file'] !== PIN_FILE) violations.push(`${where}: does not read ${PIN_FILE}`);
        if (checkoutAt < 0 || checkoutAt > index) violations.push(`${where}: runs before checkout`);
      });
    }
  }
  return { setupSteps, violations };
}

/** Reads every workflow under `.github/workflows`. */
function loadWorkflows(): Record<string, Workflow> {
  const workflows: Record<string, Workflow> = {};
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    if (!/\.ya?ml$/.test(name)) continue;
    workflows[name] = yaml.load(readFileSync(join(WORKFLOWS_DIR, name), 'utf8')) as Workflow;
  }
  return workflows;
}

/** Returns the version in `.bun-version`. */
function pinnedVersion(): string {
  return readFileSync(join(REPO_ROOT, PIN_FILE), 'utf8').trim();
}

describe('Bun version pin', () => {
  /** The live check: every workflow reads the pin file, after its checkout. */
  it('BunVersionPin_EveryWorkflow_ReadsVersionFile', () => {
    const scan = scanPins(loadWorkflows());
    expect(scan.setupSteps, 'the parse found too few setup-bun steps').toBeGreaterThanOrEqual(MIN_SETUP_STEPS);
    expect(scan.violations).toEqual([]);
  });

  /** The pin file holds one exact version. */
  it('BunVersionPin_VersionFile_IsExactSemver', () => {
    expect(pinnedVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /** The Cursor setup script pins the same version as CI. */
  it('BunVersionPin_CursorInstallScript_MatchesFile', () => {
    const script = readFileSync(join(REPO_ROOT, '.cursor', 'install.sh'), 'utf8');
    const match = /^BUN_VERSION="([^"]+)"$/m.exec(script);
    expect(match?.[1], '.cursor/install.sh has no BUN_VERSION line').toBe(pinnedVersion());
  });

  /** Renovate does not bump the pin file, so the version moves only by hand. */
  it('BunVersionPin_RenovateRule_DisablesBunUpdates', () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'renovate.json'), 'utf8')) as {
      packageRules?: { matchManagers?: string[]; enabled?: boolean }[];
    };
    const rule = (config.packageRules ?? []).find((r) => r.matchManagers?.includes('bun-version'));
    expect(rule?.enabled).toBe(false);
  });

  /** A literal version in a step is reported, so the live check can fail. */
  it('BunVersionPin_LiteralVersionInStep_Fails', () => {
    const scan = scanPins({
      'seed.yml': {
        jobs: {
          build: {
            steps: [{ uses: 'actions/checkout@v4' }, { uses: 'oven-sh/setup-bun@v2', with: { 'bun-version': '1.4.4' } }],
          },
        },
      },
    });
    expect(scan.violations).toEqual([
      'seed.yml build step 1: literal bun-version',
      'seed.yml build step 1: does not read .bun-version',
    ]);
  });

  /** A step before the checkout is reported, also when the action is pinned by commit. */
  it('BunVersionPin_SetupBeforeCheckout_Fails', () => {
    const scan = scanPins({
      'seed.yml': {
        jobs: {
          build: {
            steps: [
              { uses: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6', with: { 'bun-version-file': PIN_FILE } },
              { uses: 'actions/checkout@v4' },
            ],
          },
        },
      },
    });
    expect(scan.setupSteps).toBe(1);
    expect(scan.violations).toEqual(['seed.yml build step 0: runs before checkout']);
  });
});
