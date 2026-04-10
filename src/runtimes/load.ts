/**
 * Runtime YAML loader.
 *
 * Reads `runtimes/<name>.yaml` files from disk, parses them via `js-yaml`,
 * and validates them against `RuntimeMapSchema`. On any failure path
 * (missing file, malformed YAML, schema violation) a descriptive `Error` is
 * thrown that always names the offending file and — for schema failures —
 * also names the offending field path.
 *
 * Consumed by:
 *   - the renderer (Task 007)
 *   - the install-skills CLI (Task 019)
 *
 * Implements: DR-4 (runtime capability matrix), DR-10 (schema violation error path).
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { load as yamlLoad, YAMLException } from 'js-yaml';
import { ZodError } from 'zod';
import { RuntimeMapSchema } from './types.js';
import type { RuntimeMap } from './types.js';

/**
 * Canonical list of runtimes that the build system must ship. Any additional
 * YAML files in the runtimes directory are permitted (and loaded) but emit a
 * warning via the injected logger so stray experiments are visible.
 */
export const REQUIRED_RUNTIME_NAMES = [
  'generic',
  'claude',
  'codex',
  'opencode',
  'copilot',
  'cursor',
] as const;

export type RequiredRuntimeName = (typeof REQUIRED_RUNTIME_NAMES)[number];

/**
 * Side-effecting collaborators that `loadAllRuntimes` uses. Injected so tests
 * can assert on warning emission without capturing stderr.
 */
export interface LoadAllRuntimesDeps {
  warn?: (message: string) => void;
}

/**
 * Format a Zod validation error into a single human-readable string that
 * names the filename and each failing field path. Exported so the renderer
 * and CLI can reuse the same format for uniform diagnostics.
 */
export function formatZodError(filename: string, err: ZodError): string {
  const issueLines = err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `  - ${path}: ${issue.message}`;
  });
  return `Invalid runtime map in ${filename}:\n${issueLines.join('\n')}`;
}

/**
 * Narrow the raw return of `yamlLoad` to an object-shaped value before we
 * hand it to Zod. `js-yaml.load` returns `unknown` and can legitimately
 * return `null`, a scalar, or an array when given valid-but-wrong YAML.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Load and validate a single runtime map from a YAML file.
 *
 * Error handling contract:
 *   - Missing file → `Error` mentioning the attempted path and "not found".
 *   - YAML parse failure → `Error` mentioning the filename and wrapping the
 *     underlying `YAMLException` message.
 *   - Parses as YAML but is not an object → `Error` mentioning the filename.
 *   - Fails `RuntimeMapSchema.parse` → `Error` formatted by `formatZodError`
 *     so the filename and every failing field path are present.
 */
export function loadRuntime(path: string): RuntimeMap {
  const filename = basename(path);

  if (!existsSync(path)) {
    throw new Error(`Runtime map file not found: ${path}`);
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read runtime map ${filename} (${path}): ${cause}`);
  }

  let parsed: unknown;
  try {
    parsed = yamlLoad(raw);
  } catch (err) {
    if (err instanceof YAMLException) {
      throw new Error(`Failed to parse YAML in ${filename}: ${err.message}`);
    }
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML in ${filename}: ${cause}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `Runtime map ${filename} did not parse to an object (got ${parsed === null ? 'null' : typeof parsed})`,
    );
  }

  const result = RuntimeMapSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(filename, result.error));
  }

  return result.data;
}

/**
 * Load every `*.yaml` file in the given runtimes directory, validate each
 * against `RuntimeMapSchema`, and return them as an array.
 *
 * Contract:
 *   - Directory must exist — otherwise throws with the attempted path.
 *   - Every runtime in `REQUIRED_RUNTIME_NAMES` MUST be present; a single
 *     aggregated error is thrown listing all missing required runtimes.
 *   - Extra YAML files whose `name` is not in `REQUIRED_RUNTIME_NAMES` are
 *     loaded and included in the returned array, but a warning is emitted
 *     via `deps.warn` (default `console.warn`).
 *   - Individual file failures (parse, schema) propagate as-is.
 */
export function loadAllRuntimes(
  runtimesDir = 'runtimes',
  deps: LoadAllRuntimesDeps = {},
): RuntimeMap[] {
  const warn = deps.warn ?? ((msg: string) => console.warn(msg));

  if (!existsSync(runtimesDir)) {
    throw new Error(`Runtimes directory not found: ${runtimesDir}`);
  }

  const stats = statSync(runtimesDir);
  if (!stats.isDirectory()) {
    throw new Error(`Runtimes path is not a directory: ${runtimesDir}`);
  }

  const entries = readdirSync(runtimesDir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort();

  const loaded: RuntimeMap[] = [];
  for (const entry of entries) {
    const fullPath = join(runtimesDir, entry);
    loaded.push(loadRuntime(fullPath));
  }

  const loadedNames = new Set(loaded.map((runtime) => runtime.name));
  const missing = REQUIRED_RUNTIME_NAMES.filter((name) => !loadedNames.has(name));

  if (missing.length > 0) {
    throw new Error(
      `Missing required runtime map(s) in ${runtimesDir}: ${missing.join(', ')}. ` +
        `Expected one YAML file per runtime: ${REQUIRED_RUNTIME_NAMES.join(', ')}.`,
    );
  }

  const requiredSet = new Set<string>(REQUIRED_RUNTIME_NAMES);
  for (const runtime of loaded) {
    if (!requiredSet.has(runtime.name)) {
      warn(
        `Unknown runtime "${runtime.name}" loaded from ${runtimesDir} — ` +
          `not in required set (${REQUIRED_RUNTIME_NAMES.join(', ')}). ` +
          `Including it anyway.`,
      );
    }
  }

  return loaded;
}
