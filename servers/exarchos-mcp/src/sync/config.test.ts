import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { loadSyncConfig } from './config.js';

describe('SyncConfigSchema', () => {
  it('SyncConfigSchema_ValidFullConfig_Parses', async () => {
    const { SyncConfigSchema } = await import('./types.js');
    const input = {
      mode: 'dual',
      syncIntervalMs: 60000,
      batchSize: 100,
      maxRetries: 5,
      remote: {
        apiToken: 'token-123',
        apiBaseUrl: 'https://api.example.com',
        exarchosId: 'ex-1',
        timeoutMs: 10000,
      },
    };
    const result = SyncConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('dual');
      expect(result.data.remote?.apiToken).toBe('token-123');
    }
  });

  it('SyncConfigSchema_InvalidMode_Rejects', async () => {
    const { SyncConfigSchema } = await import('./types.js');
    const result = SyncConfigSchema.safeParse({ mode: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('SyncConfigSchema_EmptyObject_AppliesDefaults', async () => {
    const { SyncConfigSchema } = await import('./types.js');
    const result = SyncConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('local');
      expect(result.data.syncIntervalMs).toBe(30000);
      expect(result.data.batchSize).toBe(50);
      expect(result.data.maxRetries).toBe(10);
    }
  });

  it('SyncConfigSchema_NegativeBatchSize_Rejects', async () => {
    const { SyncConfigSchema } = await import('./types.js');
    const result = SyncConfigSchema.safeParse({ batchSize: -1 });
    expect(result.success).toBe(false);
  });
});

describe('loadSyncConfig', () => {
  const tempDirs: string[] = [];

  function createTempConfigDir(config: Record<string, unknown>): string {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-config-'));
    const subDir = path.join(parentDir, 'state');
    fs.mkdirSync(subDir);
    fs.writeFileSync(
      path.join(parentDir, 'bridge-config.json'),
      JSON.stringify(config),
    );
    tempDirs.push(parentDir);
    return subDir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    // Clean up env vars
    delete process.env.EXARCHOS_API_TOKEN;
    delete process.env.BASILEUS_API_URL;
  });

  it('LoadSyncConfig_InvalidJsonTypes_FallsBackToDefaults', () => {
    // Arrange: write a config file with invalid types
    const stateDir = createTempConfigDir({
      mode: 123,
      batchSize: 'not-a-number',
    });

    // Act
    const config = loadSyncConfig(stateDir);

    // Assert: returns default config because Zod rejects invalid types
    expect(config.mode).toBe('local');
    expect(config.batchSize).toBe(50);
    expect(config.syncIntervalMs).toBe(30000);
    expect(config.maxRetries).toBe(10);
  });
});
