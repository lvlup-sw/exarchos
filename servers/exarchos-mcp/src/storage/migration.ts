import { readdir, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { WorkflowEventBase, type WorkflowEvent } from '../event-store/schemas.js';
import { WorkflowStateSchema } from '../workflow/schemas.js';
import { migrateState } from '../workflow/migration.js';
import type { WorkflowState } from '../workflow/types.js';
import type { StorageBackend } from './backend.js';
import { logger } from '../logger.js';

// ─── Legacy File Patterns ───────────────────────────────────────────────────

const LEGACY_CLEANUP_PATTERNS = [
  '.seq',
  '.snapshot.json',
  '.state.json.migrated',
  '.outbox.json.migrated',
];

// ─── State Migration ────────────────────────────────────────────────────────

/**
 * Imports `*.state.json` files into the StorageBackend.
 *
 * For each `*.state.json` file found:
 * - Skips if the featureId already exists in the backend (idempotent)
 * - Parses the JSON content
 * - Validates against WorkflowStateSchema
 * - Extracts the featureId from the filename (`{featureId}.state.json`)
 * - Inserts into the backend via `setState()`
 *
 * The `.state.json` file is kept on disk as a crash-recovery backup.
 * Corrupt or invalid files are skipped.
 */
export async function migrateLegacyStateFiles(
  backend: StorageBackend,
  stateDir: string,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const stateFiles = files.filter(
    (f) => f.endsWith('.state.json') && !f.endsWith('.state.json.migrated'),
  );

  for (const file of stateFiles) {
    const filePath = path.join(stateDir, file);
    const featureId = file.replace('.state.json', '');

    // Idempotent: skip if backend already has this state
    if (backend.getState(featureId) != null) continue;

    let raw: unknown;
    try {
      const content = readFileSync(filePath, 'utf-8');
      raw = JSON.parse(content);
    } catch (err) {
      logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'Skipping corrupt legacy state file');
      continue;
    }

    let migrated: unknown;
    try {
      migrated = migrateState(raw);
    } catch (err) {
      logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'Skipping legacy state file: migration failed');
      continue;
    }

    const parsed = WorkflowStateSchema.safeParse(migrated);
    if (!parsed.success) {
      logger.warn({ file, error: parsed.error.message }, 'Skipping invalid legacy state file');
      continue;
    }
    const state: WorkflowState = parsed.data;

    backend.setState(featureId, state);
  }
}

// ─── Outbox Migration ───────────────────────────────────────────────────────

/**
 * Migrates legacy `*.outbox.json` files into the StorageBackend outbox.
 *
 * Each file is expected to contain a JSON array of WorkflowEvent objects.
 * Events are validated via WorkflowEventBase and inserted via `backend.addOutboxEntry()`.
 */
export async function migrateLegacyOutbox(
  backend: StorageBackend,
  stateDir: string,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const outboxFiles = files.filter((f) => f.endsWith('.outbox.json'));

  for (const file of outboxFiles) {
    const filePath = path.join(stateDir, file);
    const streamId = file.replace('.outbox.json', '');

    let raw: unknown;
    try {
      const content = readFileSync(filePath, 'utf-8');
      raw = JSON.parse(content);
    } catch (err) {
      logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, 'Skipping corrupt legacy outbox file');
      continue;
    }

    const parsed = z.array(WorkflowEventBase).safeParse(raw);
    if (!parsed.success) {
      logger.warn({ file, error: parsed.error.message }, 'Skipping invalid legacy outbox file');
      continue;
    }

    for (const event of parsed.data) {
      backend.addOutboxEntry(streamId, event);
    }

    // Mark as migrated to prevent duplicate replays
    await rename(filePath, filePath + '.migrated');
  }
}

// ─── Legacy File Cleanup ────────────────────────────────────────────────────

/**
 * Removes legacy files that are no longer needed after migration:
 * - `*.seq` (sequence cache files)
 * - `*.snapshot.json` (snapshot files)
 * - `*.state.json.migrated` (already-migrated state files)
 * - `*.outbox.json` (outbox files)
 */
export async function cleanupLegacyFiles(stateDir: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const file of files) {
    const shouldRemove = LEGACY_CLEANUP_PATTERNS.some((pattern) =>
      file.endsWith(pattern),
    );

    if (shouldRemove) {
      try {
        await unlink(path.join(stateDir, file));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
  }
}
