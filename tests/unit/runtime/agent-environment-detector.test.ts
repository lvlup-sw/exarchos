import { describe, it, expect } from 'vitest';
import {
  detectAgentEnvironments,
  type DetectorDeps,
} from '../../../src/runtime/agent-environment-detector.js';

/** Build an fs probe whose `readFile` and `stat` both throw ENOENT. */
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

/**
 * The files of a home with an `exarchos@lvlup-sw` plugin whose manifest wires the server.
 * `record` holds the scope fields of the `installed_plugins.json` record. `extra` adds files, for example settings files.
 */
function pluginHome(home: string, record: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  const installPath = `${home}/.claude/plugins/cache/lvlup-sw/exarchos/2.12.1`;
  return {
    [`${home}/.claude.json`]: JSON.stringify({ mcpServers: {} }),
    [`${home}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
      version: 2,
      plugins: { 'exarchos@lvlup-sw': [{ ...record, installPath, version: '2.12.1' }] },
    }),
    [`${installPath}/.claude-plugin/plugin.json`]: JSON.stringify({
      name: 'exarchos',
      mcpServers: { exarchos: { command: 'exarchos', args: ['mcp'] } },
    }),
    ...extra,
  };
}

/** The `mcpRegistered` value that the detector reports for claude-code with this fs, this home and this project. */
async function claudeMcpRegistered(fs: NonNullable<DetectorDeps['fs']>, home: string, cwd: string): Promise<boolean> {
  const result = await detectAgentEnvironments({ fs, home: () => home, cwd: () => cwd });
  const claude = result.find((r) => r.name === 'claude-code');
  if (claude === undefined) throw new Error('the detector reported no claude-code record');
  return claude.mcpRegistered;
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

/**
 * `mapFs` builds an fs probe from a map of absolute path to file content. `readFile` throws ENOENT for a path that is not in the map.
 * `stat` reports each path in `dirs` as a directory, and it throws ENOENT for a path that is in neither.
 */
describe('detectAgentEnvironments — claude-code', () => {
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

  /**
   * A plugin install registers the MCP server in the plugin manifest, not in `~/.claude.json`.
   * Thus the detector must also read `installed_plugins.json` and the manifest of the installed plugin.
   */
  it('DetectAgentEnvironments_ExarchosPluginInstalledAndManifestWiresMcp_ReturnsMcpRegisteredTrue', async () => {
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

  /**
   * An older installer pointed the entry at `~/.claude/mcp-servers/exarchos-mcp.js`, which starts no server.
   * The detector reports it as not registered, so the doctor check warns and onboard starts the writer.
   */
  it('DetectAgentEnvironments_StaleBundleEntry_ReturnsMcpRegisteredFalse', async () => {
    const home = '/tmp/home-stale-entry';
    const body = JSON.stringify({
      mcpServers: {
        exarchos: { type: 'stdio', command: 'node', args: [`${home}/.claude/mcp-servers/exarchos-mcp.js`] },
      },
    });

    expect(await claudeMcpRegistered(mapFs({ [`${home}/.claude.json`]: body }), home, '/tmp/proj')).toBe(false);
  });

  /** The stale rule matches the `node` command only. Another command with the same argument is a hand edit, and it counts as registered. */
  it('DetectAgentEnvironments_NonNodeEntryInTheBundleDir_ReturnsMcpRegisteredTrue', async () => {
    const home = '/tmp/home-bun-entry';
    const body = JSON.stringify({
      mcpServers: {
        exarchos: { type: 'stdio', command: 'bun', args: [`${home}/.claude/mcp-servers/exarchos-mcp.js`] },
      },
    });

    expect(await claudeMcpRegistered(mapFs({ [`${home}/.claude.json`]: body }), home, '/tmp/proj')).toBe(true);
  });

  /** A `project` install serves only its own `projectPath`. It does not register the server in another project. */
  it('DetectAgentEnvironments_ProjectScopePluginForAnotherProject_ReturnsMcpRegisteredFalse', async () => {
    const home = '/tmp/home-plugin-other-project';
    const files = pluginHome(home, { scope: 'project', projectPath: '/tmp/other-proj' });

    expect(await claudeMcpRegistered(mapFs(files), home, '/tmp/proj')).toBe(false);
  });

  /** A `local` install whose `projectPath` is this project registers the server here. */
  it('DetectAgentEnvironments_LocalScopePluginForThisProject_ReturnsMcpRegisteredTrue', async () => {
    const home = '/tmp/home-plugin-this-project';
    const files = pluginHome(home, { scope: 'local', projectPath: '/tmp/proj' });

    expect(await claudeMcpRegistered(mapFs(files), home, '/tmp/proj')).toBe(true);
  });

  /** A `managed` install serves every project, like a `user` install. */
  it('DetectAgentEnvironments_ManagedScopePlugin_ReturnsMcpRegisteredTrue', async () => {
    const home = '/tmp/home-plugin-managed';
    const files = pluginHome(home, { scope: 'managed' });

    expect(await claudeMcpRegistered(mapFs(files), home, '/tmp/proj')).toBe(true);
  });

  /** A plugin that the user settings turn off starts no server. */
  it('DetectAgentEnvironments_PluginTurnedOffInUserSettings_ReturnsMcpRegisteredFalse', async () => {
    const home = '/tmp/home-plugin-off';
    const files = pluginHome(home, { scope: 'user' }, {
      [`${home}/.claude/settings.json`]: JSON.stringify({ enabledPlugins: { 'exarchos@lvlup-sw': false } }),
    });

    expect(await claudeMcpRegistered(mapFs(files), home, '/tmp/proj')).toBe(false);
  });

  /** The project settings have precedence over the user settings, so they can turn off a plugin that the user settings turn on. */
  it('DetectAgentEnvironments_PluginTurnedOffInProjectSettings_ReturnsMcpRegisteredFalse', async () => {
    const home = '/tmp/home-plugin-project-off';
    const files = pluginHome(home, { scope: 'user' }, {
      [`${home}/.claude/settings.json`]: JSON.stringify({ enabledPlugins: { 'exarchos@lvlup-sw': true } }),
      ['/tmp/proj/.claude/settings.json']: JSON.stringify({ enabledPlugins: { 'exarchos@lvlup-sw': false } }),
    });

    expect(await claudeMcpRegistered(mapFs(files), home, '/tmp/proj')).toBe(false);
  });

  /** The local settings have the highest precedence, so they can turn on a plugin that the user settings turn off. */
  it('DetectAgentEnvironments_LocalSettingsTurnOnAPluginThatUserSettingsTurnOff_ReturnsMcpRegisteredTrue', async () => {
    const home = '/tmp/home-plugin-local-on';
    const files = pluginHome(home, { scope: 'user' }, {
      [`${home}/.claude/settings.json`]: JSON.stringify({ enabledPlugins: { 'exarchos@lvlup-sw': false } }),
      ['/tmp/proj/.claude/settings.local.json']: JSON.stringify({ enabledPlugins: { 'exarchos@lvlup-sw': true } }),
    });

    expect(await claudeMcpRegistered(mapFs(files), home, '/tmp/proj')).toBe(true);
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

  /** The codex probe checks only that `.codex/` exists, so `configValid` equals `configPresent`. */
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
