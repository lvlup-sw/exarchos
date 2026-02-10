import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SyncState } from './types.js';

// ─── Stream ID Validation ────────────────────────────────────────────────────

const SAFE_STREAM_ID = /^[A-Za-z0-9._-]+$/;

// ─── Sync State Manager ─────────────────────────────────────────────────────

export class SyncStateManager {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly stateDir: string) {}

  // ─── Per-Stream Locking ─────────────────────────────────────────────────

  private async withLock<T>(streamId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(streamId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.locks.set(streamId, next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // Clean up if no other operation is queued
      if (this.locks.get(streamId) === next) {
        this.locks.delete(streamId);
      }
    }
  }

  // ─── File Path ──────────────────────────────────────────────────────────

  private getFilePath(streamId: string): string {
    if (!SAFE_STREAM_ID.test(streamId)) {
      throw new Error(`Invalid streamId: ${streamId}`);
    }
    return path.join(this.stateDir, `${streamId}.sync.json`);
  }

  // ─── Default State ─────────────────────────────────────────────────────

  private defaultState(streamId: string): SyncState {
    return {
      streamId,
      localHighWaterMark: 0,
      remoteHighWaterMark: 0,
    };
  }

  // ─── Load ───────────────────────────────────────────────────────────────

  async load(streamId: string): Promise<SyncState> {
    const filePath = this.getFilePath(streamId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as SyncState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Failed to load sync state for ${streamId}:`, err);
      }
      return this.defaultState(streamId);
    }
  }

  // ─── Save ───────────────────────────────────────────────────────────────

  async save(streamId: string, state: SyncState): Promise<void> {
    const filePath = this.getFilePath(streamId);
    const tmpPath = `${filePath}.tmp.${Date.now()}`;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  // ─── Update Local HWM ──────────────────────────────────────────────────

  async updateLocalHWM(streamId: string, mark: number): Promise<void> {
    await this.withLock(streamId, async () => {
      const state = await this.load(streamId);
      state.localHighWaterMark = mark;
      await this.save(streamId, state);
    });
  }

  // ─── Update Remote HWM ─────────────────────────────────────────────────

  async updateRemoteHWM(streamId: string, mark: number): Promise<void> {
    await this.withLock(streamId, async () => {
      const state = await this.load(streamId);
      state.remoteHighWaterMark = mark;
      await this.save(streamId, state);
    });
  }
}
