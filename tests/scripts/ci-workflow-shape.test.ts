/**
 * Structural assertions over `.github/workflows/ci.yml` for the outcome-tests
 * job (Phase B, T-013).
 *
 * The outcome-tests tier (T-008..T-014) provisions a third vitest project
 * (`outcome`) plus a Linux-only CI job that runs `npm run test:outcome`.
 * Windows process fidelity is out of scope for the outcome tier today; the
 * job is intentionally pinned to `ubuntu-latest` (or a matrix gated to
 * Linux only).
 *
 * We parse ci.yml with js-yaml (already a root dep) so the assertions
 * survive reasonable formatting edits.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

interface StepShape {
  name?: string;
  run?: string;
  uses?: string;
}

interface JobShape {
  'runs-on'?: string | string[];
  strategy?: { matrix?: { os?: string[] } };
  steps?: StepShape[];
}

interface WorkflowShape {
  jobs?: Record<string, JobShape>;
}

function loadWorkflow(): WorkflowShape {
  const raw = readFileSync(CI_WORKFLOW_PATH, 'utf8');
  return yaml.load(raw) as WorkflowShape;
}

function jobIsLinuxOnly(job: JobShape): boolean {
  const runsOn = job['runs-on'];
  if (typeof runsOn === 'string') {
    return /^ubuntu(-latest|-\d|$)/.test(runsOn);
  }
  // Matrix gating: every os entry must be ubuntu-flavored.
  const matrixOs = job.strategy?.matrix?.os;
  if (Array.isArray(matrixOs) && matrixOs.length > 0) {
    return matrixOs.every((o) => /^ubuntu/.test(o));
  }
  return false;
}

describe('ci.yml workflow shape', () => {
  it('CIWorkflow_OutcomeTestsJob_IsLinuxOnly', () => {
    const wf = loadWorkflow();
    const job = wf.jobs?.['outcome-tests'];
    expect(job, "jobs['outcome-tests'] must exist").toBeDefined();

    expect(jobIsLinuxOnly(job as JobShape), 'outcome-tests must be Linux-only').toBe(
      true,
    );

    const steps = (job as JobShape).steps ?? [];
    const invokesTestOutcome = steps.some(
      (s) => typeof s.run === 'string' && /\bnpm run test:outcome\b/.test(s.run),
    );
    expect(
      invokesTestOutcome,
      'outcome-tests must have a step that runs `npm run test:outcome`',
    ).toBe(true);
  });
});
