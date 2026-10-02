// Tests that `handleInit` writes the `workflow_type` column of the `streams` registry from its
// `workflowType` argument, and that it rejects a call without `workflowType`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleInit } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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

/** Read the `streams` table straight from the SQLite file, because the `EventStore` read API returns only events. */
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
  /** The row must carry the passed type, not the `__legacy` column default that a bare insert gets. */
  it('WorkflowInit_WritesWorkflowTypeColumn', async () => {
    const featureId = 'feat-x';
    const result = await handleInit(
      { featureId, workflowType: 'feature' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const rows = readStreamsRows();
    const target = rows.find((r) => r.streamId === featureId);
    expect(target).toBeDefined();
    expect(target!.workflow_type).toBe('feature');
  });

  /**
   * A call that skips the MCP boundary can omit `workflowType`. The handler must return `INVALID_INPUT`.
   * `STATE_CORRUPT` is wrong here, because it means a corrupt state file. The cast skips the type check on purpose.
   */
  it('WorkflowInit_RejectsCallWithoutWorkflowType', async () => {
    const result = await handleInit(
      { featureId: 'feat-no-type' } as unknown as Parameters<typeof handleInit>[0],
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });
});
