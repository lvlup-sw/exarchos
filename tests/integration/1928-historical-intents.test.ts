// @oracle-sources: persisted SQLite operation membership and original content-addressed run bytes, and the frozen S7 request digest recipe
/** Prove that captured S7 writer custody replays after the retirement of synthesis closeout, without contact with a remote service. */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { WorkflowEventBase } from '../../src/events/schemas.js';
import { DECIDE_ONCE_CLAIM_STREAM } from '../../src/storage/sqlite/constants.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../../src/events/store.js';
import { runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { handleExecuteIntent, productionExecuteDeps, derivedLeafOperationId } from '../../src/verbs/execute/executor.js';
import { decodeExecuteIntentBundle, encodeExecuteIntentBundle } from '../../src/verbs/execute/run-bundle.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../tools/test-helpers/trusted-context.js';
import { fixtureCorrelation, fixtureWiring, receiptOf } from '../unit/verbs/execute/fixtures.js';

const STREAM = 'historical-s7-writer';
const INTENT = 'synthesis-closeout';
const ARGS = { title: 'feat: retain original writer custody', prBody: '## Summary\n\nHistorical fixture.\n\n## Changes\n\n- Original effect.\n\n## Test Plan\n\n- Real stored custody.\n', baseBranch: 'main', headBranch: 'feature/history' };
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });

/** S7 v1 sorts only top-level argument keys. This oracle does not call the production digest helper. */
function historicalDigest(args: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ intent: INTENT, streamId: STREAM,
    args: Object.keys(args).sort().map(key => [key, args[key]]) })).digest('hex')}`;
}

/** The handlers, the append and claim path, and the custody store are real. No module can open a remote pull request. */
async function fixture(seed = true) {
  const state = makeTempDir('1928-history-'); const events = new EventStore(state); await events.initialize();
  closes.push(async () => { events.close(); await rmrfAsync(state); });
  if (seed) await seedActivePhaseAttempt(events, STREAM, { phase: 'synthesize' });
  const run = (operationId: string, args: Record<string, unknown> = ARGS, retired = false) => runWithDispatchContext(fixtureCorrelation(), () =>
    handleExecuteIntent({ intent: INTENT, streamId: STREAM, operationId, args }, state, fixtureWiring(state, events),
      { ...productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'), ...(retired ? { runbookTable: [] } : {}) }));
  return { state, events, run, backend: events.getAppender().ensureSqliteBackendSync() };
}

describe('S7 historical writer provenance', () => {
  /**
   * The census of the original S7 writer custody. It reads the frozen terminal and interrupted custody through the retired executor.
   * The terminal replays its original receipt, and the interrupted run stays incomplete. A fresh operation gets the retired refusal.
   */
  it('LegacySynthesis_ActualTerminalAndInterruptedCustody', async () => {
    const f = await importedHistory(); const operationId = f.original.operationId;
    expect(f.saved.requestDigest).toBe(historicalDigest(ARGS));
    expect(f.saved.args).toEqual(ARGS);
    expect(operationId).toBe('history-terminal');
    const receipt = receiptOf({ success: true, data: f.saved.terminal.claim.result });
    expect(receipt.outcome).toBe('committed');
    expect(receipt.requestDigest).toBe(historicalDigest(ARGS));
    const claim = f.backend.lookupOperationClaim(operationId); if (claim === undefined) throw new Error('Missing actual terminal claim');
    const rows = await f.events.query(STREAM); const vcsRows = await f.events.query('vcs');
    expect(claim.result).toEqual(receipt);
    expect(vcsRows.filter(row => row.operationId === derivedLeafOperationId(operationId, 1, 'create_pr')).map(row => row.type)).toEqual(['pr.create.requested', 'pr.create.executed']);
    const ref = receipt.bundleRefs?.[0]; if (ref === undefined) throw new Error('Missing original run custody');
    const bundle = decodeExecuteIntentBundle(await f.events.bundleStore.resolve(ref.digest));
    expect(bundle.requestDigest).toBe(claim.requestDigest); expect(bundle.operationId).toBe(operationId); expect(bundle).not.toHaveProperty('input');
    for (const [index, sequence] of claim.sequences.entries()) {
      const row = rows.find(row => row.sequence === sequence); expect(row).toMatchObject({ eventId: claim.eventIds[index], timestamp: claim.timestamps[index], type: 'orchestrate.intent_executed' });
    }
    const before = durableSnapshot(f.state);
    const reordered = { headBranch: ARGS.headBranch, baseBranch: ARGS.baseBranch, prBody: ARGS.prBody, title: ARGS.title };
    const replayed = await f.run(operationId, reordered);
    expect(replayed).toMatchObject({ success: true, data: receipt });
    expect(await f.events.query(STREAM)).toEqual(rows); expect(await f.events.query('vcs')).toEqual(vcsRows);
    expect(await f.run(operationId, { ...ARGS, title: 'changed' })).toMatchObject({ success: false, error: { code: 'INTENT_REPLAY_DIGEST_MISMATCH' } });
    expect((await f.run(operationId, { ...ARGS, unknown: true })).success).toBe(false);
    expect(await f.run(operationId, ARGS, true)).toEqual(replayed);
    expect(await f.run('history-fresh', ARGS)).toMatchObject({ success: false, error: { code: 'SYNTHESIS_CLOSEOUT_RETIRED' } });
    expect(durableSnapshot(f.state)).toEqual(before);

    const interrupted = await importedHistory(true); const interruptedId = interrupted.original.operationId;
    expect(interruptedId).toBe('history-interrupted');
    expect(interrupted.backend.lookupOperationClaim(interruptedId)).toBeUndefined();
    const interruptedRows = await interrupted.events.query(STREAM); const interruptedVcs = await interrupted.events.query('vcs');
    expect(interruptedRows.filter(row => row.type === 'orchestrate.intent_executed')).toHaveLength(0);
    expect(interruptedVcs.map(row => row.type)).toEqual(['pr.create.requested', 'pr.create.executed']);
    expect(decodeExecuteIntentBundle(interrupted.bytes).requestDigest).toBe(historicalDigest(ARGS));
    const retry = await interrupted.run(interruptedId);
    expect(retry).toMatchObject({ success: false, error: { code: 'INTENT_HISTORY_INCOMPLETE' } });
    expect(interrupted.backend.lookupOperationClaim(interruptedId)).toBeUndefined();
    expect(await interrupted.events.query('vcs')).toEqual(interruptedVcs);
  });

  it('FrozenS7_OriginalMembershipDigestAndInterruptedBoundary', async () => {
    const saved = frozenHistory();
    expect(saved.capturedFrom).toBe('974401708411e9f94aee2aa75b81a4a285d672d0');
    expect(saved.requestDigest).toBe(historicalDigest(saved.args));
    const original = receiptOf({ success: true, data: saved.terminal.claim.result });
    const bytes = Buffer.from(saved.terminal.runBytesBase64, 'base64');
    const run = decodeExecuteIntentBundle(bytes);
    expect(original.bundleRefs?.[0]?.digest).toEqual({ algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex') });
    expect(run).toMatchObject({ operationId: saved.terminal.operationId, requestDigest: saved.requestDigest, intent: INTENT, streamId: STREAM });
    expect(run).not.toHaveProperty('input');
    expect(saved.terminal.claim.streamId).toBe(STREAM);
    expect(saved.terminal.claim.requestDigest).toBe(saved.requestDigest);
    for (const [i, sequence] of saved.terminal.claim.sequences.entries()) {
      expect(saved.terminal.rows.find(row => row.sequence === sequence)).toMatchObject({ eventId: saved.terminal.claim.eventIds[i], timestamp: saved.terminal.claim.timestamps[i], type: 'orchestrate.intent_executed', data: { operationId: saved.terminal.operationId, requestDigest: saved.requestDigest, bundleRefs: original.bundleRefs } });
    }
    expect(saved.interrupted.terminalClaim).toBeNull();
    expect(saved.interrupted.rows.filter(row => row.type === 'orchestrate.intent_executed')).toEqual([]);
    const interruptedRun = decodeExecuteIntentBundle(Buffer.from(saved.interrupted.runBytesBase64, 'base64'));
    expect(interruptedRun).toMatchObject({ operationId: saved.interrupted.operationId, requestDigest: saved.requestDigest });
    expect(saved.interrupted.vcsRows.map(row => row.type)).toEqual(['pr.create.requested', 'pr.create.executed']);
    expect(saved.interrupted.postRetryClaim.result).toEqual(saved.interrupted.retry.data);
    expect(saved.interrupted.postRetryRows.filter(row => row.type === 'orchestrate.intent_executed')).toHaveLength(1);
  });
});

/** One captured custody: its rows, its original run bytes, and its terminal claim when one exists. */
interface CapturedCustody {
  readonly operationId: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly vcsRows: readonly Record<string, unknown>[];
  readonly runBytesBase64: string;
  readonly claim: ReturnType<typeof frozenHistory>['terminal']['claim'] | null;
}

/** Import original members and run bytes. SQL envelope serialization is reconstructed from captured values, not recaptured. */
async function importedCustody(original: CapturedCustody) {
  const f = await fixture(false);
  const rows = [...original.rows, ...original.vcsRows].map(row => WorkflowEventBase.passthrough().parse(row));
  for (const row of rows) f.backend.appendEvent(row.streamId, row);
  const bytes = Buffer.from(original.runBytesBase64, 'base64');
  const digest = await f.events.bundleStore.put(bytes);
  const claim = original.claim;
  if (claim !== null) {
    const members = claim.sequences.map((sequence, i) => {
      const matches = rows.filter(row => row.streamId === claim.streamId && row.sequence === sequence && row.eventId === claim.eventIds[i] && row.timestamp === claim.timestamps[i]);
      expect(matches).toHaveLength(1); return matches[0];
    });
    const db = new Database(join(f.state, 'exarchos.db'));
    try {
      db.prepare('INSERT INTO idempotency_claims (streamId,idempotencyKey,eventIds,sequences,timestamps,events_json,claimedAt) VALUES (?,?,?,?,?,?,?)')
        .run(DECIDE_ONCE_CLAIM_STREAM, original.operationId, JSON.stringify(claim.eventIds), JSON.stringify(claim.sequences), JSON.stringify(claim.timestamps), JSON.stringify({ version: 1, streamId: claim.streamId, requestDigest: claim.requestDigest, result: claim.result, events: members }), claim.timestamps[0]);
    } finally { db.close(); }
    expect(f.backend.lookupOperationClaim(original.operationId)).toEqual(claim);
    expect(receiptOf({ success: true, data: claim.result }).bundleRefs?.[0]?.digest).toEqual(digest);
  }
  return { ...f, original, bytes, digest, blobPath: join(f.state, 'run-bundles', digest.algorithm, digest.value.slice(0, 2), digest.value.slice(2)) };
}

/** Import the frozen terminal custody, or the frozen interrupted custody, which has no terminal claim. */
async function importedHistory(interrupted = false) {
  const saved = frozenHistory();
  const original = interrupted ? { ...saved.interrupted, claim: null } : saved.terminal;
  return { ...(await importedCustody(original)), saved };
}

/** Capture all durable rows and claims, including their exact serialized payloads, without synthesizing a projection. */
function durableSnapshot(state: string) {
  const db = new Database(join(state, 'exarchos.db'));
  try { return { events: db.prepare('SELECT * FROM events ORDER BY streamId,sequence').all(), claims: db.prepare('SELECT * FROM idempotency_claims ORDER BY streamId,idempotencyKey').all() }; }
  finally { db.close(); }
}

describe('historical terminal admission without live compilation', () => {
  it('OriginalCustody_NoCompilerOrWriter_ExactReceiptAndAdmission', async () => {
    const f = await importedHistory(); const before = durableSnapshot(f.state);
    const put = vi.spyOn(f.events.bundleStore, 'put');
    const reordered = { headBranch: ARGS.headBranch, title: ARGS.title, prBody: ARGS.prBody, baseBranch: ARGS.baseBranch };
    expect(await f.run(f.original.operationId, reordered, true)).toMatchObject({ success: true, data: f.saved.terminal.claim.result });
    expect(await f.run(f.original.operationId, { ...ARGS, title: 'different' }, true)).toMatchObject({ success: false, error: { code: 'INTENT_REPLAY_DIGEST_MISMATCH' } });
    for (const args of [{}, { ...ARGS, extra: true }, { ...ARGS, title: '' }]) {
      expect(await f.run(f.original.operationId, args, true)).toMatchObject({ success: false, error: { code: 'INTENT_HISTORY_REFUSED' } });
    }
    for (const raw of [
      { intent: INTENT, streamId: STREAM, featureId: 'other', operationId: f.original.operationId, args: ARGS },
      { intent: INTENT, streamId: STREAM, operationId: '../invalid', args: ARGS },
    ]) expect((await handleExecuteIntent(raw, f.state, fixtureWiring(f.state, f.events), { ...productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'), runbookTable: [] })).success).toBe(false);
    expect(durableSnapshot(f.state)).toEqual(before); expect(put).not.toHaveBeenCalled();
    expect(await f.events.bundleStore.resolve(f.digest)).toEqual(f.bytes);
  });

  /** An unfinished original stays incomplete. A fresh operation, with valid or malformed arguments, gets the retired refusal and writes nothing. */
  it('UnfinishedOriginal_RefusesIncomplete_FreshOperationGetsTheRetiredRefusal', async () => {
    const f = await importedHistory(true); const before = durableSnapshot(f.state);
    for (const retired of [false, true]) expect(await f.run(f.original.operationId, ARGS, retired)).toMatchObject({ success: false, error: { code: 'INTENT_HISTORY_INCOMPLETE' } });
    expect(durableSnapshot(f.state)).toEqual(before);
    const fresh: readonly (readonly [string, Record<string, unknown>, boolean])[] = [['new-retired-operation', ARGS, true], ['new-malformed', {}, false], ['new-operation', ARGS, false]];
    for (const [operationId, args, retired] of fresh) {
      expect(await f.run(operationId, args, retired)).toMatchObject({ success: false, error: { code: 'SYNTHESIS_CLOSEOUT_RETIRED' } });
      expect(durableSnapshot(f.state)).toEqual(before);
    }
  });

  it('PhysicalCustodyCorruption_NoFallbackNoMutation', async () => {
    for (const mutation of ['claim-missing', 'claim-stream', 'claim-eventId', 'claim-timestamp', 'claim-sequence', 'receipt-outcome', 'member-missing', 'member-eventId', 'member-operation', 'member-failedLeaf', 'artifact-id', 'extra-ref', 'missing-blob', 'corrupt-blob', 'valid-wrong-run']) {
      const f = await importedHistory(); const db = new Database(join(f.state, 'exarchos.db'));
      try {
        const claim = structuredClone(f.saved.terminal.claim);
        const receipt = receiptOf({ success: true, data: claim.result });
        const member = WorkflowEventBase.passthrough().parse(f.saved.terminal.rows.find(row => row.sequence === claim.sequences[0]));
        if (mutation === 'claim-missing') expect(db.prepare('DELETE FROM idempotency_claims WHERE streamId=? AND idempotencyKey=?').run(DECIDE_ONCE_CLAIM_STREAM, f.original.operationId).changes).toBe(1);
        else if (mutation.startsWith('claim-') || mutation === 'receipt-outcome' || mutation === 'artifact-id' || mutation === 'extra-ref' || mutation === 'valid-wrong-run') {
          if (mutation === 'claim-stream') claim.streamId = 'foreign';
          if (mutation === 'claim-eventId') claim.eventIds[0] = 'wrong-event';
          if (mutation === 'claim-timestamp') claim.timestamps[0] = '2000-01-01T00:00:00.000Z';
          if (mutation === 'claim-sequence') claim.sequences[0] = 1;
          if (mutation === 'receipt-outcome') Reflect.set(receipt, 'outcome', 'failed');
          if (mutation === 'artifact-id') Reflect.set(receipt.bundleRefs?.[0] ?? {}, 'artifactId', 'run-bundle:wrong');
          if (mutation === 'extra-ref') Reflect.set(receipt, 'bundleRefs', [...(receipt.bundleRefs ?? []), ...(receipt.bundleRefs ?? [])]);
          if (mutation === 'valid-wrong-run') {
            const run = decodeExecuteIntentBundle(f.bytes); const wrong = encodeExecuteIntentBundle({ ...run, streamId: 'foreign' });
            const digest = await f.events.bundleStore.put(wrong); Reflect.set(receipt.bundleRefs?.[0] ?? {}, 'digest', digest);
          }
          if (['artifact-id', 'extra-ref', 'valid-wrong-run'].includes(mutation)) {
            Reflect.set(member.data ?? {}, 'bundleRefs', receipt.bundleRefs);
            db.prepare('UPDATE events SET data=?,payload=? WHERE streamId=? AND sequence=?').run(JSON.stringify(member.data), JSON.stringify(member), STREAM, member.sequence);
          }
          expect(db.prepare('UPDATE idempotency_claims SET eventIds=?,sequences=?,timestamps=?,events_json=? WHERE streamId=? AND idempotencyKey=?').run(JSON.stringify(claim.eventIds), JSON.stringify(claim.sequences), JSON.stringify(claim.timestamps), JSON.stringify({ version: 1, streamId: claim.streamId, requestDigest: claim.requestDigest, result: receipt }), DECIDE_ONCE_CLAIM_STREAM, f.original.operationId).changes).toBe(1);
        } else if (mutation === 'member-missing') expect(db.prepare('DELETE FROM events WHERE streamId=? AND sequence=?').run(STREAM, member.sequence).changes).toBe(1);
        else if (mutation.startsWith('member-')) {
          if (mutation === 'member-eventId') Reflect.set(member, 'eventId', 'copied-member');
          if (mutation === 'member-operation') Reflect.set(member.data ?? {}, 'operationId', 'other-operation');
          if (mutation === 'member-failedLeaf') Reflect.set(member.data ?? {}, 'failedLeaf', 'create_pr');
          expect(db.prepare('UPDATE events SET data=?,payload=? WHERE streamId=? AND sequence=?').run(JSON.stringify(member.data), JSON.stringify(member), STREAM, member.sequence).changes).toBe(1);
        } else if (mutation === 'missing-blob') await unlink(f.blobPath);
        else if (mutation === 'corrupt-blob') await writeFile(f.blobPath, 'corrupt original bytes');
      } finally { db.close(); }
      const before = durableSnapshot(f.state); const put = vi.spyOn(f.events.bundleStore, 'put');
      const result = await f.run(f.original.operationId, ARGS, true);
      expect(result.success, mutation).toBe(false);
      expect(result.error?.code, mutation).toBe(mutation === 'claim-missing' ? 'INTENT_HISTORY_INCOMPLETE' : 'INTENT_HISTORY_REFUSED');
      expect(durableSnapshot(f.state), mutation).toEqual(before); expect(put, mutation).not.toHaveBeenCalled();
    }
  });

  it('TerminalWinsDuringMissingObservation_ReauthenticatesExactRequest', async () => {
    for (const changed of [false, true]) {
      const f = await importedHistory(); const before = durableSnapshot(f.state);
      const db = new Database(join(f.state, 'exarchos.db'));
      const stored = z.object({ streamId: z.string(), idempotencyKey: z.string(), eventIds: z.string(), sequences: z.string(), timestamps: z.string(), events_json: z.string(), claimedAt: z.string() }).parse(db.prepare('SELECT * FROM idempotency_claims WHERE streamId=? AND idempotencyKey=?').get(DECIDE_ONCE_CLAIM_STREAM, f.original.operationId));
      expect(db.prepare('DELETE FROM idempotency_claims WHERE streamId=? AND idempotencyKey=?').run(DECIDE_ONCE_CLAIM_STREAM, f.original.operationId).changes).toBe(1);
      db.close(); const query = f.events.query.bind(f.events); let published = false;
      vi.spyOn(f.events, 'query').mockImplementation(async (...args) => {
        if (args[0] === 'vcs' && !published) {
          published = true; const writer = new Database(join(f.state, 'exarchos.db'));
          try { writer.prepare('INSERT INTO idempotency_claims (streamId,idempotencyKey,eventIds,sequences,timestamps,events_json,claimedAt) VALUES (?,?,?,?,?,?,?)').run(stored.streamId, stored.idempotencyKey, stored.eventIds, stored.sequences, stored.timestamps, stored.events_json, stored.claimedAt); }
          finally { writer.close(); }
        }
        return query(...args);
      });
      const result = await f.run(f.original.operationId, changed ? { ...ARGS, title: 'different' } : ARGS, true);
      expect(published).toBe(true);
      if (changed) expect(result).toMatchObject({ success: false, error: { code: 'INTENT_REPLAY_DIGEST_MISMATCH' } });
      else expect(result).toMatchObject({ success: true, data: f.saved.terminal.claim.result });
      expect(durableSnapshot(f.state)).toEqual(before);
    }
  });

  /** The frozen failed terminal replays its original failure carrier, and no call writes a row or opens a PR. */
  it('OriginalFailedTerminal_PreservesFailureCarrierWithoutCompiler', async () => {
    const saved = frozenFailedHistory(); const f = await importedCustody(saved);
    expect(receiptOf(saved.result).outcome).toBe('failed'); expect(saved.vcsRows).toEqual([]);
    const before = durableSnapshot(f.state);
    for (const retired of [false, true]) expect(await f.run(saved.operationId, saved.args, retired)).toEqual(saved.result);
    expect(durableSnapshot(f.state)).toEqual(before);
  });
});

/** Parse frozen custody without regenerating original event IDs, timestamps or content-addressed bytes. */
function frozenHistory() {
  const originalBytes = Buffer.from(FROZEN_HISTORY_JSON, 'utf8');
  expect(createHash('sha256').update(originalBytes).digest('hex')).toBe('6b7adea884869122fd3061477adf9715100bae62a2c06db432450dd44133d0c1');
  const row = z.object({ sequence: z.number(), eventId: z.string(), timestamp: z.string(), operationId: z.string().optional(), type: z.string() }).passthrough();
  const claim = z.object({ streamId: z.string(), requestDigest: z.string(), result: z.unknown(), sequences: z.array(z.number()), eventIds: z.array(z.string()), timestamps: z.array(z.string()) });
  return z.object({
    capturedFrom: z.string(), args: z.record(z.string(), z.unknown()), requestDigest: z.string(),
    terminal: z.object({ operationId: z.string(), claim, rows: z.array(row), vcsRows: z.array(row), runBytesBase64: z.string() }),
    interrupted: z.object({ operationId: z.string(), terminalClaim: z.null(), rows: z.array(row), vcsRows: z.array(row), runBytesBase64: z.string(), retry: z.object({ data: z.unknown() }), postRetryClaim: claim, postRetryRows: z.array(row) }),
  }).parse(JSON.parse(originalBytes.toString('utf8')));
}

/** Parse the frozen failed terminal without regenerating original event IDs, timestamps or content-addressed bytes. */
function frozenFailedHistory() {
  const originalBytes = Buffer.from(FROZEN_FAILED_HISTORY_JSON, 'utf8');
  expect(createHash('sha256').update(originalBytes).digest('hex')).toBe('8f0e0dea840b0c6a776d22459c524c4355ca6bb7960e666ad9b193ac56272e6a');
  const row = z.object({ sequence: z.number(), eventId: z.string(), timestamp: z.string(), operationId: z.string().optional(), type: z.string() }).passthrough();
  const claim = z.object({ streamId: z.string(), requestDigest: z.string(), result: z.unknown(), sequences: z.array(z.number()), eventIds: z.array(z.string()), timestamps: z.array(z.string()) });
  const result = z.object({ success: z.boolean(), data: z.unknown(), error: z.object({ code: z.string(), message: z.string() }).passthrough() }).passthrough();
  const parsed = z.object({
    capturedFrom: z.string(), intent: z.literal(INTENT), streamId: z.literal(STREAM), args: z.record(z.string(), z.unknown()), requestDigest: z.string(),
    operationId: z.string(), result, claim, rows: z.array(row), vcsRows: z.array(row), runBytesBase64: z.string(),
  }).parse(JSON.parse(originalBytes.toString('utf8')));
  expect(parsed.capturedFrom).toBe('64a9cf732c1eaf30873d08e177c3c1a093343b7b');
  expect(parsed.requestDigest).toBe(historicalDigest(parsed.args));
  return parsed;
}

/**
 * The original failed terminal, captured from the last revision that compiled synthesis closeout.
 * The hash in frozenFailedHistory prevents silent recapture or normalization.
 */
const FROZEN_FAILED_HISTORY_JSON = String.raw`{
  "capturedFrom": "64a9cf732c1eaf30873d08e177c3c1a093343b7b",
  "intent": "synthesis-closeout",
  "streamId": "historical-s7-writer",
  "args": {
    "title": "feat: retain original writer custody",
    "prBody": "Missing required sections",
    "baseBranch": "main",
    "headBranch": "feature/history"
  },
  "requestDigest": "sha256:124aaeacb1c339cc00c9d9cff299a845ffd229a177fa1ce695f438ee207c5c7e",
  "operationId": "original-failed-body",
  "result": {
    "success": false,
    "data": {
      "operationId": "original-failed-body",
      "intent": "synthesis-closeout",
      "outcome": "failed",
      "leaves": [
        {
          "action": "validate_pr_body",
          "status": "failed",
          "events": []
        }
      ],
      "failedLeaf": "validate_pr_body",
      "tailSequence": 0,
      "requestDigest": "sha256:124aaeacb1c339cc00c9d9cff299a845ffd229a177fa1ce695f438ee207c5c7e",
      "failure": {
        "code": "INTENT_SEGMENT_FAILED",
        "message": "leaf 'validate_pr_body' failed: PR body is missing required section(s): Summary, Changes, Test Plan. PR body validation failed.\n  Missing: ## Summary\n  Missing: ## Changes\n  Missing: ## Test Plan\n\nRequired sections: Summary, Changes, Test Plan"
      },
      "interaction": {
        "leavesExecuted": 1,
        "eventsAppended": 0,
        "requests": 1,
        "deferred": [
          "correction-call-rate",
          "schema-rediscovery",
          "tokens-net-of-refetch",
          "suspensions"
        ]
      },
      "bundleRefs": [
        {
          "artifactId": "run-bundle:execute-intent-run:original-failed-body",
          "digest": {
            "algorithm": "sha256",
            "value": "28be35e49be98673943d562f8752e1911ee4c3cb26d1244e48da65facb45c09f"
          }
        }
      ]
    },
    "error": {
      "code": "INTENT_SEGMENT_FAILED",
      "message": "leaf 'validate_pr_body' failed: PR body is missing required section(s): Summary, Changes, Test Plan. PR body validation failed.\n  Missing: ## Summary\n  Missing: ## Changes\n  Missing: ## Test Plan\n\nRequired sections: Summary, Changes, Test Plan",
      "intentReceipt": {
        "operationId": "original-failed-body",
        "outcome": "failed",
        "failedLeaf": "validate_pr_body",
        "tailSequence": 0,
        "bundleRefs": [
          {
            "artifactId": "run-bundle:execute-intent-run:original-failed-body",
            "digest": {
              "algorithm": "sha256",
              "value": "28be35e49be98673943d562f8752e1911ee4c3cb26d1244e48da65facb45c09f"
            }
          }
        ],
        "leaves": [
          {
            "action": "validate_pr_body",
            "status": "failed",
            "events": 0
          }
        ]
      }
    }
  },
  "claim": {
    "streamId": "historical-s7-writer",
    "requestDigest": "sha256:124aaeacb1c339cc00c9d9cff299a845ffd229a177fa1ce695f438ee207c5c7e",
    "result": {
      "operationId": "original-failed-body",
      "intent": "synthesis-closeout",
      "outcome": "failed",
      "leaves": [
        {
          "action": "validate_pr_body",
          "status": "failed",
          "events": []
        }
      ],
      "failedLeaf": "validate_pr_body",
      "tailSequence": 0,
      "requestDigest": "sha256:124aaeacb1c339cc00c9d9cff299a845ffd229a177fa1ce695f438ee207c5c7e",
      "failure": {
        "code": "INTENT_SEGMENT_FAILED",
        "message": "leaf 'validate_pr_body' failed: PR body is missing required section(s): Summary, Changes, Test Plan. PR body validation failed.\n  Missing: ## Summary\n  Missing: ## Changes\n  Missing: ## Test Plan\n\nRequired sections: Summary, Changes, Test Plan"
      },
      "interaction": {
        "leavesExecuted": 1,
        "eventsAppended": 0,
        "requests": 1,
        "deferred": [
          "correction-call-rate",
          "schema-rediscovery",
          "tokens-net-of-refetch",
          "suspensions"
        ]
      },
      "bundleRefs": [
        {
          "artifactId": "run-bundle:execute-intent-run:original-failed-body",
          "digest": {
            "algorithm": "sha256",
            "value": "28be35e49be98673943d562f8752e1911ee4c3cb26d1244e48da65facb45c09f"
          }
        }
      ]
    },
    "eventIds": [
      "be5433ab-e08a-4ec5-b481-ca6278564344"
    ],
    "sequences": [
      2
    ],
    "timestamps": [
      "2026-11-23T22:22:36.762Z"
    ]
  },
  "rows": [
    {
      "streamId": "historical-s7-writer",
      "timestamp": "2026-11-23T22:22:36.738Z",
      "type": "workflow.started",
      "schemaVersion": "1.0",
      "data": {
        "featureId": "historical-s7-writer",
        "workflowType": "feature",
        "phase": "synthesize",
        "phaseAttemptId": "phase-attempt:historical-s7-writer"
      },
      "sequence": 1,
      "eventId": "60d31db8-9f68-418d-b854-d7d6aa9e4a60"
    },
    {
      "type": "orchestrate.intent_executed",
      "data": {
        "operationId": "original-failed-body",
        "intent": "synthesis-closeout",
        "outcome": "failed",
        "failedLeaf": "validate_pr_body",
        "leaves": [
          {
            "action": "validate_pr_body",
            "status": "failed",
            "sequences": []
          }
        ],
        "requestDigest": "sha256:124aaeacb1c339cc00c9d9cff299a845ffd229a177fa1ce695f438ee207c5c7e",
        "bundleRefs": [
          {
            "artifactId": "run-bundle:execute-intent-run:original-failed-body",
            "digest": {
              "algorithm": "sha256",
              "value": "28be35e49be98673943d562f8752e1911ee4c3cb26d1244e48da65facb45c09f"
            }
          }
        ]
      },
      "timestamp": "2026-11-23T22:22:36.762Z",
      "schemaVersion": "1.1",
      "operationId": "8acbbe14-841c-4e96-b023-738a65f8a5c1",
      "correlationId": "8acbbe14-841c-4e96-b023-738a65f8a5c1",
      "streamId": "historical-s7-writer",
      "sequence": 2,
      "eventId": "be5433ab-e08a-4ec5-b481-ca6278564344"
    }
  ],
  "vcsRows": [],
  "runBytesBase64": "eyJidW5kbGVWZXJzaW9uIjoiMS4wIiwiZmFpbGVkTGVhZiI6InZhbGlkYXRlX3ByX2JvZHkiLCJmYWlsdXJlIjp7ImNvZGUiOiJJTlRFTlRfU0VHTUVOVF9GQUlMRUQiLCJtZXNzYWdlIjoibGVhZiAndmFsaWRhdGVfcHJfYm9keScgZmFpbGVkOiBQUiBib2R5IGlzIG1pc3NpbmcgcmVxdWlyZWQgc2VjdGlvbihzKTogU3VtbWFyeSwgQ2hhbmdlcywgVGVzdCBQbGFuLiBQUiBib2R5IHZhbGlkYXRpb24gZmFpbGVkLlxuICBNaXNzaW5nOiAjIyBTdW1tYXJ5XG4gIE1pc3Npbmc6ICMjIENoYW5nZXNcbiAgTWlzc2luZzogIyMgVGVzdCBQbGFuXG5cblJlcXVpcmVkIHNlY3Rpb25zOiBTdW1tYXJ5LCBDaGFuZ2VzLCBUZXN0IFBsYW4ifSwiaW50ZW50Ijoic3ludGhlc2lzLWNsb3Nlb3V0IiwiaW50ZXJhY3Rpb24iOnsiZGVmZXJyZWQiOlsiY29ycmVjdGlvbi1jYWxsLXJhdGUiLCJzY2hlbWEtcmVkaXNjb3ZlcnkiLCJ0b2tlbnMtbmV0LW9mLXJlZmV0Y2giLCJzdXNwZW5zaW9ucyJdLCJldmVudHNBcHBlbmRlZCI6MCwibGVhdmVzRXhlY3V0ZWQiOjEsInJlcXVlc3RzIjoxfSwia2luZCI6ImV4ZWN1dGUtaW50ZW50LXJ1biIsImxlYXZlcyI6W3siYWN0aW9uIjoidmFsaWRhdGVfcHJfYm9keSIsImFyZ3MiOnsiYm9keSI6Ik1pc3NpbmcgcmVxdWlyZWQgc2VjdGlvbnMiLCJlbmZvcmNlIjp0cnVlLCJmZWF0dXJlSWQiOiJoaXN0b3JpY2FsLXM3LXdyaXRlciJ9LCJkaXNwb3NpdGlvbiI6eyJoYW5kbGVyIjp7ImVycm9yIjp7ImNvZGUiOiJQUl9CT0RZX0lOQ09NUExFVEUiLCJtZXNzYWdlIjoiUFIgYm9keSBpcyBtaXNzaW5nIHJlcXVpcmVkIHNlY3Rpb24ocyk6IFN1bW1hcnksIENoYW5nZXMsIFRlc3QgUGxhbi4gUFIgYm9keSB2YWxpZGF0aW9uIGZhaWxlZC5cbiAgTWlzc2luZzogIyMgU3VtbWFyeVxuICBNaXNzaW5nOiAjIyBDaGFuZ2VzXG4gIE1pc3Npbmc6ICMjIFRlc3QgUGxhblxuXG5SZXF1aXJlZCBzZWN0aW9uczogU3VtbWFyeSwgQ2hhbmdlcywgVGVzdCBQbGFuIn0sInN1Y2Nlc3MiOmZhbHNlfSwia2luZCI6Imludm9rZWQifSwiZW5kZWRBdCI6IjIwMjYtMTEtMjNUMjI6MjI6MzYuNzU2WiIsImV2ZW50cyI6W10sImluZGV4IjowLCJvYnNlcnZhdGlvblN0cmVhbUlkIjoiaGlzdG9yaWNhbC1zNy13cml0ZXIiLCJvbkZhaWwiOiJzdG9wIiwic3RhcnRlZEF0IjoiMjAyNi0xMS0yM1QyMjoyMjozNi43NTNaIiwidG9vbCI6ImV4YXJjaG9zX29yY2hlc3RyYXRlIiwidmVyZGljdCI6eyJmYWlsdXJlIjp7ImNvZGUiOiJJTlRFTlRfU0VHTUVOVF9GQUlMRUQiLCJtZXNzYWdlIjoibGVhZiAndmFsaWRhdGVfcHJfYm9keScgZmFpbGVkOiBQUiBib2R5IGlzIG1pc3NpbmcgcmVxdWlyZWQgc2VjdGlvbihzKTogU3VtbWFyeSwgQ2hhbmdlcywgVGVzdCBQbGFuLiBQUiBib2R5IHZhbGlkYXRpb24gZmFpbGVkLlxuICBNaXNzaW5nOiAjIyBTdW1tYXJ5XG4gIE1pc3Npbmc6ICMjIENoYW5nZXNcbiAgTWlzc2luZzogIyMgVGVzdCBQbGFuXG5cblJlcXVpcmVkIHNlY3Rpb25zOiBTdW1tYXJ5LCBDaGFuZ2VzLCBUZXN0IFBsYW4ifSwic3RhdHVzIjoiZmFpbGVkIn19XSwib3BlcmF0aW9uSWQiOiJvcmlnaW5hbC1mYWlsZWQtYm9keSIsIm91dGNvbWUiOiJmYWlsZWQiLCJyZXF1ZXN0RGlnZXN0Ijoic2hhMjU2OjEyNGFhZWFjYjFjMzM5Y2MwMGM5ZDljZmYyOTlhODQ1ZmZkMjI5YTE3N2ZhMWNlNjk1ZjQzOGVlMjA3YzVjN2UiLCJzdHJlYW1JZCI6Imhpc3RvcmljYWwtczctd3JpdGVyIiwidGFpbFNlcXVlbmNlIjowfQo="
}
`;

/** Original capture06 file bytes. The hash in frozenHistory prevents silent recapture or normalization. */
const FROZEN_HISTORY_JSON = String.raw`{
  "capturedFrom": "974401708411e9f94aee2aa75b81a4a285d672d0",
  "intent": "synthesis-closeout",
  "streamId": "historical-s7-writer",
  "args": {
    "title": "feat: retain original writer custody",
    "prBody": "## Summary\n\nHistorical fixture.\n\n## Changes\n\n- Original effect.\n\n## Test Plan\n\n- Real stored custody.\n",
    "baseBranch": "main",
    "headBranch": "feature/history"
  },
  "requestDigest": "sha256:9adb8308215f54711f96d4433b16073e9d45e4aba891a4d26673a97c6fe1d9db",
  "terminal": {
    "operationId": "history-terminal",
    "claim": {
      "streamId": "historical-s7-writer",
      "requestDigest": "sha256:9adb8308215f54711f96d4433b16073e9d45e4aba891a4d26673a97c6fe1d9db",
      "result": {
        "operationId": "history-terminal",
        "intent": "synthesis-closeout",
        "outcome": "committed",
        "leaves": [
          {
            "action": "validate_pr_body",
            "status": "passed",
            "events": []
          },
          {
            "action": "create_pr",
            "status": "passed",
            "events": [
              {
                "type": "pr.create.requested",
                "streamId": "vcs",
                "sequence": 1
              },
              {
                "type": "pr.create.executed",
                "streamId": "vcs",
                "sequence": 2
              }
            ]
          }
        ],
        "tailSequence": 0,
        "requestDigest": "sha256:9adb8308215f54711f96d4433b16073e9d45e4aba891a4d26673a97c6fe1d9db",
        "interaction": {
          "leavesExecuted": 2,
          "eventsAppended": 2,
          "requests": 1,
          "deferred": [
            "correction-call-rate",
            "schema-rediscovery",
            "tokens-net-of-refetch",
            "suspensions"
          ]
        },
        "bundleRefs": [
          {
            "artifactId": "run-bundle:execute-intent-run:history-terminal",
            "digest": {
              "algorithm": "sha256",
              "value": "3fa9abe6fa73aad0ed539f71e7f7e73721db346f550499d86efcff0c44e657e5"
            }
          }
        ]
      },
      "eventIds": [
        "84dbdaa9-2bb5-488b-af78-001646e5d267"
      ],
      "sequences": [
        2
      ],
      "timestamps": [
        "2026-11-14T12:24:10.354Z"
      ]
    },
    "rows": [
      {
        "streamId": "historical-s7-writer",
        "timestamp": "2026-11-14T12:24:10.318Z",
        "type": "workflow.started",
        "schemaVersion": "1.0",
        "data": {
          "featureId": "historical-s7-writer",
          "workflowType": "feature",
          "phase": "synthesize",
          "phaseAttemptId": "phase-attempt:historical-s7-writer"
        },
        "sequence": 1,
        "eventId": "1600030c-8469-4b1c-8be9-413ac6aec84a"
      },
      {
        "type": "orchestrate.intent_executed",
        "data": {
          "operationId": "history-terminal",
          "intent": "synthesis-closeout",
          "outcome": "committed",
          "leaves": [
            {
              "action": "validate_pr_body",
              "status": "passed",
              "sequences": []
            },
            {
              "action": "create_pr",
              "status": "passed",
              "sequences": [
                1,
                2
              ]
            }
          ],
          "requestDigest": "sha256:9adb8308215f54711f96d4433b16073e9d45e4aba891a4d26673a97c6fe1d9db",
          "bundleRefs": [
            {
              "artifactId": "run-bundle:execute-intent-run:history-terminal",
              "digest": {
                "algorithm": "sha256",
                "value": "3fa9abe6fa73aad0ed539f71e7f7e73721db346f550499d86efcff0c44e657e5"
              }
            }
          ]
        },
        "timestamp": "2026-11-14T12:24:10.354Z",
        "schemaVersion": "1.1",
        "operationId": "e70dfe2e-129c-4e49-970b-591bc31ab581",
        "correlationId": "e70dfe2e-129c-4e49-970b-591bc31ab581",
        "streamId": "historical-s7-writer",
        "sequence": 2,
        "eventId": "84dbdaa9-2bb5-488b-af78-001646e5d267"
      }
    ],
    "vcsRows": [
      {
        "streamId": "vcs",
        "timestamp": "2026-11-14T12:24:10.348Z",
        "type": "pr.create.requested",
        "correlationId": "e70dfe2e-129c-4e49-970b-591bc31ab581",
        "operationId": "history-terminal:leaf-1:create_pr",
        "schemaVersion": "1.0",
        "data": {
          "operationId": "5ecb6698-22a8-4f29-ac4a-14c2532bd783",
          "title": "feat: retain original writer custody",
          "body": "## Summary\n\nHistorical fixture.\n\n## Changes\n\n- Original effect.\n\n## Test Plan\n\n- Real stored custody.\n",
          "base": "main",
          "head": "feature/history"
        },
        "idempotencyKey": "pr.create.requested:history-terminal:leaf-1:create_pr",
        "sequence": 1,
        "eventId": "5cd17241-8fe2-495b-b23e-319e166d1b3d"
      },
      {
        "streamId": "vcs",
        "timestamp": "2026-11-14T12:24:10.349Z",
        "type": "pr.create.executed",
        "correlationId": "e70dfe2e-129c-4e49-970b-591bc31ab581",
        "operationId": "history-terminal:leaf-1:create_pr",
        "schemaVersion": "1.0",
        "data": {
          "operationId": "5ecb6698-22a8-4f29-ac4a-14c2532bd783",
          "prNumber": 42,
          "url": "https://example.invalid/pr/42"
        },
        "idempotencyKey": "pr.create.executed:history-terminal:leaf-1:create_pr",
        "sequence": 2,
        "eventId": "156bb500-2342-48bf-895f-98b4cecf87ca"
      }
    ],
    "runBytesBase64": "eyJidW5kbGVWZXJzaW9uIjoiMS4wIiwiaW50ZW50Ijoic3ludGhlc2lzLWNsb3Nlb3V0IiwiaW50ZXJhY3Rpb24iOnsiZGVmZXJyZWQiOlsiY29ycmVjdGlvbi1jYWxsLXJhdGUiLCJzY2hlbWEtcmVkaXNjb3ZlcnkiLCJ0b2tlbnMtbmV0LW9mLXJlZmV0Y2giLCJzdXNwZW5zaW9ucyJdLCJldmVudHNBcHBlbmRlZCI6MiwibGVhdmVzRXhlY3V0ZWQiOjIsInJlcXVlc3RzIjoxfSwia2luZCI6ImV4ZWN1dGUtaW50ZW50LXJ1biIsImxlYXZlcyI6W3siYWN0aW9uIjoidmFsaWRhdGVfcHJfYm9keSIsImFyZ3MiOnsiYm9keSI6IiMjIFN1bW1hcnlcblxuSGlzdG9yaWNhbCBmaXh0dXJlLlxuXG4jIyBDaGFuZ2VzXG5cbi0gT3JpZ2luYWwgZWZmZWN0LlxuXG4jIyBUZXN0IFBsYW5cblxuLSBSZWFsIHN0b3JlZCBjdXN0b2R5LlxuIiwiZW5mb3JjZSI6dHJ1ZSwiZmVhdHVyZUlkIjoiaGlzdG9yaWNhbC1zNy13cml0ZXIifSwiZGlzcG9zaXRpb24iOnsiaGFuZGxlciI6eyJzdWNjZXNzIjp0cnVlfSwia2luZCI6Imludm9rZWQifSwiZW5kZWRBdCI6IjIwMjYtMTEtMTRUMTI6MjQ6MTAuMzQ3WiIsImV2ZW50cyI6W10sImluZGV4IjowLCJvYnNlcnZhdGlvblN0cmVhbUlkIjoiaGlzdG9yaWNhbC1zNy13cml0ZXIiLCJvbkZhaWwiOiJzdG9wIiwic3RhcnRlZEF0IjoiMjAyNi0xMS0xNFQxMjoyNDoxMC4zNDVaIiwidG9vbCI6ImV4YXJjaG9zX29yY2hlc3RyYXRlIiwidmVyZGljdCI6eyJzdGF0dXMiOiJwYXNzZWQifX0seyJhY3Rpb24iOiJjcmVhdGVfcHIiLCJhcmdzIjp7ImJhc2UiOiJtYWluIiwiYm9keSI6IiMjIFN1bW1hcnlcblxuSGlzdG9yaWNhbCBmaXh0dXJlLlxuXG4jIyBDaGFuZ2VzXG5cbi0gT3JpZ2luYWwgZWZmZWN0LlxuXG4jIyBUZXN0IFBsYW5cblxuLSBSZWFsIHN0b3JlZCBjdXN0b2R5LlxuIiwiZmVhdHVyZUlkIjoiaGlzdG9yaWNhbC1zNy13cml0ZXIiLCJoZWFkIjoiZmVhdHVyZS9oaXN0b3J5IiwidGl0bGUiOiJmZWF0OiByZXRhaW4gb3JpZ2luYWwgd3JpdGVyIGN1c3RvZHkifSwiZGlzcG9zaXRpb24iOnsiaGFuZGxlciI6eyJzdWNjZXNzIjp0cnVlfSwia2luZCI6Imludm9rZWQifSwiZW5kZWRBdCI6IjIwMjYtMTEtMTRUMTI6MjQ6MTAuMzQ5WiIsImV2ZW50cyI6W3sic2VxdWVuY2UiOjEsInN0cmVhbUlkIjoidmNzIiwidHlwZSI6InByLmNyZWF0ZS5yZXF1ZXN0ZWQifSx7InNlcXVlbmNlIjoyLCJzdHJlYW1JZCI6InZjcyIsInR5cGUiOiJwci5jcmVhdGUuZXhlY3V0ZWQifV0sImluZGV4IjoxLCJvYnNlcnZhdGlvblN0cmVhbUlkIjoidmNzIiwib25GYWlsIjoic3RvcCIsInN0YXJ0ZWRBdCI6IjIwMjYtMTEtMTRUMTI6MjQ6MTAuMzQ3WiIsInRvb2wiOiJleGFyY2hvc19vcmNoZXN0cmF0ZSIsInZlcmRpY3QiOnsic3RhdHVzIjoicGFzc2VkIn19XSwib3BlcmF0aW9uSWQiOiJoaXN0b3J5LXRlcm1pbmFsIiwib3V0Y29tZSI6ImNvbW1pdHRlZCIsInJlcXVlc3REaWdlc3QiOiJzaGEyNTY6OWFkYjgzMDgyMTVmNTQ3MTFmOTZkNDQzM2IxNjA3M2U5ZDQ1ZTRhYmE4OTFhNGQyNjY3M2E5N2M2ZmUxZDlkYiIsInN0cmVhbUlkIjoiaGlzdG9yaWNhbC1zNy13cml0ZXIiLCJ0YWlsU2VxdWVuY2UiOjB9Cg=="
  },
  "interrupted": {
    "operationId": "history-interrupted",
    "rows": [
      {
        "streamId": "historical-s7-writer",
        "timestamp": "2026-11-14T12:24:10.359Z",
        "type": "workflow.started",
        "schemaVersion": "1.0",
        "data": {
          "featureId": "historical-s7-writer",
          "workflowType": "feature",
          "phase": "synthesize",
          "phaseAttemptId": "phase-attempt:historical-s7-writer"
        },
        "sequence": 1,
        "eventId": "59cd1fd2-c9ef-438f-be12-0314a71205b2"
      }
    ],
    "vcsRows": [
      {
        "streamId": "vcs",
        "timestamp": "2026-11-14T12:24:10.364Z",
        "type": "pr.create.requested",
        "correlationId": "9e59e717-7e38-4f8e-9680-201b7ad57efd",
        "operationId": "history-interrupted:leaf-1:create_pr",
        "schemaVersion": "1.0",
        "data": {
          "operationId": "8077d572-9a85-4c78-a482-d83214503dcd",
          "title": "feat: retain original writer custody",
          "body": "## Summary\n\nHistorical fixture.\n\n## Changes\n\n- Original effect.\n\n## Test Plan\n\n- Real stored custody.\n",
          "base": "main",
          "head": "feature/history"
        },
        "idempotencyKey": "pr.create.requested:history-interrupted:leaf-1:create_pr",
        "sequence": 1,
        "eventId": "a659d823-621c-4959-b957-f521fe46e224"
      },
      {
        "streamId": "vcs",
        "timestamp": "2026-11-14T12:24:10.364Z",
        "type": "pr.create.executed",
        "correlationId": "9e59e717-7e38-4f8e-9680-201b7ad57efd",
        "operationId": "history-interrupted:leaf-1:create_pr",
        "schemaVersion": "1.0",
        "data": {
          "operationId": "8077d572-9a85-4c78-a482-d83214503dcd",
          "prNumber": 42,
          "url": "https://example.invalid/pr/42"
        },
        "idempotencyKey": "pr.create.executed:history-interrupted:leaf-1:create_pr",
        "sequence": 2,
        "eventId": "298c6613-19b2-4dab-af8e-ac17028560f9"
      }
    ],
    "runBytesBase64": "eyJidW5kbGVWZXJzaW9uIjoiMS4wIiwiaW50ZW50Ijoic3ludGhlc2lzLWNsb3Nlb3V0IiwiaW50ZXJhY3Rpb24iOnsiZGVmZXJyZWQiOlsiY29ycmVjdGlvbi1jYWxsLXJhdGUiLCJzY2hlbWEtcmVkaXNjb3ZlcnkiLCJ0b2tlbnMtbmV0LW9mLXJlZmV0Y2giLCJzdXNwZW5zaW9ucyJdLCJldmVudHNBcHBlbmRlZCI6MiwibGVhdmVzRXhlY3V0ZWQiOjIsInJlcXVlc3RzIjoxfSwia2luZCI6ImV4ZWN1dGUtaW50ZW50LXJ1biIsImxlYXZlcyI6W3siYWN0aW9uIjoidmFsaWRhdGVfcHJfYm9keSIsImFyZ3MiOnsiYm9keSI6IiMjIFN1bW1hcnlcblxuSGlzdG9yaWNhbCBmaXh0dXJlLlxuXG4jIyBDaGFuZ2VzXG5cbi0gT3JpZ2luYWwgZWZmZWN0LlxuXG4jIyBUZXN0IFBsYW5cblxuLSBSZWFsIHN0b3JlZCBjdXN0b2R5LlxuIiwiZW5mb3JjZSI6dHJ1ZSwiZmVhdHVyZUlkIjoiaGlzdG9yaWNhbC1zNy13cml0ZXIifSwiZGlzcG9zaXRpb24iOnsiaGFuZGxlciI6eyJzdWNjZXNzIjp0cnVlfSwia2luZCI6Imludm9rZWQifSwiZW5kZWRBdCI6IjIwMjYtMTEtMTRUMTI6MjQ6MTAuMzY0WiIsImV2ZW50cyI6W10sImluZGV4IjowLCJvYnNlcnZhdGlvblN0cmVhbUlkIjoiaGlzdG9yaWNhbC1zNy13cml0ZXIiLCJvbkZhaWwiOiJzdG9wIiwic3RhcnRlZEF0IjoiMjAyNi0xMS0xNFQxMjoyNDoxMC4zNjRaIiwidG9vbCI6ImV4YXJjaG9zX29yY2hlc3RyYXRlIiwidmVyZGljdCI6eyJzdGF0dXMiOiJwYXNzZWQifX0seyJhY3Rpb24iOiJjcmVhdGVfcHIiLCJhcmdzIjp7ImJhc2UiOiJtYWluIiwiYm9keSI6IiMjIFN1bW1hcnlcblxuSGlzdG9yaWNhbCBmaXh0dXJlLlxuXG4jIyBDaGFuZ2VzXG5cbi0gT3JpZ2luYWwgZWZmZWN0LlxuXG4jIyBUZXN0IFBsYW5cblxuLSBSZWFsIHN0b3JlZCBjdXN0b2R5LlxuIiwiZmVhdHVyZUlkIjoiaGlzdG9yaWNhbC1zNy13cml0ZXIiLCJoZWFkIjoiZmVhdHVyZS9oaXN0b3J5IiwidGl0bGUiOiJmZWF0OiByZXRhaW4gb3JpZ2luYWwgd3JpdGVyIGN1c3RvZHkifSwiZGlzcG9zaXRpb24iOnsiaGFuZGxlciI6eyJzdWNjZXNzIjp0cnVlfSwia2luZCI6Imludm9rZWQifSwiZW5kZWRBdCI6IjIwMjYtMTEtMTRUMTI6MjQ6MTAuMzY1WiIsImV2ZW50cyI6W3sic2VxdWVuY2UiOjEsInN0cmVhbUlkIjoidmNzIiwidHlwZSI6InByLmNyZWF0ZS5yZXF1ZXN0ZWQifSx7InNlcXVlbmNlIjoyLCJzdHJlYW1JZCI6InZjcyIsInR5cGUiOiJwci5jcmVhdGUuZXhlY3V0ZWQifV0sImluZGV4IjoxLCJvYnNlcnZhdGlvblN0cmVhbUlkIjoidmNzIiwib25GYWlsIjoic3RvcCIsInN0YXJ0ZWRBdCI6IjIwMjYtMTEtMTRUMTI6MjQ6MTAuMzY0WiIsInRvb2wiOiJleGFyY2hvc19vcmNoZXN0cmF0ZSIsInZlcmRpY3QiOnsic3RhdHVzIjoicGFzc2VkIn19XSwib3BlcmF0aW9uSWQiOiJoaXN0b3J5LWludGVycnVwdGVkIiwib3V0Y29tZSI6ImNvbW1pdHRlZCIsInJlcXVlc3REaWdlc3QiOiJzaGEyNTY6OWFkYjgzMDgyMTVmNTQ3MTFmOTZkNDQzM2IxNjA3M2U5ZDQ1ZTRhYmE4OTFhNGQyNjY3M2E5N2M2ZmUxZDlkYiIsInN0cmVhbUlkIjoiaGlzdG9yaWNhbC1zNy13cml0ZXIiLCJ0YWlsU2VxdWVuY2UiOjB9Cg==",
    "terminalClaim": null,
    "retry": {
      "success": true,
      "data": {
        "operationId": "history-interrupted",
        "intent": "synthesis-closeout",
        "outcome": "committed",
        "leaves": [
          {
            "action": "validate_pr_body",
            "status": "passed",
            "events": []
          },
          {
            "action": "create_pr",
            "status": "passed",
            "events": [
              {
                "type": "pr.create.requested",
                "streamId": "vcs",
                "sequence": 1
              },
              {
                "type": "pr.create.executed",
                "streamId": "vcs",
                "sequence": 2
              }
            ]
          }
        ],
        "tailSequence": 0,
        "requestDigest": "sha256:9adb8308215f54711f96d4433b16073e9d45e4aba891a4d26673a97c6fe1d9db",
        "interaction": {
          "leavesExecuted": 2,
          "eventsAppended": 2,
          "requests": 1,
          "deferred": [
            "correction-call-rate",
            "schema-rediscovery",
            "tokens-net-of-refetch",
            "suspensions"
          ]
        },
        "bundleRefs": [
          {
            "artifactId": "run-bundle:execute-intent-run:history-interrupted",
            "digest": {
              "algorithm": "sha256",
              "value": "a796f4c567ca4a0d10bf81a555afcc531b00d87e802a8003b1f1545cf6250565"
            }
          }
        ]
      }
    },
    "postRetryClaim": {
      "streamId": "historical-s7-writer",
      "requestDigest": "sha256:9adb8308215f54711f96d4433b16073e9d45e4aba891a4d26673a97c6fe1d9db",
      "result": {
        "operationId": "history-interrupted",
        "intent": "synthesis-closeout",
        "outcome": "committed",
        "leaves": [
          {
            "action": "validate_pr_body",
            "status": "passed",
            "events": []
          },
          {
            "action": "create_pr",
            "status": "passed",
            "events": [
              {
                "type": "pr.create.requested",
                "streamId": "vcs",
                "sequence": 1
              },
              {
                "type": "pr.create.executed",
                "streamId": "vcs",
                "sequence": 2
              }
            ]
          }
        ],
        "tailSequence": 0,
        "requestDigest": "sha256:9adb8308215f54711f96d4433b16073e9d45e4aba891a4d26673a97c6fe1d9db",
        "interaction": {
          "leavesExecuted": 2,
          "eventsAppended": 2,
          "requests": 1,
          "deferred": [
            "correction-call-rate",
            "schema-rediscovery",
            "tokens-net-of-refetch",
            "suspensions"
          ]
        },
        "bundleRefs": [
          {
            "artifactId": "run-bundle:execute-intent-run:history-interrupted",
            "digest": {
              "algorithm": "sha256",
              "value": "a796f4c567ca4a0d10bf81a555afcc531b00d87e802a8003b1f1545cf6250565"
            }
          }
        ]
      },
      "eventIds": [
        "cd242e60-66d5-4443-a123-192e35858bca"
      ],
      "sequences": [
        2
      ],
      "timestamps": [
        "2026-11-14T12:24:10.371Z"
      ]
    },
    "postRetryRows": [
      {
        "streamId": "historical-s7-writer",
        "timestamp": "2026-11-14T12:24:10.359Z",
        "type": "workflow.started",
        "schemaVersion": "1.0",
        "data": {
          "featureId": "historical-s7-writer",
          "workflowType": "feature",
          "phase": "synthesize",
          "phaseAttemptId": "phase-attempt:historical-s7-writer"
        },
        "sequence": 1,
        "eventId": "59cd1fd2-c9ef-438f-be12-0314a71205b2"
      },
      {
        "type": "orchestrate.intent_executed",
        "data": {
          "operationId": "history-interrupted",
          "intent": "synthesis-closeout",
          "outcome": "committed",
          "leaves": [
            {
              "action": "validate_pr_body",
              "status": "passed",
              "sequences": []
            },
            {
              "action": "create_pr",
              "status": "passed",
              "sequences": [
                1,
                2
              ]
            }
          ],
          "requestDigest": "sha256:9adb8308215f54711f96d4433b16073e9d45e4aba891a4d26673a97c6fe1d9db",
          "bundleRefs": [
            {
              "artifactId": "run-bundle:execute-intent-run:history-interrupted",
              "digest": {
                "algorithm": "sha256",
                "value": "a796f4c567ca4a0d10bf81a555afcc531b00d87e802a8003b1f1545cf6250565"
              }
            }
          ]
        },
        "timestamp": "2026-11-14T12:24:10.371Z",
        "schemaVersion": "1.1",
        "operationId": "44608f02-c3a5-4f21-947d-670b3b535fb7",
        "correlationId": "44608f02-c3a5-4f21-947d-670b3b535fb7",
        "streamId": "historical-s7-writer",
        "sequence": 2,
        "eventId": "cd242e60-66d5-4443-a123-192e35858bca"
      }
    ]
  }
}
`;
