import { describe, it, expect } from 'vitest';
import vitestConfig from '../../vitest.config.js';

describe('vitest.config', () => {
  it('VitestConfig_DeclaresOutcomeProject_Exists', () => {
    // The default export from `defineConfig` is a UserConfig-like object.
    // The `test.projects` array contains entries with their own `test.name`.
    const cfg = vitestConfig as unknown as {
      test?: { projects?: Array<{ test?: { name?: string } }> };
    };
    const projects = cfg.test?.projects ?? [];
    const names = projects
      .map((p) => p.test?.name)
      .filter((n): n is string => typeof n === 'string');
    expect(names).toContain('outcome');
  });
});
