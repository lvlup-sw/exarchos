import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readConfig,
  writeConfig,
} from './config.js';
import type { ExarchosConfig, WizardSelections } from './config.js';

describe('ExarchosConfig I/O (A3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a valid config object for testing. */
  function createValidConfig(): ExarchosConfig {
    return {
      version: '1.0.0',
      installedAt: '2025-01-15T10:30:00.000Z',
      mode: 'standard',
      selections: {
        mcpServers: ['exarchos', 'github'],
        plugins: ['serena'],
        ruleSets: ['typescript'],
        model: 'claude-sonnet-4-20250514',
      },
      hashes: {
        'commands/ideate.md': 'abc123def456',
        'rules/tdd-typescript.md': 'fed654cba321',
      },
    };
  }

  describe('readConfig', () => {
    it('readConfig_ExistingFile_ReturnsConfig', () => {
      const config = createValidConfig();
      const filePath = path.join(tmpDir, 'exarchos.json');
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');

      const result = readConfig(filePath);

      expect(result).not.toBeNull();
      expect(result!.version).toBe('1.0.0');
      expect(result!.installedAt).toBe('2025-01-15T10:30:00.000Z');
      expect(result!.mode).toBe('standard');
      expect(result!.selections.mcpServers).toEqual(['exarchos', 'github']);
      expect(result!.selections.plugins).toEqual(['serena']);
      expect(result!.selections.ruleSets).toEqual(['typescript']);
      expect(result!.selections.model).toBe('claude-sonnet-4-20250514');
      expect(result!.hashes['commands/ideate.md']).toBe('abc123def456');
    });

    it('readConfig_MissingFile_ReturnsNull', () => {
      const filePath = path.join(tmpDir, 'nonexistent.json');

      const result = readConfig(filePath);

      expect(result).toBeNull();
    });

    it('readConfig_InvalidJson_ThrowsError', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, '{ not valid json', 'utf-8');

      expect(() => readConfig(filePath)).toThrow(/parse|JSON/i);
    });

    it('readConfig_DevMode_ReturnsRepoPath', () => {
      const config: ExarchosConfig = {
        ...createValidConfig(),
        mode: 'dev',
        repoPath: '/home/user/code/exarchos',
      };
      const filePath = path.join(tmpDir, 'exarchos.json');
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');

      const result = readConfig(filePath);

      expect(result!.mode).toBe('dev');
      expect(result!.repoPath).toBe('/home/user/code/exarchos');
    });
  });

  describe('writeConfig', () => {
    it('writeConfig_ValidConfig_WritesJson', () => {
      const config = createValidConfig();
      const filePath = path.join(tmpDir, 'output.json');

      writeConfig(filePath, config);

      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ExarchosConfig;
      expect(parsed.version).toBe('1.0.0');
      expect(parsed.installedAt).toBe('2025-01-15T10:30:00.000Z');
      expect(parsed.selections.mcpServers).toEqual(['exarchos', 'github']);
    });

    it('writeConfig_ValidConfig_PrettyPrints', () => {
      const config = createValidConfig();
      const filePath = path.join(tmpDir, 'pretty.json');

      writeConfig(filePath, config);

      const raw = fs.readFileSync(filePath, 'utf-8');
      // Pretty-printed JSON should have newlines and indentation
      expect(raw).toContain('\n');
      expect(raw).toMatch(/^\{\n\s{2}/); // Opening brace, newline, 2-space indent
    });

    it('writeConfig_CreatesParentDirectories', () => {
      const config = createValidConfig();
      const filePath = path.join(tmpDir, 'nested', 'dir', 'config.json');

      writeConfig(filePath, config);

      expect(fs.existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(parsed.version).toBe('1.0.0');
    });
  });
});
