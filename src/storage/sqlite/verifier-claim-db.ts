/** Store verifier claims in a private database independent of the governor. */
import { Database } from 'bun:sqlite';
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/** Check the database and any existing sidecar before opening the driver. */
function checkPrivateFile(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) {
    throw new Error('Unsafe private claim database file');
  }
}

/** The stored columns of one claim row. */
export interface StoredClaimRow {
  readonly digest: unknown;
  readonly request: unknown;
  readonly terminal: unknown;
}

/**
 * The outcome of one claim acquisition. A row with the same key is `existing`. A claim with the same operation is `operation-taken`.
 * A leased resource is `busy`. Otherwise the claim and its leases are written, and the outcome is `acquired`.
 */
export type ClaimAcquisition =
  | { readonly kind: 'existing'; readonly row: StoredClaimRow }
  | { readonly kind: 'operation-taken' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'acquired' };

/** The fields of one new claim: its key, its operation, the digest and the text of its request. */
export interface NewClaim {
  readonly key: string;
  readonly operation: string;
  readonly digest: string;
  readonly request: string;
}

/**
 * Supply the claim reads and the two atomic claim writes. Each write runs in one immediate transaction of this module,
 * so the transaction primitive stays in the storage substrate.
 * `claimRow` gives the stored row of one key, or undefined. `acquire` writes one claim and its leases, unless the key, the operation or a resource is held.
 * `complete` stores the terminal text of one incomplete claim and releases its leases. It throws when no incomplete claim has that key and digest.
 */
export function openVerifierClaimDb(stateDir: string) {
  const path = join(stateDir, 'verifier.sqlite');
  const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try { checkPrivateFile(fstatSync(descriptor)); }
  finally { closeSync(descriptor); }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { checkPrivateFile(lstatSync(path + suffix)); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  const db = new Database(path);
  try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;'); }
  catch (error) { db.close(); throw error; }
  const one = (sql: string, ...values: string[]): unknown => db.query(sql).get(...values);
  const change = (sql: string, ...values: string[]): number => db.query(sql).run(...values).changes;
  const immediate = <T>(perform: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = perform();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const claimRow = (key: string): StoredClaimRow | undefined => {
    const raw = one('SELECT digest,request,terminal FROM claims WHERE key=?', key);
    if (typeof raw !== 'object' || raw === null) return undefined;
    return { digest: Reflect.get(raw, 'digest'), request: Reflect.get(raw, 'request'), terminal: Reflect.get(raw, 'terminal') };
  };
  return {
    initialize(sql: string): void { db.exec(sql); },
    claimRow,
    acquire(claim: NewClaim, resources: readonly string[]): ClaimAcquisition {
      return immediate((): ClaimAcquisition => {
        const row = claimRow(claim.key);
        if (row !== undefined) return { kind: 'existing', row };
        if (one('SELECT key FROM claims WHERE operation=?', claim.operation)) return { kind: 'operation-taken' };
        for (const resource of resources) {
          if (one('SELECT owner FROM leases WHERE resource=?', resource)) return { kind: 'busy' };
        }
        change('INSERT INTO claims(key,operation,digest,request,terminal) VALUES(?,?,?,?,NULL)', claim.key, claim.operation, claim.digest, claim.request);
        for (const resource of resources) change('INSERT INTO leases(resource,owner) VALUES(?,?)', resource, claim.key);
        return { kind: 'acquired' };
      });
    },
    complete(key: string, digest: string, terminal: string): void {
      immediate(() => {
        if (change('UPDATE claims SET terminal=? WHERE key=? AND digest=? AND terminal IS NULL', terminal, key, digest) !== 1) {
          throw new Error('Original claim changed before completion');
        }
        change('DELETE FROM leases WHERE owner=?', key);
      });
    },
    close(): void { db.close(); },
  };
}
