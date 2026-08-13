// ─── Wave 1 (R-1, #1313): workflow.init writes workflow_type ─────────────
//
// Wave 1 lands the write-side of the Marten R-1 primitive: every stream
// gains a typed `workflow_type` column on the `streams` registry. This
// suite pins workflow.init's contract:
//   1.3 — INSERT writes the column from the workflowType arg
//   1.4 — handler rejects calls that omit workflowType
//   1.5/1.6 — migration backfill + observability event (covered in
//            event-migration.test.ts)
//
// The streams-registry write is intentionally a side effect of init (not a
// step in handleInit's main return path) — failing to register a stream is
// not fatal to the workflow.started event sequence, but absence of a
// streams row will silently exclude the workflow from the v2.12 filtered
// `ps` view (#1090). We pin the write here so a regression surfaces as a
// test failure rather than as a missing line in a future production query.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleInit } from './tools.js';
import { EventStore } from '../events/store.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

let tmpDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-init-wave1-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

/**
 * Open the SQLite DB the EventStore wrote to and read the streams table
 * directly. Bypasses the EventStore read API because that surface only
 * exposes events; the `streams` registry is a write-side primitive whose
 * read consumers (v2.12 filtered ps) are deferred.
 */
function readStreamsRows(): Array<{ streamId: string; workflow_type: string }> {
  const dbPath = path.join(tmpDir, 'exarchos.db');
  const db = new Database(dbPath);
  try {
    return db
      .prepare('SELECT streamId, workflow_type FROM streams ORDER BY streamId')
      .all() as Array<{ streamId: string; workflow_type: string }>;
  } finally {
    db.close();
  }
}

describe('exarchos_workflow.init — workflow_type column writes (Wave 1)', () => {
  it('WorkflowInit_WritesWorkflowTypeColumn', async () => {
    const featureId = 'feat-x';
    const result = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    // The streams registry row carries the workflow type we passed in —
    // not '__legacy', which is the migration-time backfill sentinel for
    // streams whose type can't be derived. A bare insert (no workflow_type
    // arg) would land '__legacy' via the column DEFAULT and silently
    // exclude this stream from any v2.12 type-filtered query.
    const rows = readStreamsRows();
    const target = rows.find((r) => r.streamId === featureId);
    expect(target).toBeDefined();
    expect(target!.workflow_type).toBe('feature');
  });

  it('WorkflowInit_RejectsCallWithoutWorkflowType', async () => {
    // Calls bypassing the MCP boundary (e.g. internal helpers, future
    // CLI direct invocations) can land in handleInit with workflowType
    // missing. Today the call surfaces as STATE_CORRUPT from the state
    // schema, which is the wrong error code: STATE_CORRUPT signals a
    // corrupt state file at rest, not a malformed input. R-1 (#1313)
    // demands an explicit INVALID_INPUT at the handler boundary so the
    // caller's auto-correction loop has a single, unambiguous signal.

    // Cast through unknown to bypass TS — the runtime guard is the
    // contract under test.
    const result = await handleInit(
      { featureId: 'feat-no-type' } as unknown as Parameters<typeof handleInit>[0],
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });
});
