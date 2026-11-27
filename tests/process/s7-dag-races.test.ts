/** Packaged standing races use original claims and stopped owned processes.
 * The fixture compiles compiler 8-vcs and lands each task branch before the settle, so each accepting settle also binds one integration attempt at the tip.
 * @oracle-sources: SQLite original claim arrays, immutable bundle bytes, real Node assertion probes and Git argv.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { data, record } from '../helpers/capsule/s6-process-race.js';
import { rowsOf, barrierFor, journalOf, startSettle, string, withS7Repository } from '../helpers/capsule/s7-process-race.js';

const TIMEOUT = 120_000;

describe('packaged S7 DAG races', () => {
  /** Earlier-segment refresh observes lost authentic membership. The clean twin accepts both tasks. */
  it('Process_StandingChangesAfterSegment_RefusesMove', async () => {
    for (const remove of [false, true]) await withS7Repository(async f => {
      const barrier = await barrierFor(f, 'T-02', 'standing'); const process = startSettle(f, barrier.env);
      try {
        const ready = await barrier.wait(process.done);
        const terminal = record(ready.terminal); const operation = record(ready.operation);
        expect(terminal.data).toMatchObject({ operationId: operation.idempotencyKey, outcome: 'committed' });
        expect((await journalOf(f)).every(row => row.tree !== f.trees.get('T-02'))).toBe(true);
        if (remove) {
          const db = new Database(f.database);
          try {
            expect(db.prepare('DELETE FROM idempotency_claims WHERE streamId = ? AND idempotencyKey = ?').run('__decide_once_operations__', string(operation.idempotencyKey)).changes).toBe(1);
            expect(db.prepare('SELECT 1 FROM idempotency_claims WHERE streamId = ? AND idempotencyKey = ?').get('__decide_once_operations__', string(operation.idempotencyKey))).toBeUndefined();
          } finally { db.close(); }
        }
        await barrier.release();
        const result = await process.done; const envelope = record(JSON.parse(result.stdout));
        if (remove) {
          const accepted = rowsOf(f.database).filter(row => row.type === 'execution.settled').flatMap(row => Array.isArray(row.data?.acceptedTasks) ? row.data.acceptedTasks : []);
          expect(accepted).not.toContain('T-01');
          expect(rowsOf(f.database).filter(row => row.type === 'workflow.transition' && row.data?.trigger === 'settle')).toHaveLength(0);
          expect(envelope.success === false || record(envelope.data).outcome !== 'settled', JSON.stringify(envelope)).toBe(true);
        } else expect(data(envelope)).toMatchObject({ acceptedTasks: ['T-01', 'T-02'] });
      } finally { await process.stop(); }
    }, ['T-01', 'T-02'], 'low');
  }, TIMEOUT);
});
