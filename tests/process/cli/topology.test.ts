import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../helpers/hermetic.js';
import { runCli } from '../../helpers/cli-runner.js';

describe('exarchos topology', () => {
  /** Without a type argument, `topology` prints a `WorkflowTypeSummary`. */
  it('topology_default_outputsValidJson', async () => {
    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['topology'] });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { workflowTypes: unknown[] };
      expect(Array.isArray(parsed.workflowTypes)).toBe(true);
      expect(parsed.workflowTypes.length).toBeGreaterThan(0);
    });
  });

  /**
   * With a workflow type, `topology` prints the `SerializedTopology` of that HSM.
   * `feature` is a built-in workflow type, so its topology must hold states.
   */
  it('topology_workflowType_returnsTypeSpecificGraph', async () => {
    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['topology', 'feature'] });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        workflowType: string;
        states: Record<string, unknown>;
      };
      expect(parsed.workflowType).toBe('feature');
      expect(Object.keys(parsed.states).length).toBeGreaterThan(0);
    });
  });
});
