import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExarchosConfig } from './define.js';
import { validateConfig } from './validation.js';

// ─── Config File Names ─────────────────────────────────────────────────────

const CONFIG_FILENAMES = ['exarchos.config.ts', 'exarchos.config.js'] as const;

// ─── Config Loader ─────────────────────────────────────────────────────────

/**
 * Loads an Exarchos config file from the project root via dynamic import.
 *
 * TRUST BOUNDARY: Config files are user-authored TypeScript/JavaScript
 * modules in the project directory. Dynamic import executes this code,
 * which is equivalent to the user running their own scripts. This is
 * intentional — config files define workflows, guards, and custom behavior.
 *
 * Looks for `exarchos.config.ts` or `exarchos.config.js` in projectRoot.
 * Uses dynamic `import()` for ESM-compatible loading.
 * Returns `{}` if no config file is found.
 * Validates the loaded config with Zod schema.
 *
 * @throws Error if config file exists but is invalid
 */
export async function loadConfig(projectRoot: string): Promise<ExarchosConfig> {
  let configPath: string | undefined;

  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(projectRoot, filename);
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }

  if (!configPath) {
    return {};
  }

  // Dynamic import for ESM compatibility.
  // .ts files require a TypeScript-capable loader (tsx, bun, ts-node).
  // If the import fails for a .ts file, fall back to .js sibling.
  let configModule: unknown;
  try {
    configModule = await import(pathToFileURL(configPath).href);
  } catch (err: unknown) {
    if (configPath.endsWith('.ts')) {
      const jsFallback = configPath.replace(/\.ts$/, '.js');
      if (fs.existsSync(jsFallback)) {
        configPath = jsFallback;
        configModule = await import(pathToFileURL(jsFallback).href);
      } else {
        throw new Error(
          `Cannot load ${configPath}: TypeScript config requires a TS-capable loader (tsx, bun). ` +
          `Either use exarchos.config.js or run with a TypeScript loader.`,
        );
      }
    } else {
      throw err;
    }
  }

  // Extract default export
  const rawConfig = extractDefaultExport(configModule);

  // Validate with Zod
  const result = validateConfig(rawConfig);
  if (!result.success) {
    throw new Error(
      `Invalid exarchos config at ${configPath}:\n${result.errors?.join('\n')}`,
    );
  }

  return result.data as ExarchosConfig;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractDefaultExport(module: unknown): unknown {
  if (module !== null && typeof module === 'object' && 'default' in module) {
    return (module as Record<string, unknown>).default;
  }
  return module;
}
