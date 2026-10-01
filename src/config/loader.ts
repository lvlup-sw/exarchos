import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExarchosConfig } from './define.js';
import { validateConfig } from './validation.js';

const CONFIG_FILENAMES = ['exarchos.config.ts', 'exarchos.config.js'] as const;

/**
 * Loads the first config file in `projectRoot` through dynamic `import()` and validates its
 * default export. Returns `{}` when no config file exists.
 *
 * A `.ts` file needs a TypeScript-capable loader. If its import fails, the loader uses the `.js`
 * sibling when one exists.
 *
 * Trust boundary: the config file is user-authored code. The import runs it, the same as when
 * the user runs their own scripts.
 *
 * @throws Error if the config file cannot load or is invalid
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

  const rawConfig = extractDefaultExport(configModule);

  const result = validateConfig(rawConfig);
  if (!result.success) {
    throw new Error(
      `Invalid exarchos config at ${configPath}:\n${result.errors?.join('\n')}`,
    );
  }

  return result.data as ExarchosConfig;
}

function extractDefaultExport(module: unknown): unknown {
  if (module !== null && typeof module === 'object' && 'default' in module) {
    return (module as Record<string, unknown>).default;
  }
  return module;
}
