import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Each test resets the module cache, so `src/logger.ts` reads `EXARCHOS_LOG_LEVEL` again. */
describe('Logger Factory', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.EXARCHOS_LOG_LEVEL;
  });

  it('Logger_DefaultLevel_IsWarn', async () => {
    delete process.env.EXARCHOS_LOG_LEVEL;
    const { logger } = await import('../../src/logger.js');

    expect(logger.level).toBe('warn');
  });

  it('Logger_EnvOverride_RespectsLevel', async () => {
    process.env.EXARCHOS_LOG_LEVEL = 'debug';
    const { logger } = await import('../../src/logger.js');

    expect(logger.level).toBe('debug');
  });

  it('StoreLogger_HasSubsystem_EventStore', async () => {
    const { storeLogger } = await import('../../src/logger.js');

    const bindings = storeLogger.bindings();
    expect(bindings.subsystem).toBe('event-store');
  });

  it('WorkflowLogger_HasSubsystem_Workflow', async () => {
    const { workflowLogger } = await import('../../src/logger.js');

    const bindings = workflowLogger.bindings();
    expect(bindings.subsystem).toBe('workflow');
  });

  it('ViewLogger_HasSubsystem_Views', async () => {
    const { viewLogger } = await import('../../src/logger.js');

    const bindings = viewLogger.bindings();
    expect(bindings.subsystem).toBe('views');
  });

  it('SyncLogger_HasSubsystem_Sync', async () => {
    const { syncLogger } = await import('../../src/logger.js');

    const bindings = syncLogger.bindings();
    expect(bindings.subsystem).toBe('sync');
  });

  it('TelemetryLogger_HasSubsystem_Telemetry', async () => {
    const { telemetryLogger } = await import('../../src/logger.js');

    const bindings = telemetryLogger.bindings();
    expect(bindings.subsystem).toBe('telemetry');
  });
});

/**
 * The MCP server speaks JSON-RPC on stdout, so a `console.log` call corrupts a protocol frame.
 * The product tree logs through pino to stderr.
 *
 * The installer is an interactive terminal program in the same tree, and its stdout is its output.
 * `TERMINAL_OUTPUT_MODULES` names each file that prints, with the reason. An exemption for all of
 * `src/install` also covers the installer modules that must not print.
 */
describe('No Console in Production Code', () => {
  const TERMINAL_OUTPUT_MODULES: ReadonlyMap<string, string> = new Map([
    ['install/wizard/wizard.ts', 'the interactive install wizard — its prompts and summary ARE the product output'],
    ['install/cli-helpers.ts', 'injectable `deps.log ?? console.log` default for CLI-facing operations'],
    ['install/install-skills.ts', 'injectable `opts.log ?? console.log` default for the skills installer'],
    ['install/runtimes/load.ts', 'injectable `deps.warn ?? console.warn` default for runtime-descriptor loading'],
  ]);

  it('NoConsoleInProduction_SourceFilesClean', async () => {
    const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
    const files = await getProductionFiles(srcDir);

    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      if (TERMINAL_OUTPUT_MODULES.has(rel)) continue;
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/console\.(log|error|warn|info|debug)\s*\(/.test(line) && !line.trimStart().startsWith('//')) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  /**
   * An exemption for a file that moved, or that prints nothing, silently widens the rule. The path
   * must resolve, and the file must still hold a console call.
   */
  it('NoConsoleInProduction_EveryExemptionIsLiveAndStillPrints', async () => {
    const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
    expect(TERMINAL_OUTPUT_MODULES.size).toBeGreaterThan(0);
    for (const [rel, reason] of TERMINAL_OUTPUT_MODULES) {
      const content = await fs.readFile(path.join(srcDir, rel), 'utf-8').catch(() => null);
      expect(content, `exempted module ${rel} does not exist (${reason})`).not.toBeNull();
      expect(
        /console\.(log|error|warn|info|debug)\s*\(/.test(content ?? ''),
        `${rel} is exempted but no longer prints — drop the exemption`,
      ).toBe(true);
    }
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
