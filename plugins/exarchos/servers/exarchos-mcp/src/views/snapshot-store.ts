import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ─── Snapshot Data ─────────────────────────────────────────────────────────

export interface SnapshotData<T = unknown> {
  view: T;
  highWaterMark: number;
  savedAt: string;
}

// ─── Snapshot Store ────────────────────────────────────────────────────────

export class SnapshotStore {
  constructor(private readonly stateDir: string) {}

  /**
   * Get the file path for a snapshot.
   */
  private getSnapshotPath(streamId: string, viewName: string): string {
    return path.join(this.stateDir, `${streamId}.${viewName}.snapshot.json`);
  }

  /**
   * Save a view snapshot to disk.
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
    };

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
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

      // Basic validation
      if (
        data.view === undefined ||
        data.highWaterMark === undefined ||
        typeof data.highWaterMark !== 'number'
      ) {
        return undefined;
      }

      return data;
    } catch {
      return undefined;
    }
  }
}
