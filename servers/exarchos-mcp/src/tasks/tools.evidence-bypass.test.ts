// ─── DR-2: the governed cannot supply its own governance ────────────────────
//
// CHARACTERIZATION (pre-change, captured deliberately before the fix).
//
// `handleTaskComplete` accepts an `evidence` object FROM THE AGENT BEING
// GOVERNED and, when `evidence.passed === true` with substantive output,
// short-circuits gate enforcement entirely. The single gate it enforces is
// `static-analysis`, which the registry declares
// `gate: { blocking: true, gateClass: 'static-analysis' }` — so the bypass
// currently lets a caller satisfy a BLOCKING gate by asserting its own
// compliance.
//
// These cases pin the CURRENT behaviour exactly. They are rewritten into the
// post-fix contract in the same file (see the DR-2 describe block below) once
// the hole is closed, so the delta is legible in review.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../event-store/store.js';
import { handleTaskComplete, resetModuleEventStore } from './tools.js';
import { resetMaterializerCache } from '../views/tools.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

let tempDir: string;

beforeEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  tempDir = await mkdtemp(path.join(tmpdir(), 'evidence-bypass-'));
});

afterEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  await rmrfAsync(tempDir);
});

async function seededStore(streamId: string, taskId: string): Promise<EventStore> {
  const store = new EventStore(tempDir);
  await store.append(streamId, {
    type: 'task.assigned',
    data: { taskId, title: 'Evidence bypass subject', assignee: 'agent-1' },
  });
  return store;
}

describe('CHARACTERIZATION: evidence bypass (pre-DR-2)', () => {
  it('Characterization_CallerEvidencePassedTrue_SatisfiesStaticAnalysisGate', async () => {
    // GIVEN no gate.executed event at all — nothing ever ran the gate.
    const store = await seededStore('char-bypass', 'T-01');

    const result = await handleTaskComplete(
      {
        taskId: 'T-01',
        streamId: 'char-bypass',
        evidence: { type: 'test', output: '5727 tests passed', passed: true },
      },
      tempDir,
      store,
    );

    // THEN the caller's own assertion stands in for the blocking gate.
    expect(result.success).toBe(true);
  });

  it('Characterization_CallerEvidenceEmptyOutput_DoesNotSatisfyGate', async () => {
    const store = await seededStore('char-empty', 'T-01');

    const result = await handleTaskComplete(
      {
        taskId: 'T-01',
        streamId: 'char-empty',
        evidence: { type: 'test', output: '   \t\n ', passed: true },
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  it('Characterization_CallerEvidencePassedFalse_DoesNotSatisfyGate', async () => {
    const store = await seededStore('char-failed', 'T-01');

    const result = await handleTaskComplete(
      {
        taskId: 'T-01',
        streamId: 'char-failed',
        evidence: { type: 'manual', output: 'did not pass', passed: false },
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });
});
