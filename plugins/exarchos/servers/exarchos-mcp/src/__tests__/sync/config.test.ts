import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadSyncConfig, getDefaultConfig } from '../../sync/config.js';

describe('SyncConfig', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'config-test-'));
    stateDir = path.join(tempDir, 'state');
    await mkdir(stateDir, { recursive: true });
    // Clear env vars
    delete process.env.EXARCHOS_API_TOKEN;
    delete process.env.BASILEUS_API_URL;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.EXARCHOS_API_TOKEN;
    delete process.env.BASILEUS_API_URL;
  });

  // ─── getDefaultConfig ─────────────────────────────────────────────────

  describe('getDefaultConfig', () => {
    it('should return defaults', () => {
      const config = getDefaultConfig();
      expect(config.mode).toBe('local');
      expect(config.syncIntervalMs).toBe(30000);
      expect(config.batchSize).toBe(50);
      expect(config.maxRetries).toBe(10);
      expect(config.remote).toBeUndefined();
    });
  });

  // ─── loadSyncConfig ───────────────────────────────────────────────────

  describe('loadSyncConfig', () => {
    it('should apply default values when no config file or env vars', () => {
      const config = loadSyncConfig(stateDir);
      expect(config.mode).toBe('local');
      expect(config.syncIntervalMs).toBe(30000);
      expect(config.batchSize).toBe(50);
      expect(config.maxRetries).toBe(10);
    });

    it('should load config from bridge-config.json in parent directory', async () => {
      const configPath = path.join(tempDir, 'bridge-config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mode: 'dual',
          syncIntervalMs: 15000,
          batchSize: 25,
          maxRetries: 5,
          remote: {
            apiBaseUrl: 'https://api.example.com',
            apiToken: 'token-from-file',
            exarchosId: 'exarchos-file',
            timeoutMs: 10000,
          },
        }),
        'utf-8',
      );

      const config = loadSyncConfig(stateDir);
      expect(config.mode).toBe('dual');
      expect(config.syncIntervalMs).toBe(15000);
      expect(config.batchSize).toBe(25);
      expect(config.remote?.apiBaseUrl).toBe('https://api.example.com');
      expect(config.remote?.apiToken).toBe('token-from-file');
    });

    it('should force mode to local when no API token is available', () => {
      // No env vars, no config file
      const config = loadSyncConfig(stateDir);
      expect(config.mode).toBe('local');
    });

    it('should use environment variables as fallback', () => {
      process.env.EXARCHOS_API_TOKEN = 'env-token';
      process.env.BASILEUS_API_URL = 'https://env.example.com';

      const config = loadSyncConfig(stateDir);
      expect(config.remote?.apiToken).toBe('env-token');
      expect(config.remote?.apiBaseUrl).toBe('https://env.example.com');
      expect(config.mode).toBe('local');
    });

    it('should force mode to local when config file has remote mode but no token', async () => {
      const configPath = path.join(tempDir, 'bridge-config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mode: 'remote',
        }),
        'utf-8',
      );

      const config = loadSyncConfig(stateDir);
      expect(config.mode).toBe('local');
    });
  });
});
