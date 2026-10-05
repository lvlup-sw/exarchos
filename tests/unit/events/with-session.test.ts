/**
 * `withSession` gives the closure a session with the folded `aggregate`, the
 * tail `version` and `append`. The queued events commit when the closure resolves.
 *
 * A call with no `operationId` and no `allowNonIdempotent: true` fails with
 * INVALID_SESSION_OPTIONS. Without this gate, a retry after a `ConcurrencyError`
 * can repeat the side effects of the closure with no consent from the caller.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { EventStore } from '../../../src/events/store.js';
import {
  InvalidSessionOptionsError,
  SessionClosedError,
} from '../../../src/events/session-errors.js';
import {
  createRegistry,
  type ProjectionRegistry,
} from '../../../src/projections/registry.js';
import { makeFixtureReducer, seedStream, type FixtureState } from '../../helpers/decide-fixtures.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('withSession<TState> — happy path (Task 3.8)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/with-session-happy';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'with-session-test-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
    registry.register(
      makeFixtureReducer('fixture@v1', 'stream') as unknown as Parameters<
        typeof registry.register
      >[0],
    );
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('WithSession_CommitsAppendedEventsOnResolve', async () => {
    await seedStream(eventStore, streamId, 3);

    const result = await appender.withSession<FixtureState>(
      streamId,
      'fixture@v1',
      async session => {
        expect(session.aggregate.count).toBe(3);
        expect(session.version).toBe(3);
        session.append({ type: 'task.assigned', data: { taskId: 'T-a' } });
        session.append({ type: 'task.completed', data: { taskId: 'T-a' } });
      },
      { registry, operationId: 'op-test' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequences).toEqual([4, 5]);

    const events = await eventStore.query(streamId);
    expect(events).toHaveLength(5);
    expect(events[3].type).toBe('task.assigned');
    expect(events[4].type).toBe('task.completed');
  });

  it('WithSession_AcceptsAllowNonIdempotentOptOut', async () => {
    const result = await appender.withSession<FixtureState>(
      streamId,
      'fixture@v1',
      async session => {
        session.append({ type: 'task.assigned', data: { taskId: 'T-1' } });
      },
      { registry, allowNonIdempotent: true },
    );
    expect(result.ok).toBe(true);
  });
});

describe('withSession — idempotency-contract gate (Task 3.8a, audit §F1.1)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/with-session-gate';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'with-session-gate-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
    registry.register(
      makeFixtureReducer('fixture@v1', 'stream') as unknown as Parameters<
        typeof registry.register
      >[0],
    );
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /** The suggested fix must name `decide` and `allowNonIdempotent`. */
  it('WithSession_RejectsCall_WhenOperationIdAndAllowNonIdempotentBothOmitted', async () => {
    await expect(
      appender.withSession<FixtureState>(
        streamId,
        'fixture@v1',
        async session => {
          session.append({ type: 'task.assigned' });
        },
        { registry },
      ),
    ).rejects.toBeInstanceOf(InvalidSessionOptionsError);

    try {
      await appender.withSession<FixtureState>(
        streamId,
        'fixture@v1',
        async session => {
          session.append({ type: 'task.assigned' });
        },
        { registry },
      );
      expect.fail('withSession should have thrown InvalidSessionOptionsError');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSessionOptionsError);
      const e = err as InvalidSessionOptionsError;
      expect(e.code).toBe('INVALID_SESSION_OPTIONS');
      const fix = JSON.stringify(e.suggestedFix).toLowerCase();
      expect(fix).toMatch(/decide/);
      expect(fix).toMatch(/allownonidempotent/);
    }
  });

  it('WithSession_AllowsCall_WhenAllowNonIdempotentExplicitlyTrue', async () => {
    const result = await appender.withSession<FixtureState>(
      streamId,
      'fixture@v1',
      async session => {
        session.append({ type: 'task.assigned', data: { taskId: 'T-x' } });
      },
      { registry, allowNonIdempotent: true },
    );
    expect(result.ok).toBe(true);
  });
});

describe('withSession — rolls back on thrown error (Task 3.9)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/with-session-throw';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'with-session-throw-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
    registry.register(
      makeFixtureReducer('fixture@v1', 'stream') as unknown as Parameters<
        typeof registry.register
      >[0],
    );
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('WithSession_DoesNotCommit_WhenInnerFunctionThrows', async () => {
    await seedStream(eventStore, streamId, 2);

    const sentinel = new Error('handler exploded after queueing one event');
    await expect(
      appender.withSession<FixtureState>(
        streamId,
        'fixture@v1',
        async session => {
          session.append({ type: 'task.assigned', data: { taskId: 'T-x' } });
          throw sentinel;
        },
        { registry, operationId: 'op-throw' },
      ),
    ).rejects.toBe(sentinel);

    const events = await eventStore.query(streamId);
    expect(events).toHaveLength(2);
  });
});

describe('withSession — closes after resolve (Task 3.10)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/with-session-closed';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'with-session-closed-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
    registry.register(
      makeFixtureReducer('fixture@v1', 'stream') as unknown as Parameters<
        typeof registry.register
      >[0],
    );
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('Session_ThrowsSessionClosed_WhenAppendedAfterResolve', async () => {
    let captured: { append: (evt: { type: string }) => void } | undefined;

    await appender.withSession<FixtureState>(
      streamId,
      'fixture@v1',
      async session => {
        captured = session;
        session.append({ type: 'task.assigned', data: { taskId: 'T-pre' } });
      },
      { registry, operationId: 'op-closed' },
    );

    expect(captured).toBeDefined();
    if (!captured) return;

    expect(() => captured!.append({ type: 'task.assigned' })).toThrow(
      SessionClosedError,
    );

    try {
      captured!.append({ type: 'task.assigned' });
      expect.fail('append after resolve must throw SessionClosedError');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionClosedError);
      const sce = err as SessionClosedError;
      expect(sce.code).toBe('SESSION_CLOSED');
      expect(sce.message).toMatch(/SESSION_CLOSED/);
    }
  });
});
