import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { McpServerComponent } from '../manifest/types.js';
import {
  readMcpConfig,
  writeMcpConfig,
  mergeMcpServers,
  generateMcpEntry,
  removeMcpServers,
} from './mcp.js';

describe('MCP Config Management (C2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-mcp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a bundled McpServerComponent. */
  function createBundledServer(id: string = 'exarchos'): McpServerComponent {
    return {
      id,
      name: 'Exarchos MCP',
      description: 'Workflow state management',
      required: true,
      type: 'bundled',
      bundlePath: 'dist/exarchos-mcp.js',
      devEntryPoint: 'servers/exarchos-mcp/dist/index.js',
    };
  }

  /** Helper: create an external McpServerComponent. */
  function createExternalServer(id: string = 'example-ext'): McpServerComponent {
    return {
      id,
      name: 'Example External',
      description: 'External tool integration',
      required: false,
      type: 'external',
      command: 'example-tool',
      args: ['serve'],
    };
  }

  /** Helper: create a remote McpServerComponent. */
  function createRemoteServer(id: string = 'microsoft-learn'): McpServerComponent {
    return {
      id,
      name: 'Microsoft Learn',
      description: 'Microsoft documentation',
      required: false,
      type: 'remote',
      url: 'https://learn.microsoft.com/api/mcp',
    };
  }

  describe('readMcpConfig', () => {
    it('readMcpConfig_ExistingFile_ReturnsConfig', () => {
      const configPath = path.join(tmpDir, 'claude.json');
      const config = {
        mcpServers: {
          exarchos: { type: 'stdio', command: 'node', args: ['run', 'server.js'] },
        },
        someOtherKey: 'value',
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

      const result = readMcpConfig(configPath);

      expect(result.mcpServers).toBeDefined();
      expect(result.mcpServers!['exarchos']).toBeDefined();
      expect(result.mcpServers!['exarchos'].type).toBe('stdio');
      expect(result['someOtherKey']).toBe('value');
    });

    it('readMcpConfig_MissingFile_ReturnsEmpty', () => {
      const configPath = path.join(tmpDir, 'nonexistent.json');

      const result = readMcpConfig(configPath);

      expect(result).toEqual({});
    });
  });

  describe('mergeMcpServers', () => {
    it('mergeMcpServers_NewInstall_AddsAllServers', () => {
      const config = {};
      const servers = [createBundledServer(), createExternalServer()];
      const claudeHome = path.join(tmpDir, '.claude');

      const result = mergeMcpServers(config, servers, 'node', claudeHome);

      expect(result.mcpServers).toBeDefined();
      expect(result.mcpServers!['exarchos']).toBeDefined();
      expect(result.mcpServers!['example-ext']).toBeDefined();
    });

    it('mergeMcpServers_ExistingServers_PreservesUserServers', () => {
      const config = {
        mcpServers: {
          'my-custom-server': { type: 'stdio', command: 'my-server', args: [] },
        },
      };
      const servers = [createBundledServer()];
      const claudeHome = path.join(tmpDir, '.claude');

      const result = mergeMcpServers(config, servers, 'node', claudeHome);

      // User's custom server should be preserved
      expect(result.mcpServers!['my-custom-server']).toBeDefined();
      expect(result.mcpServers!['my-custom-server'].command).toBe('my-server');
      // Exarchos server should be added
      expect(result.mcpServers!['exarchos']).toBeDefined();
    });

    it('mergeMcpServers_StaleExarchosEntry_UpdatesEntry', () => {
      const config = {
        mcpServers: {
          exarchos: { type: 'stdio', command: 'old-runtime', args: ['old-path'] },
        },
      };
      const servers = [createBundledServer()];
      const claudeHome = path.join(tmpDir, '.claude');

      const result = mergeMcpServers(config, servers, 'node', claudeHome);

      // Should be updated to the new config
      expect(result.mcpServers!['exarchos'].command).toBe('node');
      expect(result.mcpServers!['exarchos'].args).toContain('run');
    });
  });

  describe('generateMcpEntry', () => {
    it('generateMcpEntry_BundledServer_ReturnsCorrectConfig', () => {
      const server = createBundledServer();
      const claudeHome = '/home/user/.claude';

      const entry = generateMcpEntry(server, 'node', claudeHome);

      expect(entry.type).toBe('stdio');
      expect(entry.command).toBe('node');
      expect(entry.args).toEqual([
        'run',
        path.join(claudeHome, 'mcp-servers', 'exarchos-mcp.js'),
      ]);
      expect(entry.env).toEqual({
        WORKFLOW_STATE_DIR: path.join(claudeHome, 'workflow-state'),
      });
    });

    it('generateMcpEntry_BundledServerNoBundlePath_FallsBackToIdBasedName', () => {
      const server: McpServerComponent = {
        id: 'exarchos',
        name: 'Exarchos MCP',
        description: 'Workflow state management',
        required: true,
        type: 'bundled',
      };
      const claudeHome = '/home/user/.claude';

      const entry = generateMcpEntry(server, 'node', claudeHome);

      expect(entry.args).toEqual([
        'run',
        path.join(claudeHome, 'mcp-servers', 'exarchos-mcp.js'),
      ]);
    });

    it('generateMcpEntry_ExternalServer_ReturnsCorrectConfig', () => {
      const server = createExternalServer();
      const claudeHome = '/home/user/.claude';

      const entry = generateMcpEntry(server, 'node', claudeHome);

      expect(entry.type).toBe('stdio');
      expect(entry.command).toBe('example-tool');
      expect(entry.args).toEqual(['serve']);
    });

    it('generateMcpEntry_RemoteServer_ReturnsCorrectConfig', () => {
      const server = createRemoteServer();
      const claudeHome = '/home/user/.claude';

      const entry = generateMcpEntry(server, 'node', claudeHome);

      expect(entry.type).toBe('http');
      expect(entry.url).toBe('https://learn.microsoft.com/api/mcp');
      expect(entry.command).toBeUndefined();
      expect(entry.args).toBeUndefined();
    });
  });

  describe('removeMcpServers', () => {
    it('removeMcpServers_ExistingEntries_RemovesOnlyExarchosManaged', () => {
      const config = {
        mcpServers: {
          exarchos: { type: 'stdio', command: 'node', args: ['run', 'server.js'] },
          'example-ext': { type: 'stdio', command: 'example-tool', args: ['serve'] },
          'my-custom-server': { type: 'stdio', command: 'custom', args: [] },
        },
        someOtherKey: 'preserved',
      };

      const result = removeMcpServers(config, ['exarchos', 'example-ext']);

      expect(result.mcpServers!['exarchos']).toBeUndefined();
      expect(result.mcpServers!['example-ext']).toBeUndefined();
      expect(result.mcpServers!['my-custom-server']).toBeDefined();
      expect(result['someOtherKey']).toBe('preserved');
    });
  });

  describe('writeMcpConfig', () => {
    it('writeMcpConfig_ValidConfig_WritesJsonToDisk', () => {
      const configPath = path.join(tmpDir, 'claude.json');
      const config = {
        mcpServers: {
          exarchos: { type: 'stdio', command: 'node', args: ['server.js'] },
        },
      };

      writeMcpConfig(configPath, config);

      expect(fs.existsSync(configPath)).toBe(true);
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.mcpServers.exarchos.command).toBe('node');
    });

    it('writeMcpConfig_CreatesParentDirectories', () => {
      const configPath = path.join(tmpDir, 'nested', 'dir', 'claude.json');
      const config = { mcpServers: {} };

      writeMcpConfig(configPath, config);

      expect(fs.existsSync(configPath)).toBe(true);
    });
  });
});
