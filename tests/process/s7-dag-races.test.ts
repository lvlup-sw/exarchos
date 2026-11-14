/** Packaged restart and standing races use original claims and stopped owned processes.
 * @oracle-sources: SQLite original claim arrays, immutable bundle bytes, real Node assertion probes and Git argv.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { RunBundleStore } from '../../src/events/bundle/run-bundle-store.js';
import { ContentDigestV1Schema } from '../../src/workflow/admission/types.js';
import { decodeExecuteIntentBundle } from '../../src/verbs/execute/run-bundle.js';
import { decodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { SettlementReceiptData } from '../../src/verbs/settle/schemas.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { data, record } from '../helpers/capsule/s6-process-race.js';
import { allClaims, rowsOf, barrierFor, journalOf, startSettle, string, withS7Repository } from '../helpers/capsule/s7-process-race.js';

const TIMEOUT = 120_000;

describe('packaged S7 DAG races', () => {
  /** Stop after original passing evidence, then continue the same bound request without repeating its probe. */
  it('Process_RestartRecoversCoordinate', async () => {
    await withS7Repository(async f => {
      const barrier = await barrierFor(f, 'T-01', 'adequacy');
      const process = startSettle(f, barrier.env);
      let ready: Record<string, unknown>;
      try { ready = await barrier.wait(); } finally { await process.stop(); }
      const tree = string(f.trees.get('T-01'));
      expect(ready.argv).toEqual(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', tree, 'status', '--porcelain']);
      expect(ready.rows).toMatchObject([{ type: 'admission.evidence-recorded', data: { evidence: { verdict: 'pass' } } },
        { type: 'gate.executed', data: { passed: true, details: { taskId: 'T-01', worktree: tree, verdict: 'pass' } } }]);
      expect(ready.bindings).toHaveLength(1);
      const before = await journalOf(f);
      expect(before.map(row => row.mode)).toEqual(['probe', 'probe']);
      expect(before.map(row => row.args)).toEqual([['tests/T-01.test.cjs'], ['tests/T-01.test.cjs']]);
      expect(before.map(row => row.source)).toEqual([{ 'T-01.cjs': 'module.exports = 1;\n' }, { 'T-01.cjs': 'module.exports = 0;\n' }]);
      expect(rowsOf(f.database).some(row => row.type === 'orchestrate.intent_executed' || row.type === 'execution.settled')).toBe(false);
      expect(await f.git(['-C', tree, 'status', '--porcelain'])).toBe('');
      const result = await f.cli(f.args, f.env);
      const receipt = SettlementReceiptData.parse(data(result.envelope));
      expect(receipt.acceptedTasks).toEqual(['T-01']);
      expect((await journalOf(f)).filter(row => row.mode === 'probe')).toEqual(before);
      expect((await journalOf(f)).some(row => row.mode === 'integration')).toBe(true);
      expect(allClaims(f.database)).toEqual(expect.arrayContaining(recordArray(ready.members)));
      expect(allClaims(f.database).filter(row => row.streamId === '__segment_input_bindings_v1__')).toEqual(ready.bindings);
      const bundles = RunBundleStore.forStateDir(f.stateDir);
      const ref = receipt.bundleRefs?.[0]; if (!ref) throw new Error('Missing actual outer bundle');
      const settlement = decodeSettlementBundle(await bundles.resolve(ContentDigestV1Schema.parse(ref.digest)));
      const trace = settlement.verification?.[0]; const runRef = trace?.bundleRefs?.[0];
      if (!runRef) throw new Error('Missing actual segment reference');
      const run = decodeExecuteIntentBundle(await bundles.resolve(runRef.digest));
      const adequacy = run.leaves.find(leaf => leaf.action === 'check_test_adequacy');
      expect(adequacy, JSON.stringify(run)).toMatchObject({ disposition: { kind: 'replay-elided' } });
      expect(run.input?.args.coordinate).toMatchObject({ taskId: 'T-01', rootBaseCommit: f.repository.baseCommit, diffBaseCommit: f.repository.baseCommit, blockers: [] });
      expect(adequacy?.args.coordinate).toEqual(run.input?.args.coordinate);
      expect(record(record(recordArray(ready.rows)[0]?.data).evidence).producer).toMatchObject({ invocationId: `${run.operationId}:leaf-0:check_test_adequacy` });
      expect(adequacy?.events.map(event => event.sequence)).toEqual(recordArray(ready.rows).map(row => row.sequence));
      const terminal = rowsOf(f.database).find(row => row.type === 'orchestrate.intent_executed' && row.data?.operationId === run.operationId);
      expect(terminal).toBeDefined();
      const operation = allClaims(f.database).find(row => row.idempotencyKey === run.operationId);
      expect(JSON.parse(string(operation?.sequences))).toContain(terminal?.sequence);
      const original = allClaims(f.database); const providers = await journalOf(f);
      await rmrfAsync(tree);
      expect(data((await f.cli(f.args, f.env)).envelope)).toEqual(receipt);
      expect(allClaims(f.database)).toEqual(original); expect(await journalOf(f)).toEqual(providers);
    }, ['T-01'], 'high');
  }, TIMEOUT);

  /** A missing original claim, partial pair or changed named head cannot be replaced by a new passing probe. */
  it('Process_InterruptedEvidenceDamage_RefusesReplacement', async () => {
    for (const damage of ['missing-claim', 'evidence-only', 'wrong-head']) await withS7Repository(async f => {
      const barrier = await barrierFor(f, 'T-01', 'adequacy'); const process = startSettle(f, barrier.env);
      let ready: Record<string, unknown>;
      try { ready = await barrier.wait(); } finally { await process.stop(); }
      const signal = recordArray(ready.rows)[1]; if (!signal) throw new Error('No original signal');
      const before = await journalOf(f);
      const db = new Database(f.database);
      try {
        if (damage === 'wrong-head') {
          const changed = structuredClone(signal); record(record(changed.data).details).head = '0'.repeat(40);
          expect(db.prepare('UPDATE events SET payload = ?, data = ? WHERE streamId = ? AND sequence = ?')
            .run(JSON.stringify(changed), JSON.stringify(changed.data), string(signal.streamId), Number(signal.sequence)).changes).toBe(1);
        } else {
          expect(db.prepare('DELETE FROM idempotency_claims WHERE streamId = ? AND idempotencyKey = ?')
            .run(string(signal.streamId), string(signal.idempotencyKey)).changes).toBe(1);
          if (damage === 'evidence-only') expect(db.prepare('DELETE FROM events WHERE streamId = ? AND sequence = ?')
            .run(string(signal.streamId), Number(signal.sequence)).changes).toBe(1);
        }
      } finally { db.close(); }
      const result = await f.cli(f.args, f.env);
      expect(result.envelope.success === false || record(result.envelope.data).outcome !== 'settled', JSON.stringify(result.envelope)).toBe(true);
      expect(await journalOf(f)).toEqual(before);
      expect(rowsOf(f.database).filter(row => row.type === 'execution.settled').flatMap(row => Array.isArray(row.data.acceptedTasks) ? row.data.acceptedTasks : [])).toEqual([]);
      expect(rowsOf(f.database).filter(row => row.type === 'task.completed')).toHaveLength(0);
    }, ['T-01'], 'high');
  }, TIMEOUT);

  /** Earlier-segment refresh observes lost authentic membership. The clean twin accepts both tasks. */
  it('Process_StandingChangesAfterSegment_RefusesMove', async () => {
    for (const remove of [false, true]) await withS7Repository(async f => {
      const barrier = await barrierFor(f, 'T-02', 'standing'); const process = startSettle(f, barrier.env);
      try {
        const ready = await barrier.wait();
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

/** Reject missing evidence instead of silently treating it as an empty observed set. */
function recordArray(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Expected original evidence array');
  return value.map(record);
}
