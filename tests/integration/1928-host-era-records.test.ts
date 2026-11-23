// @oracle-sources: frozen bytes that the host-era build wrote with its own verifier request, evidence signing and digest helpers, pinned by SHA-256, and SQLite rows read directly
/**
 * Records that the retired verifier host left in a governor store read with their original results.
 * The host-era build produced each frozen text. The settle encoders and the canonical encoding did not change after that build.
 *
 * The governor stored the verifier request, its attempt binding, the settlement bundle and the task segment, but no evidence body.
 * A settlement bundle keeps only the digest of the signed suite evidence. A task segment keeps the verbatim host refusal of one leaf.
 * The host returned VERIFIER_NOT_PROVISIONED before any gate runner, record or event, so no stored record holds that code.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VerificationRequest, verificationDigest, verificationJson, verificationKey, verificationValueDigest,
} from '../../src/contract/verification/harness-verification.js';
import { EventStore } from '../../src/events/store.js';
import { decodeExecuteIntentBundle, encodeExecuteIntentBundle, receiptLeavesOfRun } from '../../src/verbs/execute/run-bundle.js';
import { IntegrationAttemptBindingV1Schema, IntegrationAttemptRequestV1Schema, integrationAttemptIntact } from '../../src/verbs/settle/integration-attempts.js';
import { decodeSettlementBundle, encodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** The binding operation id that the host-era build derived for the integration attempt. It has no route term. */
const HOST_ATTEMPT = 'settle-integration:310f233803d755b4b8b41216726f24d541b86a2ee5690978bbab5a55e0a600c4';

/** The canonical verifier request of the integration attempt, as the host-era build stored it in the bundle store. */
const REQUEST = String.raw`{"commandDigest":"660defd975f6170589615c870ffcd82e2aae79632f8fe0196e62cfad8cc4a449","key":"f93590f1cc67639febe9a6cc67d5329125e7f4e7e72ee818388b1b574c37da39","operation":"integration-suite","profileId":"integration-suite","resourceId":"integration-checkout","subject":{"acceptedHeads":["12effd7312e2d1e1c98694578ed4a921f7408cfe"],"configDigest":"9115858f7f264a0ce8148364fca11ab88d932d0e5fbe51216017e20de05546f4","headCommit":"12effd7312e2d1e1c98694578ed4a921f7408cfe","outerOperationId":"settle:b558173092175a5badafd8955bc543317771e4466ae11e5bf42b79590852c5cc","phaseAttemptId":"phase-attempt:8110a564d54e62489f90b5cef4590f126ae294aa24d813292a0418841a477d22","preparedDigest":"da82f599d306d4cb0c54de09db71a01588473c5fa3709c046e4a484f1aa40c45","profileDigest":"08c2b36bb8b5e80236bab734eb287ea190f1abed044f85889e582bb9f69ebb87","ref":"refs/heads/integration","scope":"integration","streamId":"integration-capsule"},"version":1}`;

/** The attempt binding payload that names the stored request by its digest. */
const BINDING = String.raw`{"kind":"settle-integration","request":{"algorithm":"sha256","value":"03212ccf8c53b1f7eda560172561cd500264085982c1b3b31cecd20bd0002bf4"},"version":1}`;

/** The signed suite evidence of the host. Only the host held it. The governor kept its digest in the settlement bundle. */
const SIGNED = String.raw`{"evidence":{"completedAt":"2026-11-23T20:15:02.734Z","hostPolicyDigest":"94355bf9b7185a8807a24aabce50fea015a7926c868251f96ec58acd95cc849e","hostVersion":"exarchos-verifier/1","outcome":{"check":{"operation":"integration-suite","report":null,"run":{"end":"exited","exitCode":0,"outputDigest":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","stderr":"","stdout":""}},"exitCode":0,"reason":"","status":"passed","stderrBase64":"","stdoutBase64":""},"request":{"commandDigest":"660defd975f6170589615c870ffcd82e2aae79632f8fe0196e62cfad8cc4a449","key":"f93590f1cc67639febe9a6cc67d5329125e7f4e7e72ee818388b1b574c37da39","operation":"integration-suite","profileId":"integration-suite","resourceId":"integration-checkout","subject":{"acceptedHeads":["12effd7312e2d1e1c98694578ed4a921f7408cfe"],"configDigest":"9115858f7f264a0ce8148364fca11ab88d932d0e5fbe51216017e20de05546f4","headCommit":"12effd7312e2d1e1c98694578ed4a921f7408cfe","outerOperationId":"settle:b558173092175a5badafd8955bc543317771e4466ae11e5bf42b79590852c5cc","phaseAttemptId":"phase-attempt:8110a564d54e62489f90b5cef4590f126ae294aa24d813292a0418841a477d22","preparedDigest":"da82f599d306d4cb0c54de09db71a01588473c5fa3709c046e4a484f1aa40c45","profileDigest":"08c2b36bb8b5e80236bab734eb287ea190f1abed044f85889e582bb9f69ebb87","ref":"refs/heads/integration","scope":"integration","streamId":"integration-capsule"},"version":1},"requestDigest":"03212ccf8c53b1f7eda560172561cd500264085982c1b3b31cecd20bd0002bf4","resources":[{"device":"64768","inode":"1835041","path":"/work/host-era/checkout"},{"device":"64768","inode":"1835044","path":"/work/host-era/checkout/.git"}],"signerId":"ba975baf9cd68b5f983427d9155ec1332c7fe7c25d5a6d7d9026d83702ef2b90","version":1},"signature":"voYEKVT+ySCKllWyAGdzg+Ic9pqneymTqtrY/LHB1nJiPtKM+fbMi0KN91yQn2f5GmZhAtPBGC/517alT7hZAg=="}`;

/** The settlement bundle of an accepted batch that the host judged at the integration tip, without its trailing newline. */
const SETTLEMENT = String.raw`{"acceptedTasks":["root"],"adjudicated":{"claims":1,"decisions":0,"deviations":0,"evidence":0,"fields":8,"requiredResults":1,"verification":1},"bundleVersion":"1.0","capsule":{"batchId":"landed","capsuleVersion":1,"definitionVersion":"2da84c593518cde93da6282a08f504e343215b008289389e8f97661bf1a7f6eb","designVersion":"design-v1","workflowId":"integration-capsule"},"claims":[{"evidence":[],"fields":{"branch":"task/root","worktreePath":"/work/host-era/worktree-root"},"taskId":"root"}],"decisions":[],"deviations":[],"findings":[],"integration":{"attemptBinding":"settle-integration:310f233803d755b4b8b41216726f24d541b86a2ee5690978bbab5a55e0a600c4","observedAt":"2026-11-23T20:15:03.634Z","ref":"refs/heads/integration","suiteEvidenceDigest":"e7c5410e6155a2713e4da99fba18f349e8dd19c2f62a8874e67a7c430f9c33d5","tip":"12effd7312e2d1e1c98694578ed4a921f7408cfe"},"kind":"settlement-adjudication","operationId":"settle:b558173092175a5badafd8955bc543317771e4466ae11e5bf42b79590852c5cc","outcome":"settled","requestDigest":"sha256:f06657dbe53dae0bc36eaf69cb86bcdd14c1b98e3e6e8bd57c2b957faa5045b8","settledAt":"2026-11-23T20:15:03.697Z","streamId":"integration-capsule","verification":[{"bundleRefs":[{"artifactId":"run-bundle:execute-intent-run:settle-task:c7e28000a0ca5101de6889e4d34195608f605a5d9266b3ea073c32a4b5394078","digest":{"algorithm":"sha256","value":"a3259b9b3f12a53fb9eede7c78fa8d16f7736538822e95d90221556d69196aea"}}],"coordinate":{"blockers":[],"capsule":{"capsuleVersion":1,"definitionVersion":"2da84c593518cde93da6282a08f504e343215b008289389e8f97661bf1a7f6eb","designVersion":"design-v1","workflowId":"integration-capsule"},"diffBaseCommit":"af94fbc959147f5518782434884c3d7a6d5846e3","observedHeadCommit":"12effd7312e2d1e1c98694578ed4a921f7408cfe","protocolVersion":"1","repository":"/work/host-era/checkout/.git","rootBaseCommit":"af94fbc959147f5518782434884c3d7a6d5846e3","taskId":"root"},"operationId":"settle-task:c7e28000a0ca5101de6889e4d34195608f605a5d9266b3ea073c32a4b5394078","outcome":"verified","taskId":"root","treeCommit":"12effd7312e2d1e1c98694578ed4a921f7408cfe"}]}`;

/** The task segment run bundle whose contract-drift leaf got the host refusal, without its trailing newline. */
const REFUSED_SEGMENT = String.raw`{"bundleVersion":"1.0","failedLeaf":"check_contract_drift","failure":{"code":"INTENT_SEGMENT_FAILED","message":"leaf 'check_contract_drift' failed: The verifier refused the request: The checkout has uncommitted changes. Commit them first."},"input":{"args":{"baseRef":"integration","boundaryTouching":false,"branch":"task/root","capsuleVersion":1,"coordinate":{"blockers":[],"capsule":{"capsuleVersion":1,"definitionVersion":"2da84c593518cde93da6282a08f504e343215b008289389e8f97661bf1a7f6eb","designVersion":"design-v1","workflowId":"integration-capsule"},"diffBaseCommit":"af94fbc959147f5518782434884c3d7a6d5846e3","observedHeadCommit":"12effd7312e2d1e1c98694578ed4a921f7408cfe","protocolVersion":"1","repository":"/work/host-era/checkout/.git","rootBaseCommit":"af94fbc959147f5518782434884c3d7a6d5846e3","taskId":"root"},"result":{"branch":"task/root","worktreePath":"/work/host-era/worktree-root"},"riskTier":"low","taskId":"root","worktreePath":"/work/host-era/worktree-root"},"intent":"task-completion","streamId":"integration-capsule"},"intent":"task-completion","interaction":{"deferred":["correction-call-rate","schema-rediscovery","tokens-net-of-refetch","suspensions"],"eventsAppended":2,"leavesExecuted":2,"requests":1},"kind":"execute-intent-run","leaves":[{"action":"check_test_adequacy","args":{"baseBranch":"integration","boundaryTouching":false,"branch":"task/root","coordinate":{"blockers":[],"capsule":{"capsuleVersion":1,"definitionVersion":"2da84c593518cde93da6282a08f504e343215b008289389e8f97661bf1a7f6eb","designVersion":"design-v1","workflowId":"integration-capsule"},"diffBaseCommit":"af94fbc959147f5518782434884c3d7a6d5846e3","observedHeadCommit":"12effd7312e2d1e1c98694578ed4a921f7408cfe","protocolVersion":"1","repository":"/work/host-era/checkout/.git","rootBaseCommit":"af94fbc959147f5518782434884c3d7a6d5846e3","taskId":"root"},"featureId":"integration-capsule","repoRoot":"auto","riskTier":"low","taskId":"root","worktreePath":"/work/host-era/worktree-root"},"disposition":{"handler":{"success":true},"kind":"invoked"},"endedAt":"2026-11-23T20:15:02.409Z","events":[{"sequence":13,"streamId":"integration-capsule","type":"admission.evidence-recorded"},{"sequence":14,"streamId":"integration-capsule","type":"gate.executed"}],"index":0,"observationStreamId":"integration-capsule","onFail":"stop","startedAt":"2026-11-23T20:15:02.232Z","tool":"exarchos_orchestrate","verdict":{"status":"passed"}},{"action":"check_contract_drift","args":{"baseBranch":"integration","boundaryTouching":false,"branch":"task/root","coordinate":{"blockers":[],"capsule":{"capsuleVersion":1,"definitionVersion":"2da84c593518cde93da6282a08f504e343215b008289389e8f97661bf1a7f6eb","designVersion":"design-v1","workflowId":"integration-capsule"},"diffBaseCommit":"af94fbc959147f5518782434884c3d7a6d5846e3","observedHeadCommit":"12effd7312e2d1e1c98694578ed4a921f7408cfe","protocolVersion":"1","repository":"/work/host-era/checkout/.git","rootBaseCommit":"af94fbc959147f5518782434884c3d7a6d5846e3","taskId":"root"},"featureId":"integration-capsule","repoRoot":"auto","riskTier":"low","taskId":"root","worktreePath":"/work/host-era/worktree-root"},"disposition":{"handler":{"error":{"code":"HOSTED_VERIFICATION_REFUSED","message":"The verifier refused the request: The checkout has uncommitted changes. Commit them first."},"success":false},"kind":"invoked"},"endedAt":"2026-11-23T20:15:02.602Z","events":[],"index":1,"observationStreamId":"integration-capsule","onFail":"stop","startedAt":"2026-11-23T20:15:02.409Z","tool":"exarchos_orchestrate","verdict":{"failure":{"code":"INTENT_SEGMENT_FAILED","message":"leaf 'check_contract_drift' failed: The verifier refused the request: The checkout has uncommitted changes. Commit them first."},"status":"failed"}}],"operationId":"settle-task:c7e28000a0ca5101de6889e4d34195608f605a5d9266b3ea073c32a4b5394078","outcome":"failed","requestDigest":"sha256:8990161c73e5275d3080a34e49883548df5420feb06bd65d3a6665c07c637ef7","steering":{"boundaryTouching":false,"riskTier":"low","source":"capsule"},"streamId":"integration-capsule","tailSequence":14}`;

/** The SHA-256 of one text. */
function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Every durable row and claim of a store, with its exact serialized payload. */
function durableSnapshot(stateDir: string): { readonly events: unknown[]; readonly claims: unknown[] } {
  const db = new Database(join(stateDir, 'exarchos.db'));
  try {
    return { events: db.prepare('SELECT * FROM events ORDER BY streamId,sequence').all(),
      claims: db.prepare('SELECT * FROM idempotency_claims ORDER BY streamId,idempotencyKey').all() };
  } finally { db.close(); }
}

describe('host-era records in a governor store', () => {
  /** The frozen texts keep their bytes. A recapture or a normalization changes a digest and fails here. */
  it('HostEraRecords_FrozenTexts_KeepTheirDigests', () => {
    expect(sha256(REQUEST)).toBe('03212ccf8c53b1f7eda560172561cd500264085982c1b3b31cecd20bd0002bf4');
    expect(sha256(SIGNED)).toBe('e7c5410e6155a2713e4da99fba18f349e8dd19c2f62a8874e67a7c430f9c33d5');
    expect(sha256(`${SETTLEMENT}\n`)).toBe('0444fc3bbf67c7e7f0e58554c0dd753d8912a156cb6f00e24ecfffb93c981b7a');
    expect(sha256(`${REFUSED_SEGMENT}\n`)).toBe('c32ad2fe14feb56104c79d8d9d95520a587049dd66e0bb67f410fe74fe48f6ff');
  });

  /**
   * The settlement bundle decodes and encodes to its frozen bytes. Its integration record names the host attempt and the host evidence digest.
   * That digest is the canonical digest of the signed evidence, and the evidence names the digest of the stored request.
   */
  it('HostEraSettlementBundle_DecodesAndEncodesToItsFrozenBytes', () => {
    const bytes = Buffer.from(`${SETTLEMENT}\n`, 'utf8');
    const decoded = decodeSettlementBundle(bytes);
    expect(Buffer.from(encodeSettlementBundle(decoded)).toString('utf8')).toBe(bytes.toString('utf8'));
    expect(decoded).toMatchObject({ outcome: 'settled', acceptedTasks: ['root'], findings: [] });
    expect(decoded.integration).toEqual({ ref: 'refs/heads/integration', tip: '12effd7312e2d1e1c98694578ed4a921f7408cfe',
      observedAt: '2026-11-23T20:15:03.634Z', attemptBinding: HOST_ATTEMPT, suiteEvidenceDigest: 'e7c5410e6155a2713e4da99fba18f349e8dd19c2f62a8874e67a7c430f9c33d5' });
    const signed: unknown = JSON.parse(SIGNED);
    expect(verificationJson(signed)).toBe(SIGNED);
    expect(verificationValueDigest(signed)).toBe(decoded.integration?.suiteEvidenceDigest);
    expect(signed).toMatchObject({ evidence: { hostVersion: 'exarchos-verifier/1', requestDigest: sha256(REQUEST) } });
  });

  /**
   * The task segment decodes and encodes to its frozen bytes. The contract-drift leaf keeps the verbatim host refusal, and the run stops at that leaf.
   * The receipt leaves that settlement standing rebuilds from the run read the same failure.
   */
  it('HostEraRefusedSegment_DecodesAndEncodesToItsFrozenBytes', () => {
    const bytes = Buffer.from(`${REFUSED_SEGMENT}\n`, 'utf8');
    const run = decodeExecuteIntentBundle(bytes);
    expect(Buffer.from(encodeExecuteIntentBundle(run)).toString('utf8')).toBe(bytes.toString('utf8'));
    const message = 'The verifier refused the request: The checkout has uncommitted changes. Commit them first.';
    expect(run).toMatchObject({ intent: 'task-completion', outcome: 'failed', failedLeaf: 'check_contract_drift',
      failure: { code: 'INTENT_SEGMENT_FAILED', message: `leaf 'check_contract_drift' failed: ${message}` } });
    expect(run.leaves.map(leaf => leaf.disposition)).toEqual([
      { kind: 'invoked', handler: { success: true } },
      { kind: 'invoked', handler: { success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED', message } } },
    ]);
    expect(receiptLeavesOfRun(run).map(leaf => [leaf.action, leaf.status])).toEqual([['check_test_adequacy', 'passed'], ['check_contract_drift', 'failed']]);
  });

  /**
   * The stored verifier request keeps its canonical bytes, its key and its digest. The binding names it by digest.
   * The local integration request schema refuses it, so the local route never reads it as its own.
   */
  it('HostEraIntegrationRequest_KeepsItsKeyDigestAndBinding', () => {
    const request = VerificationRequest.parse(JSON.parse(REQUEST));
    expect(verificationJson(request)).toBe(REQUEST);
    expect(request.key).toBe('f93590f1cc67639febe9a6cc67d5329125e7f4e7e72ee818388b1b574c37da39');
    expect(verificationKey(request)).toBe(request.key);
    expect(verificationDigest(request)).toBe('03212ccf8c53b1f7eda560172561cd500264085982c1b3b31cecd20bd0002bf4');
    expect(IntegrationAttemptBindingV1Schema.parse(JSON.parse(BINDING)).request).toEqual({ algorithm: 'sha256', value: sha256(REQUEST) });
    expect(IntegrationAttemptRequestV1Schema.safeParse(request).success).toBe(false);
  });

  /**
   * In a store, the host binding, the request and the settlement bundle resolve to their frozen bytes, and the evidence body is absent.
   * The local intact check reads the host binding as no local attempt. It changes no row or claim, and the binding stays the same.
   */
  it('HostEraIntegrationBinding_InAStore_ReadsUnchangedAndIsNoLocalAttempt', async () => {
    const stateDir = makeTempDir('1928-host-era-records-');
    const events = new EventStore(stateDir); await events.initialize();
    cleanup.push(async () => { events.close(); await rmrfAsync(stateDir); });
    const requestRef = await events.bundleStore.put(Buffer.from(REQUEST, 'utf8'));
    const settlementRef = await events.bundleStore.put(Buffer.from(`${SETTLEMENT}\n`, 'utf8'));
    const backend = events.getAppender().ensureSqliteBackendSync();
    expect(backend.bindSegmentInput(HOST_ATTEMPT, BINDING)).toBe(BINDING);
    const before = durableSnapshot(stateDir);
    expect(await integrationAttemptIntact(events, events.bundleStore, HOST_ATTEMPT, REQUEST)).toBe(false);
    expect(backend.lookupSegmentInput(HOST_ATTEMPT)).toBe(BINDING);
    expect((await events.bundleStore.resolve(requestRef)).toString('utf8')).toBe(REQUEST);
    const stored = await events.bundleStore.resolve(settlementRef);
    expect(stored.toString('utf8')).toBe(`${SETTLEMENT}\n`);
    expect(decodeSettlementBundle(stored).integration?.attemptBinding).toBe(HOST_ATTEMPT);
    expect(await events.bundleStore.has({ algorithm: 'sha256', value: sha256(SIGNED) })).toBe('missing');
    expect(durableSnapshot(stateDir)).toEqual(before);
  });
});
