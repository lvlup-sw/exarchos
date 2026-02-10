import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SyncConfig } from './types.js';

// ─── Default Config ──────────────────────────────────────────────────────────

export function getDefaultConfig(): SyncConfig {
  return {
    mode: 'local',
    syncIntervalMs: 30000,
    batchSize: 50,
    maxRetries: 10,
  };
}

// ─── Load Sync Config ────────────────────────────────────────────────────────

export function loadSyncConfig(stateDir: string): SyncConfig {
  const defaults = getDefaultConfig();

  // Try loading from bridge-config.json in parent directory
  const configPath = path.join(stateDir, '..', 'bridge-config.json');
  let fileConfig: Partial<SyncConfig> = {};

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(content) as Partial<SyncConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Failed to load config from ${configPath}:`, err);
    }
  }

  // Default remote config values
  const remoteDefaults = {
    apiBaseUrl: 'http://localhost:5000',
    exarchosId: 'default',
    timeoutMs: 5000,
  };

  // Merge file config over defaults, normalizing remote with defaults
  const config: SyncConfig = {
    mode: fileConfig.mode ?? defaults.mode,
    syncIntervalMs: fileConfig.syncIntervalMs ?? defaults.syncIntervalMs,
    batchSize: fileConfig.batchSize ?? defaults.batchSize,
    maxRetries: fileConfig.maxRetries ?? defaults.maxRetries,
    remote: fileConfig.remote
      ? {
          apiToken: fileConfig.remote.apiToken,
          apiBaseUrl: fileConfig.remote.apiBaseUrl ?? remoteDefaults.apiBaseUrl,
          exarchosId: fileConfig.remote.exarchosId ?? remoteDefaults.exarchosId,
          timeoutMs: fileConfig.remote.timeoutMs ?? remoteDefaults.timeoutMs,
        }
      : undefined,
  };

  // Fall back to environment variables for remote config if not in file
  if (!config.remote) {
    const apiToken = process.env.EXARCHOS_API_TOKEN;
    const apiBaseUrl = process.env.BASILEUS_API_URL;

    if (apiToken) {
      config.remote = {
        apiToken,
        apiBaseUrl: apiBaseUrl ?? 'http://localhost:5000',
        exarchosId: 'default',
        timeoutMs: 5000,
      };
    }
  }

  // Force local mode if no API token is available
  const hasToken = !!config.remote?.apiToken;
  if (!hasToken && config.mode !== 'local') {
    config.mode = 'local';
  }

  return config;
}
