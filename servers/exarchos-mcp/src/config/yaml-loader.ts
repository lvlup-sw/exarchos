import { parse as parseYaml } from 'yaml';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { ProjectConfigSchema, type ProjectConfig } from './yaml-schema.js';
import { logger } from '../logger.js';

const configLogger = logger.child({ subsystem: 'config' });

// ─── Constants ──────────────────────────────────────────────────────────────

const YAML_FILENAMES = ['.exarchos.yml', '.exarchos.yaml'] as const;

// ─── Section-level parsing keys ─────────────────────────────────────────────

const SECTION_KEYS = ['review', 'vcs', 'workflow', 'tools', 'hooks'] as const;

// ─── Load Project Config ────────────────────────────────────────────────────

/**
 * Loads and validates `.exarchos.yml` (or `.exarchos.yaml`) from the given
 * project root directory. Returns an empty config if no file is found.
 *
 * When the full config fails validation, attempts section-by-section parsing
 * to preserve valid sections and log warnings for invalid ones.
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

        // Full-config validation
        const result = ProjectConfigSchema.safeParse(parsed);
        if (result.success) return result.data;

        // Section-level fallback: extract valid sections
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
 * Attempts to parse each top-level section independently, returning
 * only the sections that pass validation.
 */
function parseSections(parsed: unknown): ProjectConfig {
  if (typeof parsed !== 'object' || parsed === null) return {};

  const raw = parsed as Record<string, unknown>;
  const partial: Record<string, unknown> = {};

  for (const key of SECTION_KEYS) {
    if (key in raw) {
      // Try parsing just this section within a valid ProjectConfig shape
      const sectionResult = ProjectConfigSchema.safeParse({ [key]: raw[key] });
      if (sectionResult.success) {
        partial[key] = sectionResult.data[key];
      }
    }
  }

  return partial as ProjectConfig;
}

// ─── Discover Project Root ──────────────────────────────────────────────────

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

  // 1. Environment variable takes precedence
  if (process.env.EXARCHOS_PROJECT_ROOT) {
    return process.env.EXARCHOS_PROJECT_ROOT;
  }

  // 2. Walk up looking for config file
  let dir = startDir;
  while (true) {
    for (const filename of YAML_FILENAMES) {
      if (existsSync(resolve(dir, filename))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. Git root
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: startDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Not a git repo — fall through
  }

  // 4. CWD fallback
  return startDir;
}
