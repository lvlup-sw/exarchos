import { parse as parseYaml } from 'yaml';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { ProjectConfigSchema, FullExarchosConfigSchema, type ProjectConfig } from './yaml-schema.js';
import { logger } from '../logger.js';

const configLogger = logger.child({ subsystem: 'config' });

const YAML_FILENAMES = ['.exarchos.yml', '.exarchos.yaml'] as const;

/** Top-level sections that the fallback parser validates one at a time. */
const SECTION_KEYS = ['agents', 'artifacts', 'review', 'vcs', 'workflow', 'tools', 'hooks', 'plugins'] as const;

/**
 * Loads and validates `.exarchos.yml` (or `.exarchos.yaml`) from the project root.
 * It returns an empty config if no file is found, or if the file cannot be read or parsed.
 *
 * It validates against `FullExarchosConfigSchema`, not `ProjectConfigSchema`.
 * Two readers with `.strict()` schemas read the same file, and the merged schema accepts the keys of both.
 * The merge is also `.strict()`, so it rejects a typo.
 * If validation fails, it logs a warning and keeps only the sections that pass alone.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  for (const filename of YAML_FILENAMES) {
    const configPath = resolve(projectRoot, filename);
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');

        let parsed: unknown;
        try {
          parsed = parseYaml(raw);
        } catch (err) {
          configLogger.warn({ error: err instanceof Error ? err.message : String(err), path: configPath }, 'Failed to parse YAML in .exarchos.yml — using defaults');
          return {};
        }

        if (parsed === null || parsed === undefined) return {};

        const result = FullExarchosConfigSchema.safeParse(parsed);
        if (result.success) return projectSliceOf(result.data);

        configLogger.warn({ issues: result.error.issues }, '.exarchos.yml validation errors');
        return parseSections(parsed);
      } catch (err) {
        configLogger.warn({ error: err instanceof Error ? err.message : String(err), path: configPath }, 'Failed to read .exarchos.yml');
        return {};
      }
    }
  }
  return {};
}

/**
 * Narrows a validated full-config document to the project-config slice.
 * The keys come from the shape of `ProjectConfigSchema`, so the slice cannot drift from the schema.
 */
function projectSliceOf(full: Record<string, unknown>): ProjectConfig {
  const slice: Record<string, unknown> = {};
  for (const key of Object.keys(ProjectConfigSchema.shape)) {
    if (key in full && full[key] !== undefined) slice[key] = full[key];
  }
  return slice as ProjectConfig;
}

/** Validates each top-level section alone against `ProjectConfigSchema` and returns the sections that pass. */
function parseSections(parsed: unknown): ProjectConfig {
  if (typeof parsed !== 'object' || parsed === null) return {};

  const raw = parsed as Record<string, unknown>;
  const partial: Record<string, unknown> = {};

  for (const key of SECTION_KEYS) {
    if (key in raw) {
      const sectionResult = ProjectConfigSchema.safeParse({ [key]: raw[key] });
      if (sectionResult.success) {
        partial[key] = sectionResult.data[key];
      }
    }
  }

  return partial as ProjectConfig;
}

/**
 * Discovers the project root directory using the following precedence:
 *
 * 1. `EXARCHOS_PROJECT_ROOT` environment variable
 * 2. Walk up from `cwd` looking for `.exarchos.yml` / `.exarchos.yaml`
 * 3. Git repository root (`git rev-parse --show-toplevel`)
 * 4. Fall back to the provided `cwd` (or `process.cwd()`)
 */
export function discoverProjectRoot(cwd?: string): string {
  const startDir = cwd ?? process.cwd();

  if (process.env.EXARCHOS_PROJECT_ROOT) {
    return process.env.EXARCHOS_PROJECT_ROOT;
  }

  let dir = startDir;
  while (true) {
    for (const filename of YAML_FILENAMES) {
      if (existsSync(resolve(dir, filename))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: startDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
  }

  return startDir;
}
