import { describe, it, expect } from 'vitest';
import {
  detectAgentEnvironments,
  type DetectorDeps,
} from './agent-environment-detector.js';

/** Helper: build a fs probe whose `readFile` and `stat` both throw ENOENT. */
function enoentFs(): NonNullable<DetectorDeps['fs']> {
  return {
    readFile: async (_p: string): Promise<string> => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    },
    stat: async (_p: string): Promise<{ isDirectory(): boolean }> => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    },
  };
}

describe('detectAgentEnvironments — baseline', () => {
  it('DetectAgentEnvironments_EmptyProject_ReturnsAllRuntimesWithConfigAbsent', async () => {
    const deps: DetectorDeps = {
      fs: enoentFs(),
      home: () => '/tmp/home-empty',
      cwd: () => '/tmp/project-empty',
    };

    const result = await detectAgentEnvironments(deps);

    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(
      ['claude-code', 'codex', 'copilot', 'cursor', 'opencode'].sort(),
    );
    for (const env of result) {
      expect(env.configPresent).toBe(false);
      expect(env.configValid).toBe(false);
      expect(env.mcpRegistered).toBe(false);
    }
  });

  it('DetectAgentEnvironments_AbortSignalSignaled_Rejects', async () => {
    const deps: DetectorDeps = {
      fs: enoentFs(),
      home: () => '/tmp/home-abort',
      cwd: () => '/tmp/project-abort',
    };
    const controller = new AbortController();
    controller.abort();

    await expect(
      detectAgentEnvironments(deps, controller.signal),
    ).rejects.toThrow();
  });
});
