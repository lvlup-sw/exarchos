// ─── Anti-rollback version ledger (P03-08) ────────────────────────────────
//
// Anti-rollback needs durable memory: the highest version ever *admitted* for
// each extension identity. Admission rejects any manifest whose version is
// below that high-water mark, so a signed-but-older build cannot replace a
// newer one that was already accepted (a downgrade attack). The ledger is
// monotonic — `recordAdmitted` only ever raises the recorded version.
//
// A corrupt persisted ledger fails closed (the load throws) rather than
// silently resetting to empty: silently forgetting the high-water mark would
// re-open exactly the downgrade window the ledger exists to close.

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteFile } from '../utils/atomic-write.js';

/** Durable high-water mark of admitted versions, keyed by extension identity. */
export interface VersionLedger {
  /** Highest version ever admitted for `extensionId`, or `undefined` if none. */
  highestAdmitted(extensionId: string): Promise<number | undefined>;
  /** Record `version` as admitted; only raises the stored high-water mark. */
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
 * File-backed ledger persisting the high-water marks as JSON so the anti-
 * rollback boundary survives process restarts. Reads the file on every call so
 * an out-of-band update is observed; writes go through the repository's atomic
 * temp+fsync+rename primitive so a crash never leaves a torn ledger.
 *
 * A single owning writer is assumed (as with the repository's other atomic-file
 * callers): cross-process write ordering is out of scope.
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
    // A parse or shape failure throws — a corrupt ledger must fail closed
    // rather than silently drop the anti-rollback high-water marks.
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
