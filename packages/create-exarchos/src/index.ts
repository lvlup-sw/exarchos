#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Environment, InstallResult, Companion } from './types.js';
import { parseArgs } from './cli.js';
import { detectEnvironment } from './detect.js';
import { getDefaultCompanions, getCompanions, filterCompanions, getCompanionInstall } from './companions.js';
import { buildEnvironmentChoices, buildCompanionChoices } from './prompts.js';

import * as claudeCode from './installers/claude-code.js';
import * as cursor from './installers/cursor.js';
import * as genericMcp from './installers/generic-mcp.js';
import * as cli from './installers/cli.js';

const BANNER = `
  Exarchos — a local-first SDLC workflow harness
`;

interface Installer {
  installExarchos: (...args: never[]) => InstallResult;
  installCompanion: (companion: Companion, ...args: never[]) => InstallResult;
}

function getInstaller(env: Environment): Installer {
  // Each installer module conforms to the Installer interface when called
  // without optional args (which is how run() uses them).
  switch (env) {
    case 'claude-code': return claudeCode as Installer;
    case 'cursor': return cursor as Installer;
    case 'generic-mcp': return genericMcp as Installer;
    case 'cli': return cli as Installer;
  }
}

function safeInstall(fn: () => InstallResult, name: string): InstallResult {
  try {
    return fn();
  } catch (err: unknown) {
    return {
      success: false,
      name,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function printResult(result: InstallResult, label: string): void {
  if (result.skipped) return;
  if (result.success) {
    process.stdout.write(`  + ${label}: ${result.name}\n`);
  } else {
    process.stdout.write(`  x ${label}: ${result.name} — ${result.error ?? 'unknown error'}\n`);
  }
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  process.stdout.write(BANNER + '\n');

  let env: Environment;
  let selectedCompanionIds: string[];

  if (args.interactive) {
    // Dynamic import to avoid loading @inquirer/prompts in non-interactive mode
    const { select, checkbox } = await import('@inquirer/prompts');

    const detected = args.env ?? detectEnvironment();
    const envChoices = buildEnvironmentChoices(detected);

    env = await select({
      message: 'How are you using this?',
      choices: envChoices,
      default: detected ?? undefined,
    });

    const excludeSet = new Set(args.companions.exclude);
    const companionChoices = buildCompanionChoices(env)
      .filter(c => !excludeSet.has(c.value));
    if (companionChoices.length > 0) {
      selectedCompanionIds = await checkbox({
        message: 'Add companions:',
        choices: companionChoices,
      });
    } else {
      selectedCompanionIds = [];
    }
  } else {
    // Non-interactive mode
    env = args.env ?? detectEnvironment() ?? 'claude-code';
    const defaults = getDefaultCompanions();
    const filtered = filterCompanions(defaults, args.companions.exclude);
    // Also filter to only companions available for this env
    selectedCompanionIds = filtered
      .filter(c => getCompanionInstall(c, env) !== undefined)
      .map(c => c.id);
  }

  const installer = getInstaller(env);

  // Install Exarchos
  process.stdout.write('  Installing Exarchos...\n');
  const exarchosResult = safeInstall(() => installer.installExarchos(), 'exarchos');
  printResult(exarchosResult, 'Exarchos installed');

  if (!exarchosResult.success) {
    process.stdout.write(`\n  Exarchos installation failed. Companions skipped.\n`);
    return;
  }

  // Install selected companions
  const allCompanions = getCompanions();
  for (const companionId of selectedCompanionIds) {
    const companion = allCompanions.find(c => c.id === companionId);
    if (!companion) continue;

    const result = safeInstall(() => installer.installCompanion(companion), companion.name);
    printResult(result, 'Companion installed');
  }

  process.stdout.write('\n  Run /ideate to start.\n');
}

// CLI entry point — resolve symlinks on both sides for npx compatibility
const isMainModule = (() => {
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const entryFile = process.argv[1] ? realpathSync(process.argv[1]) : '';
    return thisFile === entryFile;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  run(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
