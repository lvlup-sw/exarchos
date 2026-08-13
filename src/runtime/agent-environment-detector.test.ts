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

  it('DetectAgentEnvironments_ExarchosPluginInstalledAndManifestWiresMcp_ReturnsMcpRegisteredTrue', async () => {
    // Regression: #1128. Plugin-marketplace install is exarchos's primary
    // distribution path — the claude-code MCP is wired via the plugin
    // manifest, not the top-level `~/.claude.json`. The detector must
    // consult `installed_plugins.json` + the per-plugin manifest.
    const home = '/tmp/home-plugin-installed';
    const claudeJson = `${home}/.claude.json`;
    const installedPluginsJson = `${home}/.claude/plugins/installed_plugins.json`;
    const pluginInstallPath = `${home}/.claude/plugins/cache/lvlup-sw/exarchos/2.8.0`;
    const pluginManifest = `${pluginInstallPath}/.claude-plugin/plugin.json`;

    const claudeJsonBody = JSON.stringify({ mcpServers: {} });
    const installedPluginsBody = JSON.stringify({
      version: 2,
      plugins: {
        'exarchos@lvlup-sw': [
          { scope: 'user', installPath: pluginInstallPath, version: '2.8.0' },
        ],
      },
    });
    const manifestBody = JSON.stringify({
      name: 'exarchos',
      version: '2.8.0',
      mcpServers: { exarchos: { command: 'node' } },
    });

    const result = await detectAgentEnvironments({
      fs: mapFs({
        [claudeJson]: claudeJsonBody,
        [installedPluginsJson]: installedPluginsBody,
        [pluginManifest]: manifestBody,
      }),
      home: () => home,
      cwd: () => '/tmp/proj',
    });

    const claude = result.find((r) => r.name === 'claude-code')!;
    expect(claude.configPresent).toBe(true);
    expect(claude.configValid).toBe(true);
    expect(claude.mcpRegistered).toBe(true);
  });

  it('DetectAgentEnvironments_ExarchosPluginInstalledButManifestMissingMcp_ReturnsMcpRegisteredFalse', async () => {
    const home = '/tmp/home-plugin-no-mcp';
    const claudeJson = `${home}/.claude.json`;
    const installedPluginsJson = `${home}/.claude/plugins/installed_plugins.json`;
    const pluginInstallPath = `${home}/.claude/plugins/cache/lvlup-sw/exarchos/2.8.0`;
    const pluginManifest = `${pluginInstallPath}/.claude-plugin/plugin.json`;

    const installedPluginsBody = JSON.stringify({
      version: 2,
      plugins: {
        'exarchos@lvlup-sw': [
          { scope: 'user', installPath: pluginInstallPath, version: '2.8.0' },
        ],
      },
    });
    const manifestBody = JSON.stringify({ name: 'exarchos', version: '2.8.0' });

    const result = await detectAgentEnvironments({
      fs: mapFs({
        [claudeJson]: JSON.stringify({ mcpServers: {} }),
        [installedPluginsJson]: installedPluginsBody,
        [pluginManifest]: manifestBody,
      }),
      home: () => home,
      cwd: () => '/tmp/proj',
    });

    const claude = result.find((r) => r.name === 'claude-code')!;
    expect(claude.mcpRegistered).toBe(false);
  });

  it('DetectAgentEnvironments_InstalledPluginsJsonMalformed_DoesNotThrowAndMcpStaysFalse', async () => {
    const home = '/tmp/home-plugin-bad-json';
    const claudeJson = `${home}/.claude.json`;
    const installedPluginsJson = `${home}/.claude/plugins/installed_plugins.json`;

    const result = await detectAgentEnvironments({
      fs: mapFs({
        [claudeJson]: JSON.stringify({ mcpServers: {} }),
        [installedPluginsJson]: '{not-json',
      }),
      home: () => home,
      cwd: () => '/tmp/proj',
    });

    const claude = result.find((r) => r.name === 'claude-code')!;
    expect(claude.configPresent).toBe(true);
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

describe('detectAgentEnvironments — cursor/codex/copilot/opencode', () => {
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

  it('DetectAgentEnvironments_CursorMcpJsonPresent_ReturnsCursorConfigPresent', async () => {
    const cwd = '/tmp/proj-cursor';
    const mcpJson = `${cwd}/.cursor/mcp.json`;
    const body = JSON.stringify({
      mcpServers: { exarchos: { command: 'node' } },
    });

    const result = await detectAgentEnvironments({
      fs: mapFs({ [mcpJson]: body }),
      home: () => '/tmp/home',
      cwd: () => cwd,
    });

    const cursor = result.find((r) => r.name === 'cursor')!;
    expect(cursor.configPresent).toBe(true);
    expect(cursor.configValid).toBe(true);
    expect(cursor.mcpRegistered).toBe(true);
  });

  it('DetectAgentEnvironments_CodexDirPresent_ReturnsCodexConfigPresent', async () => {
    const cwd = '/tmp/proj-codex';
    const codexDir = `${cwd}/.codex`;

    const result = await detectAgentEnvironments({
      fs: mapFs({}, [codexDir]),
      home: () => '/tmp/home',
      cwd: () => cwd,
    });

    const codex = result.find((r) => r.name === 'codex')!;
    expect(codex.configPresent).toBe(true);
    // Codex probing here is presence-only; validity and mcp registration
    // require reading a config file we don't assume exists.
    expect(codex.configValid).toBe(true);
  });

  it('DetectAgentEnvironments_CopilotInstructionsPresent_ReturnsCopilotConfigPresent', async () => {
    const cwd = '/tmp/proj-copilot';
    const githubInstructions = `${cwd}/.github/copilot-instructions.md`;

    const result = await detectAgentEnvironments({
      fs: mapFs({ [githubInstructions]: '# Copilot instructions' }),
      home: () => '/tmp/home',
      cwd: () => cwd,
    });

    const copilot = result.find((r) => r.name === 'copilot')!;
    expect(copilot.configPresent).toBe(true);
  });

  it('DetectAgentEnvironments_OpencodeDirPresent_ReturnsOpencodeConfigPresent', async () => {
    const cwd = '/tmp/proj-opencode';
    const mcpJson = `${cwd}/.opencode/mcp.json`;
    const body = JSON.stringify({
      mcpServers: { exarchos: { command: 'node' } },
    });

    const result = await detectAgentEnvironments({
      fs: mapFs({ [mcpJson]: body }),
      home: () => '/tmp/home',
      cwd: () => cwd,
    });

    const opencode = result.find((r) => r.name === 'opencode')!;
    expect(opencode.configPresent).toBe(true);
    expect(opencode.configValid).toBe(true);
    expect(opencode.mcpRegistered).toBe(true);
  });
});
