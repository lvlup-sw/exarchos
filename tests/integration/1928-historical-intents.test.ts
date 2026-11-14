// @oracle-sources: persisted SQLite operation membership and original content-addressed run bytes, a separately maintained fake remote creation log, and the frozen S7 request digest recipe
/** Capture shipped S7 writer behavior before retirement, without contacting a remote service. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../../src/events/store.js';
import { runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { handleExecuteIntent, productionExecuteDeps, derivedLeafOperationId } from '../../src/verbs/execute/executor.js';
import { decodeExecuteIntentBundle } from '../../src/verbs/execute/run-bundle.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../tools/test-helpers/trusted-context.js';
import { fixtureCorrelation, fixtureWiring, receiptOf } from '../unit/verbs/execute/fixtures.js';
import type { VcsProvider } from '../../src/vcs/provider.js';

vi.mock('../../src/vcs/factory.js', () => ({ createVcsProvider: vi.fn() }));
import { createVcsProvider } from '../../src/vcs/factory.js';

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

/** Only the remote transport is fake. The live compiler, handlers, append/claim and custody store remain real. */
async function fixture() {
  const state = makeTempDir('1928-history-'); const events = new EventStore(state); await events.initialize();
  closes.push(async () => { events.close(); await rmrfAsync(state); });
  await seedActivePhaseAttempt(events, STREAM, { phase: 'synthesize' });
  const opened: { number: number; url: string; headRefName: string; baseRefName: string }[] = [];
  const provider: VcsProvider = { name: 'github',
    createPr: vi.fn(async input => { const pr = { number: 42, url: 'https://example.invalid/pr/42', headRefName: input.headBranch, baseRefName: input.baseBranch }; opened.push(pr); return { number: pr.number, url: pr.url }; }),
    listPrs: vi.fn(async () => [...opened]), checkCi: vi.fn(), mergePr: vi.fn(), addComment: vi.fn(), getReviewStatus: vi.fn(),
    addReply: vi.fn(), searchIssuesByMarker: vi.fn(), getPrComments: vi.fn(), getPrDiff: vi.fn(), createIssue: vi.fn(), getRepository: vi.fn(),
  };
  vi.mocked(createVcsProvider).mockResolvedValue(provider);
  const run = (operationId: string, args: Record<string, unknown> = ARGS, retired = false) => runWithDispatchContext(fixtureCorrelation(), () =>
    handleExecuteIntent({ intent: INTENT, streamId: STREAM, operationId, args }, state, fixtureWiring(state, events),
      { ...productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'), ...(retired ? { runbookTable: [] } : {}) }));
  return { events, run, opened, provider, backend: events.getAppender().ensureSqliteBackendSync() };
}

describe('S7 historical writer provenance', () => {
  it('LegacySynthesis_ActualTerminalAndInterruptedCustody', async () => {
    const f = await fixture(); const operationId = 'history-terminal';
    const first = await f.run(operationId); expect(first.success, JSON.stringify(first)).toBe(true);
    const receipt = receiptOf(first);
    expect(receipt.outcome).toBe('committed'); expect(f.opened).toHaveLength(1);
    expect(receipt.requestDigest).toBe(historicalDigest(ARGS));
    const claim = f.backend.lookupOperationClaim(operationId); if (claim === undefined) throw new Error('Missing actual terminal claim');
    const rows = await f.events.query(STREAM); const vcsRows = await f.events.query('vcs');
    expect(claim.result).toEqual(receipt);
    expect(vcsRows.filter(row => row.operationId === derivedLeafOperationId(operationId, 1, 'create_pr')).map(row => row.type)).toEqual(['pr.create.requested', 'pr.create.executed']);
    const ref = receipt.bundleRefs?.[0]; if (ref === undefined) throw new Error('Missing original run custody');
    const bytes = await f.events.bundleStore.resolve(ref.digest); const bundle = decodeExecuteIntentBundle(bytes);
    expect(bundle.requestDigest).toBe(claim.requestDigest); expect(bundle.operationId).toBe(operationId); expect(bundle).not.toHaveProperty('input');
    for (const [index, sequence] of claim.sequences.entries()) {
      const row = rows.find(row => row.sequence === sequence); expect(row).toMatchObject({ eventId: claim.eventIds[index], timestamp: claim.timestamps[index], type: 'orchestrate.intent_executed' });
    }
    const reordered = { headBranch: ARGS.headBranch, baseBranch: ARGS.baseBranch, prBody: ARGS.prBody, title: ARGS.title };
    expect((await f.run(operationId, reordered)).data).toEqual(receipt);
    expect(await f.events.query(STREAM)).toEqual(rows); expect(await f.events.query('vcs')).toEqual(vcsRows); expect(f.opened).toHaveLength(1);
    expect(await f.run(operationId, { ...ARGS, title: 'changed' })).toMatchObject({ success: false, error: { code: 'INTENT_REPLAY_DIGEST_MISMATCH' } });
    expect((await f.run(operationId, { ...ARGS, unknown: true })).success).toBe(false);
    expect(await f.run(operationId, ARGS, true)).toMatchObject({ success: false, error: { code: 'INTENT_UNKNOWN' } });
    expect(f.opened).toHaveLength(1);

    const interrupted = await fixture(); const interruptedId = 'history-interrupted';
    const put = interrupted.events.bundleStore.put.bind(interrupted.events.bundleStore); const captured: string[] = [];
    vi.spyOn(interrupted.events.bundleStore, 'put').mockImplementation(async bytes => { captured.push(Buffer.from(bytes).toString('base64')); return put(bytes); });
    const appender = interrupted.events.getAppender(); const decide = appender.decideOnce.bind(appender);
    const fault = vi.spyOn(appender, 'decideOnce').mockImplementation(async (...args) => { if (args[0] === interruptedId) throw new Error('Fixture crash before terminal claim'); return decide(...args); });
    await expect(interrupted.run(interruptedId)).rejects.toThrow('Fixture crash before terminal claim'); fault.mockRestore();
    expect(interrupted.opened).toHaveLength(1); expect(interrupted.backend.lookupOperationClaim(interruptedId)).toBeUndefined();
    const interruptedRows = await interrupted.events.query(STREAM); const interruptedVcs = await interrupted.events.query('vcs');
    expect(interruptedRows.filter(row => row.type === 'orchestrate.intent_executed')).toHaveLength(0);
    expect(interruptedVcs.map(row => row.type)).toEqual(['pr.create.requested', 'pr.create.executed']);
    const originalRuns = captured.map(base64 => Buffer.from(base64, 'base64')).filter(value => JSON.parse(value.toString()).kind === 'execute-intent-run');
    expect(originalRuns).toHaveLength(1);
    expect(decodeExecuteIntentBundle(originalRuns[0] ?? Buffer.alloc(0)).requestDigest).toBe(historicalDigest(ARGS));
    const beforeRetry = [...interrupted.opened]; const retry = await interrupted.run(interruptedId);
    expect(retry.success, JSON.stringify(retry)).toBe(true); expect(interrupted.opened).toEqual(beforeRetry);
    expect(interrupted.backend.lookupOperationClaim(interruptedId)?.result).toEqual(receiptOf(retry));
    expect(await interrupted.events.query('vcs')).toEqual(interruptedVcs);
    const saved = frozenHistory();
    expect(saved.requestDigest).toBe(historicalDigest(ARGS));
    expect(saved.args).toEqual(ARGS);
    expect(saved.terminal.operationId).toBe(operationId);
    expect(saved.interrupted.operationId).toBe(interruptedId);
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

/** Parse frozen custody without regenerating original event IDs, timestamps or content-addressed bytes. */
function frozenHistory() {
  const originalBytes = Buffer.from(FROZEN_HISTORY_JSON, 'utf8');
  expect(createHash('sha256').update(originalBytes).digest('hex')).toBe('6b7adea884869122fd3061477adf9715100bae62a2c06db432450dd44133d0c1');
  const row = z.object({ sequence: z.number(), eventId: z.string(), timestamp: z.string(), operationId: z.string().optional(), type: z.string() }).passthrough();
  const claim = z.object({ streamId: z.string(), requestDigest: z.string(), result: z.unknown(), sequences: z.array(z.number()), eventIds: z.array(z.string()), timestamps: z.array(z.string()) });
  return z.object({
    capturedFrom: z.string(), args: z.record(z.string(), z.unknown()), requestDigest: z.string(),
    terminal: z.object({ operationId: z.string(), claim, rows: z.array(row), runBytesBase64: z.string() }),
    interrupted: z.object({ operationId: z.string(), terminalClaim: z.null(), rows: z.array(row), vcsRows: z.array(row), runBytesBase64: z.string(), retry: z.object({ data: z.unknown() }), postRetryClaim: claim, postRetryRows: z.array(row) }),
  }).parse(JSON.parse(originalBytes.toString('utf8')));
}

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
