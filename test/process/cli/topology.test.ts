// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.4 (T4.5)
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../fixtures/hermetic.js';
import { runCli } from '../../fixtures/cli-runner.js';

describe('exarchos topology', () => {
  it('topology_default_outputsValidJson', async () => {
    await withHermeticEnv(async () => {
      // Without args, `topology` returns a WorkflowTypeSummary listing
      // (cli.ts §"Topology introspection command").
      const result = await runCli({ args: ['topology'] });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { workflowTypes: unknown[] };
      expect(Array.isArray(parsed.workflowTypes)).toBe(true);
      expect(parsed.workflowTypes.length).toBeGreaterThan(0);
    });
  });

  it('topology_workflowType_returnsTypeSpecificGraph', async () => {
    await withHermeticEnv(async () => {
      // With a workflow type, `topology` returns the SerializedTopology for
      // that HSM. `feature` is a canonical workflow (registered in the
      // state-machine registry) and must come back with phase nodes.
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
