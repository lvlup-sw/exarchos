/**
 * The anti-rollback version ledger. It keeps the highest admitted version of
 * each extension. Admission rejects a manifest below that mark, so an older
 * signed build cannot replace a newer one. `recordAdmitted` only raises the
 * recorded version.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteFile } from '../../utils/atomic-write.js';

/** Durable high-water mark of admitted versions, keyed by extension identity. */
export interface VersionLedger {
  /** Highest version ever admitted for `extensionId`, or `undefined` if none. */
  highestAdmitted(extensionId: string): Promise<number | undefined>;
  /** Record `version` as admitted. It only raises the stored high-water mark. */
  recordAdmitted(extensionId: string, version: number): Promise<void>;
}

/** In-memory ledger for a single process lifetime and for tests. */
export class InMemoryVersionLedger implements VersionLedger {
  private readonly highest = new Map<string, number>();

  async highestAdmitted(extensionId: string): Promise<number | undefined> {
    return this.highest.get(extensionId);
  }

  async recordAdmitted(extensionId: string, version: number): Promise<void> {
    const current = this.highest.get(extensionId);
    if (current === undefined || version > current) {
      this.highest.set(extensionId, version);
    }
  }
}

const LedgerFileSchema = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

/**
 * A ledger that keeps the high-water marks in a JSON file, so they survive a
 * restart. Each call reads the file, so it sees an outside update. Writes are
 * atomic, so a crash cannot leave a torn ledger. The ledger assumes one writer.
 *
 * A corrupt file makes the load throw. It does not reset to empty, because a
 * lost mark opens the downgrade window again.
 */
export class FileVersionLedger implements VersionLedger {
  constructor(private readonly filePath: string) {}

  private async load(): Promise<Map<string, number>> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw error;
    }
    const record = LedgerFileSchema.parse(JSON.parse(text));
    return new Map(Object.entries(record));
  }

  async highestAdmitted(extensionId: string): Promise<number | undefined> {
    return (await this.load()).get(extensionId);
  }

  async recordAdmitted(extensionId: string, version: number): Promise<void> {
    const marks = await this.load();
    const current = marks.get(extensionId);
    if (current !== undefined && version <= current) return;
    marks.set(extensionId, version);
    const serialized = JSON.stringify(Object.fromEntries(marks));
    atomicWriteFile(this.filePath, serialized);
  }
}
