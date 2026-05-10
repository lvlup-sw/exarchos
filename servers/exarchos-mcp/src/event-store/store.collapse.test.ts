/**
 * Phase 3 (Store Collapse, v2.11 substrate-cut) RED guard tests.
 *
 * These tests assert that the JSONL read-path machinery is fully removed
 * from `EventStore`:
 *   - `EventStoreOptions` no longer carries an `appenderBackend` selector
 *     (legacy substrate switch — single SQLite path now).
 *   - `queryMainJsonl`, `getEventFilePath`, `getSeqFilePath` are not
 *     present as methods on `EventStore` instances.
 *   - `getReadBackend()` always returns the SqliteBackend — no
 *     `return undefined` short-circuit (Sentry blocker r3213774862 from
 *     #1323: lazy `appenderBackend: 'sqlite'` read-before-write returning
 *     `[]`).
 *
 * This file is intentionally short-lived. Per the Phase 3 plan, it is
 * deleted in T3.5 once GREEN — the codebase state is the contract.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from './store.js';
import type { EventStoreOptions } from './store.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'phase3-collapse-'));
}

describe('Phase 3 store collapse — option/method removals', () => {
  it('EventStoreOptions does not include appenderBackend; constructor stores no such field (T3.1)', () => {
    // Runtime structural probe: after the collapse the constructor no
    // longer assigns `this.appenderBackend = options?.appenderBackend`,
    // so the property is not present on the instance even when the
    // caller passes the (now type-error) option.
    const dir = freshDir();
    // Cast to bypass the post-collapse type so the runtime assertion
    // remains meaningful — pre-collapse this was a real option, so
    // both values used to round-trip through the field.
    const store = new EventStore(dir, { appenderBackend: 'sqlite' } as unknown as EventStoreOptions);
    const ownKeys = Object.keys(store);
    expect(ownKeys).not.toContain('appenderBackend');
  });

  it('EventStore no longer exposes queryMainJsonl / getEventFilePath / getSeqFilePath (T3.2)', () => {
    const dir = freshDir();
    const store = new EventStore(dir);
    // Use a structural probe that survives both `private` (compiled away)
    // and `delete`-style removals. After Phase 3 these names should not
    // exist anywhere on the prototype chain.
    const proto = Object.getPrototypeOf(store);
    expect('queryMainJsonl' in proto).toBe(false);
    expect('getEventFilePath' in proto).toBe(false);
    expect('getSeqFilePath' in proto).toBe(false);
    expect('readJsonlMaxSequence' in proto).toBe(false);
    expect('readSidecarForQuery' in proto).toBe(false);
  });

  it('getReadBackend always returns the SqliteBackend, no undefined branch (T3.3)', async () => {
    const dir = freshDir();
    const store = new EventStore(dir);
    // Structural source-level probe: the collapsed body must not contain
    // `return undefined` — even commented branches are flagged so the
    // collapse really is a single-line return.
    type GetReadBackendBearer = { getReadBackend(): unknown };
    const sourced = store as unknown as GetReadBackendBearer;
    const fnSrc = sourced.getReadBackend.toString();
    expect(/return\s+undefined/.test(fnSrc)).toBe(false);

    // Behavioural assertion: even on a freshly-constructed store with no
    // explicit backend wired and no append yet, getReadBackend yields a
    // non-undefined backend (Sentry r3213774862 — lazy read-before-write).
    const result = sourced.getReadBackend();
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
  });
});
