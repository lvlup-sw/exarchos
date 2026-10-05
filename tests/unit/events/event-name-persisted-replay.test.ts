// @oracle-sources: ../../../src/events/event-name.ts, the distinct `events.type` values read on 2026-08-10 from two
// real on-disk SQLite stores outside this repo (~/.claude/workflow-state/exarchos.db and
// ~/.exarchos/state/exarchos.db)
//
// These tests ask one question: does one event-name authority orphan a name that is already on disk?
//
// The corpus comes from persisted logs and not from the catalog. `PERSISTED_EVENT_NAMES` is the
// distinct `type` column of the `events` table in two real stores, read on 2026-08-10. It holds
// `init.executed`, which the live catalog does not declare, so it is not a copy of `EventTypes`.
//
// The replay goes through the production read path. The test writes rows into a real SQLite
// backend, with a name that the grammar refuses, and reads them back through `EventStore.query`.
// The same case asserts that a new append of that name fails.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../../src/events/store.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { EventTypes, getValidEventTypes } from '../../../src/events/schemas.js';
import { EVENT_NAME_PATTERN, classifyEventName, isWellFormedEventName } from '../../../src/events/event-name.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Each distinct event name on disk in the two measured stores, sorted.
 *
 * Provenance: `SELECT DISTINCT type FROM events` over `~/.claude/workflow-state/exarchos.db`
 * (12,383 rows) and `~/.exarchos/state/exarchos.db` (507 rows), read on 2026-08-10.
 * The stores hold emitted names and not declared names, so this list and `EventTypes` are two
 * populations.
 */
const PERSISTED_EVENT_NAMES: readonly string[] = [
  'checkpoint.enforced',
  'ci.status',
  'diagnostic.executed',
  'dispatch.classified',
  'dispatch.preflight',
  'elicitation.declined',
  'elicitation.requested',
  'export.executed',
  'export.requested',
  'feedback.recorded',
  'gate.executed',
  'init.executed',
  'invariant.amended',
  'invariant.authored',
  'issue.create.executed',
  'issue.create.requested',
  'issue.created',
  'merge.completed',
  'merge.preflight',
  'migration.completed',
  'migration.correlation_backfill_progress',
  'migration.legacy_jsonl_imported',
  'migration.workflow_type_unknown',
  'mutation.executed',
  'mutation.executing_started',
  'onboard.executed',
  'onboard.requested',
  'phase.entered',
  'phase.exited',
  'pr.comment.executed',
  'pr.comment.requested',
  'pr.create.executed',
  'pr.create.requested',
  'pr.merged',
  'preflight.blocked',
  'preflight.executed',
  'provider.unknown-tier',
  'remediation.attempted',
  'remediation.succeeded',
  'review.completed',
  'session.machinery_consumed',
  'shepherd.approval_requested',
  'shepherd.completed',
  'shepherd.iteration',
  'shepherd.started',
  'stack.submitted',
  'stash.detected',
  'state.patched',
  'subagent.tokens_used',
  'synthesize.requested',
  'task.assigned',
  'task.completed',
  'task.failed',
  'task.progressed',
  'team.disbanded',
  'team.spawned',
  'team.task.completed',
  'team.task.planned',
  'team.teammate.dispatched',
  'tool.action_errored',
  'tool.completed',
  'tool.invoked',
  'workflow.cancel',
  'workflow.checkpoint',
  'workflow.checkpoint_written',
  'workflow.cleanup',
  'workflow.compensation',
  'workflow.compound-entry',
  'workflow.compound-exit',
  'workflow.fix-cycle',
  'workflow.guard-failed',
  'workflow.plan-review-dispatched',
  'workflow.plan-revision',
  'workflow.rehydrated',
  'workflow.started',
  'workflow.transition',
  'workspace.resolved',
  'worktree.baseline',
  'worktree.created',
];

/** The retired event-name regex of `schemas.ts`. The tests use it as a subject and not as a rule. */
const RETIRED_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

describe('EventNamePersistedReplay_MeasuredCorpus_SurvivesTheCollapse', () => {
  /**
   * Each assertion in this suite is vacuous over an empty corpus and a tautology over a copy of
   * `EventTypes`. The corpus must hold exactly one name that the catalog does not declare.
   */
  it('has a non-empty corpus that is not the catalog wearing another name', () => {
    expect(PERSISTED_EVENT_NAMES.length).toBeGreaterThan(0);

    const declared = new Set<string>(EventTypes);
    const persistedButUndeclared = PERSISTED_EVENT_NAMES.filter((name) => !declared.has(name));
    expect(persistedButUndeclared).toEqual(['init.executed']);
  });

  /**
   * The grammar must accept each name in persisted history. A failure means that a real emitted
   * name is an orphan.
   */
  it('the surviving authority accepts every name ever written to these stores', () => {
    const refused = PERSISTED_EVENT_NAMES.filter((name) => !isWellFormedEventName(name));
    expect(refused).toEqual([]);
  });

  /**
   * The derived pattern and the classifier are two forms of one authority. They must agree over
   * the persisted corpus.
   */
  it('the derived pattern agrees with the classifier over the same persisted corpus', () => {
    const disagreements = PERSISTED_EVENT_NAMES.filter(
      (name) => EVENT_NAME_PATTERN.test(name) !== isWellFormedEventName(name),
    );
    expect(disagreements).toEqual([]);
  });

  /**
   * The retired regex refuses names that are on disk, and `workflow.checkpoint_written` is one.
   * A grammar narrowed to that regex stops their registration.
   */
  it('the repair is load-bearing for real history, not just for the catalog', () => {
    const refusedByRetired = PERSISTED_EVENT_NAMES.filter((name) => !RETIRED_PATTERN.test(name));
    expect(refusedByRetired.length).toBeGreaterThan(0);
    expect(refusedByRetired.filter((name) => !isWellFormedEventName(name))).toEqual([]);
    expect(refusedByRetired).toContain('workflow.checkpoint_written');
  });

  /**
   * Evidence for the no-digits clause, measured against emitted history. A later counterexample
   * fails here.
   */
  it('no persisted name carries a digit, a multi-word namespace or a fourth segment', () => {
    expect(PERSISTED_EVENT_NAMES.filter((name) => /[0-9]/.test(name))).toEqual([]);
    expect(
      PERSISTED_EVENT_NAMES.filter((name) => /[-_]/.test(name.split('.')[0] ?? '')),
    ).toEqual([]);
    expect(PERSISTED_EVENT_NAMES.filter((name) => name.split('.').length > 3)).toEqual([]);
  });
});

describe('EventNamePersistedReplay_OrphanedName_StillReplays', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'event-name-replay-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /**
   * The retired regex admits `my-app.deploy2` and the grammar refuses it. The test inserts rows
   * through the backend, as an earlier appender left them, and replays them through
   * `EventStore.query`. The replay must keep each row, each name and the order.
   * The name is not in the live registry, so a new append of it must fail at the envelope.
   */
  it('a log written under the retired rule reads back intact, while new appends of it fail', async () => {
    const orphaned = 'my-app.deploy2';
    expect(RETIRED_PATTERN.test(orphaned)).toBe(true);
    expect(classifyEventName(orphaned).ok).toBe(false);

    const backend = new SqliteBackend(path.join(tempDir, 'exarchos.db'));
    backend.initialize();
    try {
      const persisted = [
        { type: 'workflow.started', data: { featureId: 'feat-legacy' } },
        { type: orphaned, data: { target: 'prod' } },
        { type: 'deploy.rollback_started', data: { target: 'prod' } },
      ];
      persisted.forEach((event, index) => {
        backend.appendEvent('feat-legacy', {
          streamId: 'feat-legacy',
          sequence: index + 1,
          type: event.type,
          timestamp: `2026-01-0${String(index + 1)}T00:00:00.000Z`,
          data: event.data,
        });
      });

      const store = new EventStore(tempDir, { backend });
      const replayed = await store.query('feat-legacy');

      expect(replayed.map((event) => event.type)).toEqual(persisted.map((event) => event.type));
      expect(replayed.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(replayed[1]?.data).toEqual({ target: 'prod' });

      expect(getValidEventTypes()).not.toContain(orphaned);
      await expect(
        store.append('feat-legacy', { type: orphaned, data: { target: 'prod' } }),
      ).rejects.toThrow(/Unknown event type/);
    } finally {
      backend.close();
    }
  });
});
