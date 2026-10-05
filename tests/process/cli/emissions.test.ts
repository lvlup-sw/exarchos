import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../helpers/hermetic.js';
import { runCli } from '../../helpers/cli-runner.js';

describe('exarchos emissions', () => {
  /**
   * `emissions` prints the event emission catalog as JSON.
   * Its `types` record has one entry for each event type, so an empty record shows a broken registry.
   */
  it('emissions_default_outputsNonEmptyCatalog', async () => {
    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['emissions'] });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        types: Record<string, unknown>;
      };
      expect(parsed.types).toBeTypeOf('object');
      expect(Object.keys(parsed.types).length).toBeGreaterThan(0);
    });
  });
});
