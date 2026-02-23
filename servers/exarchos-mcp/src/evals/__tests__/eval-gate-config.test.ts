import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Navigate from servers/exarchos-mcp/src/evals/__tests__/ to repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'eval-gate.yml');

interface WorkflowStep {
  name?: string;
  run?: string;
  'continue-on-error'?: boolean;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  'working-directory'?: string;
}

interface WorkflowJob {
  name?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  concurrency?: Record<string, unknown>;
  steps?: WorkflowStep[];
}

interface GHWorkflow {
  name?: string;
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(): GHWorkflow {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  return parseYaml(content) as GHWorkflow;
}

function findStepBySubstring(steps: WorkflowStep[], substring: string): WorkflowStep | undefined {
  return steps.find((s) => s.run?.includes(substring));
}

describe('eval-gate.yml — two-step layer configuration', () => {
  it('evalGateYml_ContainsTwoSteps_RegressionAndCapability', () => {
    // Arrange
    const workflow = loadWorkflow();
    const job = Object.values(workflow.jobs ?? {})[0];
    const steps = job?.steps ?? [];

    // Act
    const regressionStep = findStepBySubstring(steps, '"layer": "regression"');
    const capabilityStep = findStepBySubstring(steps, '"layer": "capability"');

    // Assert
    expect(regressionStep).toBeDefined();
    expect(capabilityStep).toBeDefined();
    expect(regressionStep).not.toBe(capabilityStep);
  });

  it('evalGateYml_RegressionStep_BlocksOnFailure', () => {
    // Arrange
    const workflow = loadWorkflow();
    const job = Object.values(workflow.jobs ?? {})[0];
    const steps = job?.steps ?? [];

    // Act
    const regressionStep = findStepBySubstring(steps, '"layer": "regression"');

    // Assert — regression step should NOT have continue-on-error
    expect(regressionStep).toBeDefined();
    expect(regressionStep!['continue-on-error']).not.toBe(true);
  });

  it('evalGateYml_CapabilityStep_ContinuesOnError', () => {
    // Arrange
    const workflow = loadWorkflow();
    const job = Object.values(workflow.jobs ?? {})[0];
    const steps = job?.steps ?? [];

    // Act
    const capabilityStep = findStepBySubstring(steps, '"layer": "capability"');

    // Assert — capability step should have continue-on-error: true
    expect(capabilityStep).toBeDefined();
    expect(capabilityStep!['continue-on-error']).toBe(true);
  });
});
