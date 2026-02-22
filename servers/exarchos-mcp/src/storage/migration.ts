import { readdir, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { WorkflowEventBase, type WorkflowEvent } from '../event-store/schemas.js';
import { WorkflowStateSchema } from '../workflow/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import type { StorageBackend } from './backend.js';

// ─── Legacy File Patterns ───────────────────────────────────────────────────

const LEGACY_CLEANUP_PATTERNS = [
  '.seq',
  '.snapshot.json',
  '.state.json.migrated',
  '.outbox.json',
];

// ─── State Migration ────────────────────────────────────────────────────────

/**
 * Migrates legacy `*.state.json` files into the StorageBackend.
 *
 * For each `*.state.json` file found:
 * - Parses the JSON content
 * - Validates against WorkflowStateSchema
 * - Extracts the featureId from the filename (`{featureId}.state.json`)
 * - Inserts into the backend via `setState()`
 * - Renames the original file to `*.state.json.migrated`
 *
 * Corrupt or invalid files are skipped (not renamed).
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

    let raw: unknown;
    try {
      const content = readFileSync(filePath, 'utf-8');
      raw = JSON.parse(content);
    } catch {
      // Corrupt file — skip
      continue;
    }

    const parsed = WorkflowStateSchema.safeParse(raw);
    if (!parsed.success) {
      // Invalid state — skip
      continue;
    }
    const state: WorkflowState = parsed.data;

    backend.setState(featureId, state);

    // Rename to .migrated after successful insert
    await rename(filePath, filePath + '.migrated');
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
    } catch {
      // Corrupt file — skip
      continue;
    }

    const parsed = z.array(WorkflowEventBase).safeParse(raw);
    if (!parsed.success) {
      continue;
    }

    for (const event of parsed.data) {
      backend.addOutboxEntry(streamId, event);
    }
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
