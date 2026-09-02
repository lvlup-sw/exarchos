// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.4 (T4.6)
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../helpers/hermetic.js';
import { runCli } from '../../helpers/cli-runner.js';

describe('exarchos emissions', () => {
  it('emissions_default_outputsNonEmptyCatalog', async () => {
    await withHermeticEnv(async () => {
      // `emissions` serializes the event-emission catalog grouped by source
      // (cli.ts §"Emissions catalog command" → resolveEmissionCatalog()).
      // The catalog is a `{ types: Record<eventName, EventCatalogEntry> }`
      // shape; non-empty implies the registry is wired up.
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
