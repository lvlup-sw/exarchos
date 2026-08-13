import { fileURLToPath } from 'node:url';
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

    // pino child loggers expose bindings
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

describe('No Console in Production Code', () => {
  // WHY this rule exists: the MCP server speaks JSON-RPC over stdio, so a
  // stray `console.log` does not merely add noise — it writes bytes onto the
  // protocol channel and corrupts the frame. That is why the whole product
  // tree logs through pino (stderr) instead.
  //
  // The installer is a different contract on the same tree. `exarchos install`
  // is an interactive terminal program whose stdout IS its output, and task
  // 019 folded it in alongside the server, so scanning `src/` now covers both.
  // These files print because printing is their job; each is named
  // individually, with the reason, rather than exempting `src/install/**`
  // wholesale — a directory-wide exemption would also cover the installer's
  // non-presentation modules, which are held to the rule like everything else.
  const TERMINAL_OUTPUT_MODULES: ReadonlyMap<string, string> = new Map([
    ['install/wizard/wizard.ts', 'the interactive install wizard — its prompts and summary ARE the product output'],
    ['install/cli-helpers.ts', 'injectable `deps.log ?? console.log` default for CLI-facing operations'],
    ['install/install-skills.ts', 'injectable `opts.log ?? console.log` default for the skills installer'],
    ['install/runtimes/load.ts', 'injectable `deps.warn ?? console.warn` default for runtime-descriptor loading'],
  ]);

  it('NoConsoleInProduction_SourceFilesClean', async () => {
    // Scan production source files for console.error/console.warn/console.log
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

  it('NoConsoleInProduction_EveryExemptionIsLiveAndStillPrints', async () => {
    // An exemption for a file that moved, or that no longer prints, silently
    // widens the rule — the same failure mode the fold produced elsewhere in
    // this tree. Both halves are checked: the path resolves, and it still
    // contains the console call the exemption was granted for.
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
