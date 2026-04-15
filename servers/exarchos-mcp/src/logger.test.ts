import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

describe('Logger Factory', () => {
  beforeEach(() => {
    // Clear module cache to allow env var overrides
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.EXARCHOS_LOG_LEVEL;
  });

  it('Logger_DefaultLevel_IsWarn', async () => {
    delete process.env.EXARCHOS_LOG_LEVEL;
    const { logger } = await import('./logger.js');

    expect(logger.level).toBe('warn');
  });

  it('Logger_EnvOverride_RespectsLevel', async () => {
    process.env.EXARCHOS_LOG_LEVEL = 'debug';
    const { logger } = await import('./logger.js');

    expect(logger.level).toBe('debug');
  });

  it('StoreLogger_HasSubsystem_EventStore', async () => {
    const { storeLogger } = await import('./logger.js');

    // pino child loggers expose bindings
    const bindings = storeLogger.bindings();
    expect(bindings.subsystem).toBe('event-store');
  });

  it('WorkflowLogger_HasSubsystem_Workflow', async () => {
    const { workflowLogger } = await import('./logger.js');

    const bindings = workflowLogger.bindings();
    expect(bindings.subsystem).toBe('workflow');
  });

  it('ViewLogger_HasSubsystem_Views', async () => {
    const { viewLogger } = await import('./logger.js');

    const bindings = viewLogger.bindings();
    expect(bindings.subsystem).toBe('views');
  });

  it('SyncLogger_HasSubsystem_Sync', async () => {
    const { syncLogger } = await import('./logger.js');

    const bindings = syncLogger.bindings();
    expect(bindings.subsystem).toBe('sync');
  });

  it('TelemetryLogger_HasSubsystem_Telemetry', async () => {
    const { telemetryLogger } = await import('./logger.js');

    const bindings = telemetryLogger.bindings();
    expect(bindings.subsystem).toBe('telemetry');
  });
});

describe('No Console in Production Code', () => {
  it('NoConsoleInProduction_SourceFilesClean', async () => {
    // Scan production source files for console.error/console.warn/console.log
    const srcDir = path.resolve(import.meta.dirname, '.');
    const files = await getProductionFiles(srcDir);

    const violations: string[] = [];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/console\.(log|error|warn|info|debug)\s*\(/.test(line) && !line.trimStart().startsWith('//')) {
          violations.push(`${path.relative(srcDir, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

/** Recursively find .ts production files (exclude tests, logger itself, node_modules). */
async function getProductionFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'evals') continue;
      results.push(...await getProductionFiles(fullPath));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.property.test.ts') &&
      !entry.name.endsWith('.bench.ts') &&
      entry.name !== 'logger.ts' &&
      !entry.name.includes('benchmark')
    ) {
      results.push(fullPath);
    }
  }

  return results;
}
