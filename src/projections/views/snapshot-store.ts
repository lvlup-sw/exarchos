import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EVENT_SCHEMA_VERSION } from '../../events/event-migration.js';
import { atomicReplace } from '../../utils/atomic-write.js';

export interface SnapshotData<T = unknown> {
  readonly view: T;
  readonly highWaterMark: number;
  readonly savedAt: string;
  readonly schemaVersion: string;
}

const SAFE_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Whether `id` is safe to use as a snapshot filename segment.
 * The write-side `validateStreamId` also accepts slashes, dots and underscores. A snapshot name must stay kebab-case, because those characters allow path traversal.
 * A caller that iterates arbitrary stream IDs, such as the pipeline view, must skip an ID that fails this check.
 */
export function isSnapshotSafeId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id);
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${label}: "${value}" — must match ${SAFE_ID_PATTERN}`,
    );
  }
}

/** Unlink a file, ignoring ENOENT (file-not-found) errors. */
async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export class SnapshotStore {
  /**
   * `snapshotNamespaces` maps a registered `viewName` to the filename segment of its snapshots on disk.
   * A mapped view uses `<streamId>.<override>.snapshot.json`, so its snapshot lineage can change without a change to the view name.
   * The store does not read files under the old name, so the stream folds again.
   */
  constructor(
    private readonly stateDir: string,
    private readonly snapshotNamespaces: Readonly<Record<string, string>> = {},
  ) {}

  /** Resolve the on-disk filename segment for a view (honoring the namespace map). */
  private resolveSnapshotName(viewName: string): string {
    return this.snapshotNamespaces[viewName] ?? viewName;
  }

  /**
   * Get the file path for a snapshot.
   * It validates `streamId` and the resolved snapshot name, and it asserts that the path stays inside `stateDir`.
   * The name assert uses the label `viewName`, because only a caller-supplied `viewName` can be unsafe.
   */
  private getSnapshotPath(streamId: string, viewName: string): string {
    assertSafeId(streamId, 'streamId');
    const snapshotName = this.resolveSnapshotName(viewName);
    assertSafeId(snapshotName, 'viewName');

    const resolved = path.resolve(
      this.stateDir,
      `${streamId}.${snapshotName}.snapshot.json`,
    );
    const normalizedBase = path.resolve(this.stateDir);

    if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
      throw new Error(
        `Path traversal detected: resolved path "${resolved}" escapes stateDir "${normalizedBase}"`,
      );
    }

    return resolved;
  }

  /**
   * Save a view snapshot atomically. It writes a temporary file, then renames it to the target path.
   * The target file is never partially written.
   */
  async save<T>(
    streamId: string,
    viewName: string,
    view: T,
    highWaterMark: number,
  ): Promise<void> {
    const filePath = this.getSnapshotPath(streamId, viewName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const data: SnapshotData<T> = {
      view,
      highWaterMark,
      savedAt: new Date().toISOString(),
      schemaVersion: EVENT_SCHEMA_VERSION,
    };

    await atomicReplace(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Load a view snapshot from disk.
   * Returns undefined if no snapshot exists or if the snapshot is corrupt.
   */
  async load<T>(
    streamId: string,
    viewName: string,
  ): Promise<SnapshotData<T> | undefined> {
    const filePath = this.getSnapshotPath(streamId, viewName);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content) as SnapshotData<T>;

      if (
        data.view === undefined ||
        data.highWaterMark === undefined ||
        typeof data.highWaterMark !== 'number' ||
        data.schemaVersion !== EVENT_SCHEMA_VERSION
      ) {
        return undefined;
      }

      return data;
    } catch {
      return undefined;
    }
  }

  /**
   * Delete a specific snapshot file.
   * Idempotent: does not throw if the file does not exist.
   */
  async delete(streamId: string, viewName: string): Promise<void> {
    const filePath = this.getSnapshotPath(streamId, viewName);
    await unlinkIfExists(filePath);
  }

  /**
   * Delete all snapshots for a stream, and return the deleted file names.
   * The prefix `${streamId}.` includes the dot, so `my-feature` does not match `my-feature-2`.
   * It skips a file that it cannot delete.
   */
  async deleteAllForStream(streamId: string): Promise<string[]> {
    assertSafeId(streamId, 'streamId');

    const prefix = `${streamId}.`;
    const suffix = '.snapshot.json';
    const deleted: string[] = [];

    let files: string[];
    try {
      files = await fs.readdir(this.stateDir);
    } catch {
      return deleted;
    }

    const matching = files.filter((f) => f.startsWith(prefix) && f.endsWith(suffix));

    for (const file of matching) {
      try {
        await unlinkIfExists(path.join(this.stateDir, file));
        deleted.push(file);
      } catch {
      }
    }

    return deleted;
  }
}
