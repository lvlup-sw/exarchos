/**
 * The registry of SQLite connections that the test shim has open.
 *
 * The set lives on `globalThis`, so every evaluated copy of the shim shares it.
 * This module imports nothing. A test helper can read the registry without
 * loading the native driver in a tier that never opens a database.
 */

/** The part of a connection that the registry and its readers use. */
export interface TrackedDatabase {
  /** The database file as the connection opened it. */
  readonly name: string;
  /** False after the connection has closed. */
  readonly open: boolean;
  /** Closes the connection. It throws when the driver refuses. */
  close(): unknown;
}

declare global {
  var __exarchosOpenSqliteDatabases: Set<TrackedDatabase> | undefined;
}

/**
 * The connections that are open now. The shim adds a connection when it opens
 * and removes it only after its close succeeds.
 */
export function trackedDatabases(): Set<TrackedDatabase> {
  return (globalThis.__exarchosOpenSqliteDatabases ??= new Set<TrackedDatabase>());
}
