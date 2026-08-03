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

  it('VitestConfig_EveryProject_DeclaresExplicitTestTimeout', () => {
    // WFQ-015: the timeout policy must be stated, not implicit. Every root
    // project declares an explicit numeric `testTimeout` (unit 5s < process
    // 15s < outcome 30s) so no tier silently inherits vitest's 5000ms default.
    const cfg = vitestConfig as unknown as {
      test?: { projects?: Array<{ test?: { name?: string; testTimeout?: number } }> };
    };
    const projects = cfg.test?.projects ?? [];
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      const name = project.test?.name ?? '(unnamed)';
      expect(
        typeof project.test?.testTimeout,
        `project "${name}" must declare an explicit numeric testTimeout`,
      ).toBe('number');
    }
    // The declared policy is monotonic by tier severity.
    const byName = new Map(
      projects
        .filter((p) => typeof p.test?.name === 'string')
        .map((p) => [p.test!.name as string, p.test?.testTimeout]),
    );
    expect(byName.get('unit')).toBe(5000);
    expect(byName.get('process')).toBe(15000);
    expect(byName.get('outcome')).toBe(30000);
  });
});
