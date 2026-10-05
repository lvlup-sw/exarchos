/**
 * Structural tests for the `binary-matrix` job in `.github/workflows/ci.yml` and
 * for the `build:binary` script in the root `package.json`. They do not run the matrix.
 *
 * The matrix must match the `TARGETS` tuple, and `npm run build:binary` must pass `--all`.
 * The tests parse the workflow with `js-yaml`, so a formatting edit does not break them.
 *
 * `TARGETS` comes from `build-binary-targets.ts`, which has no side effect.
 * `tools/release/build-binary.ts` imports `bun`, and vitest cannot resolve that import.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { TARGETS } from '../../tools/release/build-binary-targets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'package.json');

interface WorkflowShape {
  jobs?: Record<string, JobShape>;
}

interface JobShape {
  strategy?: {
    matrix?: Record<string, unknown>;
  };
  steps?: Array<{ uses?: string; name?: string; run?: string }>;
}

function loadWorkflow(): WorkflowShape {
  const raw = readFileSync(CI_WORKFLOW_PATH, 'utf-8');
  return yaml.load(raw) as WorkflowShape;
}

function loadPackageJson(): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
}

describe('CI binary matrix wiring', () => {
  it('CiWorkflow_HasBinaryMatrixJob', () => {
    const wf = loadWorkflow();
    expect(wf.jobs).toBeDefined();
    expect(wf.jobs?.['binary-matrix']).toBeDefined();
  });

  /**
   * The matrix can be a `target:` list or an `include:` list of objects. The
   * expected names come from `TARGETS`, so only the workflow YAML can drift from them.
   * The entry count 5 is a literal. A change to the length of `TARGETS` needs an edit here.
   */
  it('CiWorkflow_BinaryMatrix_FiveTargets', () => {
    const wf = loadWorkflow();
    const job = wf.jobs?.['binary-matrix'];
    expect(job).toBeDefined();

    const matrix = job?.strategy?.matrix;
    expect(matrix).toBeDefined();

    const targetList = (matrix as Record<string, unknown>)['target'];
    const includeList = (matrix as Record<string, unknown>)['include'];

    const entries: unknown[] = Array.isArray(targetList)
      ? targetList
      : Array.isArray(includeList)
        ? includeList
        : [];

    expect(entries.length).toBe(5);

    const names = entries.map((e) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && 'target' in e) {
        return String((e as { target: unknown }).target);
      }
      return '';
    });

    const expectedNames = TARGETS.map((t) => `${t.os}-${t.arch}`);
    expect(names.slice().sort()).toEqual(expectedNames.slice().sort());
  });

  it('CiWorkflow_BinaryMatrix_UploadsArtifacts', () => {
    const wf = loadWorkflow();
    const job = wf.jobs?.['binary-matrix'];
    expect(job?.steps).toBeDefined();

    const uploadStep = (job?.steps ?? []).find((s) =>
      (s.uses ?? '').startsWith('actions/upload-artifact@'),
    );
    expect(uploadStep).toBeDefined();
  });

  /** The script must pass `--all`, so a local `npm run build:binary` builds each target. */
  it('PackageJson_Scripts_HasBuildBinary', () => {
    const pkg = loadPackageJson();
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts?.['build:binary']).toBeDefined();
    expect(pkg.scripts?.['build:binary']).toMatch(/--all/);
  });
});
