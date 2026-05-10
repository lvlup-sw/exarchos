// ─── Phase 1 Sidecar Removal Guard (#1082) ──────────────────────────────────
//
// Structural guard for the v2.11 substrate-cut Phase 1 deletion. The PID-lock
// "sidecar mode" introduced for #1082 only existed because JSONL writers had
// to side-channel around the EventStore's per-process lock. Post the v2.10
// SQLite substrate flip (#1323), SQLite WAL handles concurrent access
// natively — sidecar mode is dead by construction.
//
// This file is intentionally a structural smoke test: it asserts that the
// symbols listed below are gone from the production surface area. It is
// deleted in T1.3 (REFACTOR) once the codebase shape itself is the proof.

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as storeModule from './store.js';
import * as hookWriterModule from './hook-event-writer.js';
import { EventStore } from './store.js';

describe('Phase 1 sidecar removal — module-level exports', () => {
  it('hook-event-writer.ts no longer exports getSidecarPath', () => {
    // `getSidecarPath` was the lookup helper used by EventStore's sidecar
    // merge path. With the merge path deleted, the helper has no remaining
    // public consumers and must not be re-exported.
    expect((hookWriterModule as Record<string, unknown>).getSidecarPath).toBeUndefined();
  });

  it('store.ts no longer exports an enterSidecarMode helper', () => {
    expect((storeModule as Record<string, unknown>).enterSidecarMode).toBeUndefined();
  });
});

describe('Phase 1 sidecar removal — EventStore instance shape', () => {
  it('EventStore instances do not expose isInSidecarMode / inSidecarMode', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase1-sidecar-removal-'));
    try {
      const store = new EventStore(tempDir);
      const asAny = store as unknown as Record<string, unknown>;
      expect(asAny.inSidecarMode).toBeUndefined();
      expect(asAny.isInSidecarMode).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('EventStore instances do not carry a sidecarMode field', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase1-sidecar-removal-'));
    try {
      const store = new EventStore(tempDir);
      // The field was a private boolean; check both own-property and the
      // prototype chain so the assertion catches accidental migrations to
      // either site.
      const asAny = store as unknown as Record<string, unknown>;
      const ownProps = Object.getOwnPropertyNames(asAny);
      expect(ownProps).not.toContain('sidecarMode');
      expect(asAny.sidecarMode).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('EventStore prototype does not carry writeToSidecar / writeSidecar', () => {
    const proto = EventStore.prototype as unknown as Record<string, unknown>;
    expect(proto.writeToSidecar).toBeUndefined();
    expect(proto.writeSidecar).toBeUndefined();
    expect(proto.readSidecarForQuery).toBeUndefined();
  });
});
