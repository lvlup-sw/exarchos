/**
 * Phase 2 collapse guard (v2.11 substrate-cut, plan T2.1 / T2.3 / T2.4).
 *
 * Asserts the dual-substrate machinery is gone:
 *   - `AtomicAppenderOptions` no longer carries the `backend` discriminator.
 *   - `appendLocked` (the JSONL primary body) is no longer present on the
 *     `AtomicAppender` prototype.
 *   - `EventStore` no longer exposes `replicateBackend` / `writeOutbox`
 *     dual-write methods (T2.3).
 *   - `getSqliteBackend()` is the productionized public name (T2.4) — the
 *     `_testOnly_` prefix is gone, and `EventStore.getReadBackend()` reaches
 *     for the SQLite handle via that public name.
 *
 * These are structural / type-shape guards that have no behavioural
 * counterpart — deletion work is by definition the absence of code paths,
 * so symbol-presence assertions are the natural fit. The guard file is
 * deleted at the end of Phase 2 (T2.6) — its purpose is satisfied once
 * the rip lands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';
import type { AtomicAppenderOptions } from './atomic-appender.js';
import { EventStore } from './store.js';

describe('Phase 2 collapse guard', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'phase2-collapse-guard-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  // ─── T2.1: backend constructor option removed ────────────────────────────
  it('AtomicAppenderOptions has no `backend` property', () => {
    // Compile-time assertion: a candidate type that *includes* `backend`
    // must not be assignable to `AtomicAppenderOptions`. If `backend` is
    // still part of the options type the assignment compiles and this
    // guard fails at type-check time.
    type _NoBackend = {
      [K in keyof AtomicAppenderOptions]: K extends 'backend' ? never : AtomicAppenderOptions[K];
    };
    // Should be no-op; if `backend` is still present, the conditional
    // type collapses to `never` for that key — the guard fails to
    // compile.
    const _check: _NoBackend = {} as AtomicAppenderOptions;
    void _check;

    // Runtime witness: constructing without `backend` succeeds and the
    // shape of the resulting object does not expose a `backend` field.
    const appender = new AtomicAppender({ stateDir });
    expect(appender).toBeInstanceOf(AtomicAppender);
    expect(Object.keys(appender)).not.toContain('backend');
  });

  // ─── T2.2: appendLocked JSONL body removed ───────────────────────────────
  it('AtomicAppender prototype has no `appendLocked` method', () => {
    const proto = Object.getPrototypeOf(new AtomicAppender({ stateDir })) as object;
    const propertyNames = Object.getOwnPropertyNames(proto);
    expect(propertyNames).not.toContain('appendLocked');
    expect(propertyNames).not.toContain('rebuildCachesFromJsonl');
    expect(propertyNames).not.toContain('rollbackJsonlAppend');
  });

  // ─── T2.2: SQLite-only writes — no JSONL artifact appears on append ──────
  it('append() writes only to SQLite — no `*.events.jsonl` artifact', async () => {
    const appender = new AtomicAppender({ stateDir });
    const result = await appender.append(
      'guard-stream',
      [{ type: 'task.assigned', data: { n: 1 } }],
      'guard-key',
    );
    expect(result.ok).toBe(true);

    const entries = await readdir(stateDir);
    // SQLite body writes `<filename>.db` (default `exarchos.db`) — never
    // a JSONL artifact.
    expect(entries.some((e) => e.endsWith('.events.jsonl'))).toBe(false);
    expect(entries.some((e) => e.endsWith('.seq'))).toBe(false);
    expect(entries.some((e) => e.endsWith('.db'))).toBe(true);
  });

  // ─── T2.3: replicateBackend / writeOutbox / setOutbox removed ───────────
  it('EventStore prototype has no replicateBackend / writeOutbox / setOutbox', () => {
    const proto = EventStore.prototype as unknown as Record<string, unknown>;
    const propertyNames = Object.getOwnPropertyNames(proto);
    expect(propertyNames).not.toContain('replicateBackend');
    expect(propertyNames).not.toContain('writeOutbox');
    expect(propertyNames).not.toContain('setOutbox');
  });

  it('append does not write any *.outbox.json sidecar', async () => {
    const store = new EventStore(stateDir);
    await store.initialize();
    await store.append('guard-stream', {
      type: 'workflow.started',
      data: { featureId: 'guard' },
    });
    const entries = await readdir(stateDir);
    expect(entries.some((e) => e.endsWith('.outbox.json'))).toBe(false);
  });

  // ─── T2.4: getSqliteBackend productionized ───────────────────────────────
  it('AtomicAppender exports `getSqliteBackend` (no _testOnly_ prefix)', async () => {
    const appender = new AtomicAppender({ stateDir });
    const proto = Object.getPrototypeOf(appender) as object;
    const propertyNames = Object.getOwnPropertyNames(proto);
    expect(propertyNames).toContain('getSqliteBackend');
    expect(propertyNames).not.toContain('_testOnly_getSqliteBackend');

    // After an append the backend is initialized; `getSqliteBackend`
    // returns the live handle.
    await appender.append(
      'guard-stream-2',
      [{ type: 'task.assigned' }],
      'guard-key-2',
    );
    const a = appender as unknown as { getSqliteBackend: () => unknown };
    expect(a.getSqliteBackend).toBeTypeOf('function');
    expect(a.getSqliteBackend()).toBeDefined();
  });
});
