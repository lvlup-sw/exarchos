import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SyncState } from './types.js';

// ─── Sync State Manager ─────────────────────────────────────────────────────

export class SyncStateManager {
  constructor(private readonly stateDir: string) {}

  // ─── File Path ──────────────────────────────────────────────────────────

  private getFilePath(streamId: string): string {
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
    } catch {
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
    const state = await this.load(streamId);
    state.localHighWaterMark = mark;
    await this.save(streamId, state);
  }

  // ─── Update Remote HWM ─────────────────────────────────────────────────

  async updateRemoteHWM(streamId: string, mark: number): Promise<void> {
    const state = await this.load(streamId);
    state.remoteHighWaterMark = mark;
    await this.save(streamId, state);
  }
}
