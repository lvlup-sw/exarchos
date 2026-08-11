// @oracle-sources: ./event-name.ts, the distinct `events.type` values read on 2026-08-10 from two
// real on-disk SQLite stores outside this repo (~/.claude/workflow-state/exarchos.db and
// ~/.exarchos/state/exarchos.db)
//
// DR-5 / task 075 — does collapsing the two event-name authorities orphan anything already written?
//
// The acceptance criterion this file exists for is the one most easily faked: "a replay of
// persisted streams". Two things are needed to make it real, and neither is a restatement of the
// other.
//
// 1. A CORPUS that came from persisted logs rather than from the catalog. `PERSISTED_EVENT_NAMES`
//    below is the distinct `type` column of the `events` table in the two stores this machine
//    actually accumulated — 12,890 rows, 79 distinct names, read read-only on 2026-08-10. It is a
//    pinned snapshot, and the snapshot is verifiable from the outside: it contains `init.executed`,
//    a name the live catalog does NOT declare, so it demonstrably was not copied from `EventTypes`.
//    A hand-picked sample of names that happen to also be built-ins would prove nothing.
//
// 2. A REPLAY, through the production read path, of a log containing names the surviving authority
//    refuses. That is the INV-1 claim the migration note makes ("history is safe, the future is
//    not") and it is stated here as behaviour: rows are written straight into a real SQLite backend
//    the way a previous version's appender left them, then read back through `EventStore.query`.
//    Its twin — that a NEW append of the same orphaned name fails — is asserted in the same case,
//    because "reads still work" is only interesting next to the thing that stopped working.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from './store.js';
import { SqliteBackend } from '../storage/sqlite-backend.js';
import { EventTypes, getValidEventTypes } from './schemas.js';
import { EVENT_NAME_PATTERN, classifyEventName, isWellFormedEventName } from './event-name.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

/**
 * Every distinct event name on disk in the two measured stores, sorted.
 *
 * Provenance: `SELECT DISTINCT type FROM events` over
 * `~/.claude/workflow-state/exarchos.db` (12,383 rows) and `~/.exarchos/state/exarchos.db`
 * (507 rows), read read-only on 2026-08-10 at the task-075 landing commit. These are names that
 * were EMITTED, not names that were declared — which is why this list and `EventTypes` are two
 * populations and not one.
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

/** The regex `schemas.ts` shipped until task 075. A subject, never a rule. */
const RETIRED_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

describe('EventNamePersistedReplay_MeasuredCorpus_SurvivesTheCollapse', () => {
  it('has a non-empty corpus that is not the catalog wearing another name', () => {
    // The non-empty-denominator rule, plus the independence claim the whole file rests on. Every
    // assertion below is vacuous over an empty corpus, and every one of them is a TAUTOLOGY over a
    // corpus copied out of `EventTypes` — which is the way this file would most plausibly be faked.
    expect(PERSISTED_EVENT_NAMES.length).toBeGreaterThan(0);

    const declared = new Set<string>(EventTypes);
    const persistedButUndeclared = PERSISTED_EVENT_NAMES.filter((name) => !declared.has(name));
    expect(persistedButUndeclared).toEqual(['init.executed']);
  });

  it('the surviving authority accepts every name ever written to these stores', () => {
    // The acceptance criterion, over persisted history rather than over the declared catalog. A
    // single failure here would mean the collapse orphaned a real, already-emitted name.
    const refused = PERSISTED_EVENT_NAMES.filter((name) => !isWellFormedEventName(name));
    expect(refused).toEqual([]);
  });

  it('the derived pattern agrees with the classifier over the same persisted corpus', () => {
    // Both FORMS of the one authority, over the population that matters most. If they ever disagree
    // the census's ratchet fires too, but this says so against real logs rather than the catalog.
    const disagreements = PERSISTED_EVENT_NAMES.filter(
      (name) => EVENT_NAME_PATTERN.test(name) !== isWellFormedEventName(name),
    );
    expect(disagreements).toEqual([]);
  });

  it('the repair is load-bearing for real history, not just for the catalog', () => {
    // The retired regex refused names that are ON DISK in quantity — `state.patched` is 745 rows,
    // `workflow.checkpoint_written` is 78. Had the collapse gone the other way (grammar narrowed to
    // the regex) these names would have stopped registering, which is the counterfactual that makes
    // the direction of the repair a decision rather than an accident.
    const refusedByRetired = PERSISTED_EVENT_NAMES.filter((name) => !RETIRED_PATTERN.test(name));
    expect(refusedByRetired.length).toBeGreaterThan(0);
    expect(refusedByRetired.filter((name) => !isWellFormedEventName(name))).toEqual([]);
    expect(refusedByRetired).toContain('workflow.checkpoint_written');
  });

  it('no persisted name carries a digit, a multi-word namespace or a fourth segment', () => {
    // The DR-5 evidence for the no-digits clause, measured against emitted history rather than
    // against the catalog the clause was derived from. Zero counterexamples in 79 names / 12,890
    // rows is what the clause was adopted on; this is where a future counterexample shows up.
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

  it('a log written under the retired rule reads back intact, while new appends of it fail', async () => {
    // INV-1, stated as behaviour. `my-app.deploy2` is a name the retired `EVENT_NAME_PATTERN`
    // admitted and the surviving grammar refuses — the exact user whose config the migration note
    // is written for. Rows are inserted through the backend the way a previous version's appender
    // left them, so this is a real historical log and not a mock.
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

      // Nothing dropped, nothing renamed, order preserved — the fold a projection would see.
      expect(replayed.map((event) => event.type)).toEqual(persisted.map((event) => event.type));
      expect(replayed.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(replayed[1]?.data).toEqual({ target: 'prod' });

      // And the twin, which is what makes the read-path claim mean something: the orphaned name is
      // not in the live registry, so a NEW append of it is refused at the envelope. History is
      // safe; the future is not.
      expect(getValidEventTypes()).not.toContain(orphaned);
      await expect(
        store.append('feat-legacy', { type: orphaned, data: { target: 'prod' } }),
      ).rejects.toThrow(/Unknown event type/);
    } finally {
      backend.close();
    }
  });
});
