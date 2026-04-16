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

describe('detectAgentEnvironments — claude-code', () => {
  /**
   * Build a fs probe that returns file contents keyed by absolute path.
   * Any path not in the map throws ENOENT. Directories declared in
   * `dirs` return `isDirectory: true` from `stat`.
   */
  function mapFs(files: Record<string, string>, dirs: string[] = []): NonNullable<DetectorDeps['fs']> {
    return {
      readFile: async (p: string): Promise<string> => {
        if (p in files) return files[p]!;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      stat: async (p: string): Promise<{ isDirectory(): boolean }> => {
        if (dirs.includes(p)) return { isDirectory: () => true };
        if (p in files) return { isDirectory: () => false };
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
  }

  it('DetectAgentEnvironments_ClaudeJsonPresentWithExarchosMcp_ReturnsMcpRegisteredTrue', async () => {
    const home = '/tmp/home-claude-ok';
    const claudeJson = `${home}/.claude.json`;
    const body = JSON.stringify({
      mcpServers: {
        exarchos: { command: 'node', args: ['dist/index.js'] },
      },
    });

    const result = await detectAgentEnvironments({
      fs: mapFs({ [claudeJson]: body }),
      home: () => home,
      cwd: () => '/tmp/proj',
    });

    const claude = result.find((r) => r.name === 'claude-code');
    expect(claude).toBeDefined();
    expect(claude!.configPresent).toBe(true);
    expect(claude!.configValid).toBe(true);
    expect(claude!.mcpRegistered).toBe(true);
    expect(claude!.skillsDir).toBe(`${home}/.claude/skills`);
  });

  it('DetectAgentEnvironments_ClaudeJsonPresentWithoutExarchosMcp_ReturnsMcpRegisteredFalse', async () => {
    const home = '/tmp/home-claude-no-mcp';
    const claudeJson = `${home}/.claude.json`;
    const body = JSON.stringify({ mcpServers: { other: { command: 'x' } } });

    const result = await detectAgentEnvironments({
      fs: mapFs({ [claudeJson]: body }),
      home: () => home,
      cwd: () => '/tmp/proj',
    });

    const claude = result.find((r) => r.name === 'claude-code')!;
    expect(claude.configPresent).toBe(true);
    expect(claude.configValid).toBe(true);
    expect(claude.mcpRegistered).toBe(false);
  });

  it('DetectAgentEnvironments_ClaudeJsonMalformed_ReturnsConfigValidFalse', async () => {
    const home = '/tmp/home-claude-bad';
    const claudeJson = `${home}/.claude.json`;

    const result = await detectAgentEnvironments({
      fs: mapFs({ [claudeJson]: '{not-json' }),
      home: () => home,
      cwd: () => '/tmp/proj',
    });

    const claude = result.find((r) => r.name === 'claude-code')!;
    expect(claude.configPresent).toBe(true);
    expect(claude.configValid).toBe(false);
    expect(claude.mcpRegistered).toBe(false);
  });
});
