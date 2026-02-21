import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SyncConfig } from './types.js';
import { SyncConfigSchema } from './types.js';
import { syncLogger } from '../logger.js';

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
  // Try loading from bridge-config.json in parent directory
  const configPath = path.join(stateDir, '..', 'bridge-config.json');
  let parsedConfig: SyncConfig | undefined;

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const rawJson: unknown = JSON.parse(content);

    // Validate with Zod — applies defaults for missing fields
    const parseResult = SyncConfigSchema.safeParse(rawJson);
    if (parseResult.success) {
      parsedConfig = parseResult.data;
    } else {
      syncLogger.warn({ configPath, issues: parseResult.error.issues }, 'Invalid sync config');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      syncLogger.warn({ configPath, err }, 'Config load failed');
    }
  }

  // Fall back to defaults if file was missing or invalid
  const config: SyncConfig = parsedConfig ?? getDefaultConfig();

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
