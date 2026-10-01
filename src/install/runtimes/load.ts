/**
 * Load the runtime YAML files under `content/harness/runtimes/`, parse them
 * with `js-yaml`, and validate them against `RuntimeMapSchema`. Each error
 * names the file. A schema error also names each failing field path.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { load as yamlLoad, YAMLException } from 'js-yaml';
import { ZodError } from 'zod';
import { RuntimeMapSchema } from './types.js';
import type { RuntimeMap } from './types.js';

/**
 * The runtimes that the build must ship. `loadAllRuntimes` also loads other
 * YAML files in the directory, but it warns about each one.
 */
export const REQUIRED_RUNTIME_NAMES = [
  'generic',
  'claude',
  'codex',
  'opencode',
  'copilot',
  'cursor',
] as const;


/** Injected side effects of `loadAllRuntimes`, so tests can read the warnings. */
export interface LoadAllRuntimesDeps {
  warn?: (message: string) => void;
}

/** Format a Zod error as one message that names the file and each failing field path. */
export function formatZodError(filename: string, err: ZodError): string {
  const issueLines = err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `  - ${path}: ${issue.message}`;
  });
  return `Invalid runtime map in ${filename}:\n${issueLines.join('\n')}`;
}

/**
 * True when `value` is a non-null, non-array object. Valid YAML can load as
 * `null`, a scalar or an array.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Load and validate one runtime map from a YAML file. A missing file, a read
 * failure, a YAML parse failure, a non-object value and a schema failure each
 * throw an `Error` that names the file.
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
 * Load and validate each `*.yaml` and `*.yml` file in `runtimesDir`, in name
 * order. Throws when the directory is absent, and throws one error that lists
 * each missing runtime of `REQUIRED_RUNTIME_NAMES`. A runtime outside that list
 * stays in the result, and `deps.warn` reports it.
 */
export function loadAllRuntimes(
  runtimesDir = 'content/harness/runtimes',
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
