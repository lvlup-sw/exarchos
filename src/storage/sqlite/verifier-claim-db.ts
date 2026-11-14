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

/** Supply only the SQL and transaction primitives required by the claim owner. */
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
  return {
    initialize(sql: string): void { db.exec(sql); },
    one(sql: string, ...values: string[]): unknown { return db.query(sql).get(...values); },
    change(sql: string, ...values: string[]): number { return db.query(sql).run(...values).changes; },
    immediate<T>(perform: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = perform();
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close(): void { db.close(); },
  };
}
