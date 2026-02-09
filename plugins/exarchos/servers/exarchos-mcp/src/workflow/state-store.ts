import { WorkflowStateSchema, ErrorCode, isReservedField } from './schemas.js';
import { migrateState, CURRENT_VERSION } from './migration.js';
import type { WorkflowState, WorkflowType } from './types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ─── Initial Phase by Workflow Type ────────────────────────────────────────

const INITIAL_PHASE: Record<WorkflowType, string> = {
  feature: 'ideate',
  debug: 'triage',
  refactor: 'explore',
};

// ─── State Store Error ─────────────────────────────────────────────────────

export class StateStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StateStoreError';
  }
}

// ─── Initialize a New State File ───────────────────────────────────────────

export async function initStateFile(
  stateDir: string,
  featureId: string,
  workflowType: WorkflowType,
): Promise<{ stateFile: string; state: WorkflowState }> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);

  const now = new Date().toISOString();
  const initialPhase = INITIAL_PHASE[workflowType];

  const rawState = {
    version: CURRENT_VERSION,
    featureId,
    workflowType,
    createdAt: now,
    updatedAt: now,
    phase: initialPhase,
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    julesSessions: {},
    reviews: {},
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _history: {},
    _events: [],
    _eventSequence: 0,
    _checkpoint: {
      timestamp: now,
      phase: initialPhase,
      summary: 'Workflow initialized',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: now,
      staleAfterMinutes: 120,
    },
  };

  const parseResult = WorkflowStateSchema.safeParse(rawState);
  if (!parseResult.success) {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Failed to validate initial state: ${parseResult.error.message}`,
    );
  }

  const state = parseResult.data;

  // Ensure directory exists
  await fs.mkdir(stateDir, { recursive: true });

  // Write atomically with exclusive flag (fails if file exists)
  // This avoids TOCTOU race condition — no separate existence check needed
  try {
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), {
      encoding: 'utf-8',
      flag: 'wx', // exclusive create - fails with EEXIST if file exists
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new StateStoreError(
        ErrorCode.STATE_ALREADY_EXISTS,
        `State file already exists: ${stateFile}`,
      );
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to write state file: ${stateFile} — ${(err as Error).message}`,
    );
  }

  return { stateFile, state };
}

// ─── Read and Validate a State File (with Migration) ───────────────────────

export async function readStateFile(stateFile: string): Promise<WorkflowState> {
  let raw: string;

  try {
    raw = await fs.readFile(stateFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StateStoreError(
        ErrorCode.STATE_NOT_FOUND,
        `State file not found: ${stateFile}`,
      );
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to read state file: ${stateFile}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Invalid JSON in state file: ${stateFile}`,
    );
  }

  // Run migration if needed
  let migrated: unknown;
  try {
    migrated = migrateState(parsed);
  } catch (err) {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Migration failed for state file: ${stateFile} — ${(err as Error).message}`,
    );
  }

  // Validate against schema
  const result = WorkflowStateSchema.safeParse(migrated);
  if (!result.success) {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Schema validation failed for state file: ${stateFile} — ${result.error.message}`,
    );
  }

  return result.data;
}

// ─── Write State File Atomically ───────────────────────────────────────────

export async function writeStateFile(
  stateFile: string,
  state: WorkflowState,
): Promise<void> {
  const tmpPath = `${stateFile}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmpPath, stateFile);
  } catch (err) {
    // Clean up temp file if rename failed
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to write state file: ${stateFile} — ${(err as Error).message}`,
    );
  }
}

// ─── Apply Dot-Path Update ─────────────────────────────────────────────────

/**
 * Check if a value is a plain object (not null, not array).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge source into target, returning a new merged object.
 * Arrays are replaced, not merged.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(result[key]) && isPlainObject(source[key])) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Parse a dot-path string into segments, handling array bracket notation.
 * Example: "tasks[0].status" -> ["tasks", 0, "status"]
 */
function parsePath(dotPath: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const parts = dotPath.split('.');

  for (const part of parts) {
    // Check for array bracket notation: "tasks[0]"
    const bracketMatch = part.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch) {
      segments.push(bracketMatch[1]);
      segments.push(parseInt(bracketMatch[2], 10));
    } else {
      // Check for standalone bracket: "[0]"
      const standaloneBracket = part.match(/^\[(\d+)\]$/);
      if (standaloneBracket) {
        segments.push(parseInt(standaloneBracket[1], 10));
      } else {
        segments.push(part);
      }
    }
  }

  return segments;
}

export function applyDotPath(
  obj: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): void {
  // Check for reserved fields
  if (isReservedField(dotPath)) {
    throw new StateStoreError(
      ErrorCode.RESERVED_FIELD,
      `Cannot update reserved field: ${dotPath}`,
    );
  }

  const segments = parsePath(dotPath);
  if (segments.length === 0) return;

  let current: unknown = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];

    if (typeof segment === 'number') {
      // Array index access
      if (!Array.isArray(current)) {
        throw new StateStoreError(
          ErrorCode.INVALID_INPUT,
          `Expected array at index ${segment} in path ${dotPath}`,
        );
      }
      if (current[segment] === undefined) {
        // Create intermediate object or array based on next segment
        current[segment] = typeof nextSegment === 'number' ? [] : {};
      }
      current = current[segment];
    } else {
      // Object key access
      const record = current as Record<string, unknown>;
      if (record[segment] === undefined || record[segment] === null) {
        // Create intermediate object or array based on next segment
        record[segment] = typeof nextSegment === 'number' ? [] : {};
      }
      current = record[segment];
    }
  }

  // Set the final value
  const lastSegment = segments[segments.length - 1];
  if (typeof lastSegment === 'number') {
    if (!Array.isArray(current)) {
      throw new StateStoreError(
        ErrorCode.INVALID_INPUT,
        `Expected array for final index ${lastSegment} in path ${dotPath}`,
      );
    }
    current[lastSegment] = value;
  } else {
    const record = current as Record<string, unknown>;
    // Deep-merge when both existing and new values are plain objects
    if (isPlainObject(record[lastSegment]) && isPlainObject(value)) {
      record[lastSegment] = deepMerge(
        record[lastSegment] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      record[lastSegment] = value;
    }
  }
}

// ─── List State Files ──────────────────────────────────────────────────────

export async function listStateFiles(
  stateDir: string,
): Promise<Array<{ featureId: string; stateFile: string; state: WorkflowState }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to read state directory: ${stateDir}`,
    );
  }

  const stateFiles = entries.filter((f) => f.endsWith('.state.json'));
  const results: Array<{ featureId: string; stateFile: string; state: WorkflowState }> = [];

  for (const file of stateFiles) {
    const stateFile = path.join(stateDir, file);
    const featureId = file.replace('.state.json', '');
    try {
      const state = await readStateFile(stateFile);
      results.push({ featureId, stateFile, state });
    } catch {
      // Skip corrupt or unreadable state files
      continue;
    }
  }

  return results;
}

// ─── Resolve State Directory ───────────────────────────────────────────────

export function resolveStateDir(): string {
  // Check environment variable first
  const envDir = process.env.WORKFLOW_STATE_DIR;
  if (envDir) return envDir;

  // Try to find git root
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path.join(gitRoot, 'docs', 'workflow-state');
  } catch {
    // Fallback to cwd-based path
    return path.join(process.cwd(), 'docs', 'workflow-state');
  }
}
