/**
 * CI wiring tests for the cross-compile binary matrix (task 1.5).
 *
 * These are structural / schema tests over `.github/workflows/ci.yml` and
 * the root `package.json` — they do not invoke the matrix itself. The
 * purpose is to guarantee that the CI job definition stays synchronised
 * with the exported `TARGETS` tuple in `scripts/build-binary.ts` and
 * that the npm entry point (`npm run build:binary`) is wired for the
 * `--all` sweep.
 *
 * We parse the workflow file with `js-yaml` (already an install-time
 * dependency of the root package) rather than regex-matching so the
 * assertions survive reasonable formatting edits.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..');
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

  it('CiWorkflow_BinaryMatrix_FiveTargets', () => {
    const wf = loadWorkflow();
    const job = wf.jobs?.['binary-matrix'];
    expect(job).toBeDefined();

    const matrix = job?.strategy?.matrix;
    expect(matrix).toBeDefined();

    // The matrix must enumerate the exact five TARGETS exported by
    // `scripts/build-binary.ts`. We accept either a `target:` list or an
    // `include:` list of objects — both produce a 5-entry fan-out.
    const targetList = (matrix as Record<string, unknown>)['target'];
    const includeList = (matrix as Record<string, unknown>)['include'];

    const entries: unknown[] = Array.isArray(targetList)
      ? targetList
      : Array.isArray(includeList)
        ? includeList
        : [];

    expect(entries.length).toBe(5);

    // Extract string names from either shape.
    const names = entries.map((e) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && 'target' in e) {
        return String((e as { target: unknown }).target);
      }
      return '';
    });

    expect(names).toContain('linux-x64');
    expect(names).toContain('linux-arm64');
    expect(names).toContain('darwin-x64');
    expect(names).toContain('darwin-arm64');
    expect(names).toContain('windows-x64');
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

  it('PackageJson_Scripts_HasBuildBinary', () => {
    const pkg = loadPackageJson();
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts?.['build:binary']).toBeDefined();
    // Must invoke the --all sweep so `npm run build:binary` produces the
    // full 5-target fan-out locally.
    expect(pkg.scripts?.['build:binary']).toMatch(/--all/);
  });
});
