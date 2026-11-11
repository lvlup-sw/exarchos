/**
 * A test-only copy of one workflow stream and its run bundles into a fresh store.
 *
 * The copy goes through the appender of the target store, so it also carries the reserved ledger kinds.
 * It makes one append for each run of rows that share an idempotency key, and one append for each row with no key.
 * It copies each bundle that a copied row names, and each bundle that a copied settlement bundle names, by digest.
 * It copies no operation claim, so a retry in the target compiles or settles again.
 * A keyed run whose key holds no idempotency claim in the source goes through the unkeyed append, and each row keeps its key.
 * Cleanup and cancel write such trails, so the target holds no claim for them either.
 *
 * No module under `src/` or `tools/` imports this module. An architecture test holds that rule.
 */
import type { EventInput } from '../../../src/events/atomic-appender.js';
import { extractBundleRefs } from '../../../src/events/bundle/digest-references.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { EventStore } from '../../../src/events/store.js';
import { ContentAddressedStoreError } from '../../../src/storage/artifacts/content-addressed-store.js';
import { decodeSettlementBundle } from '../../../src/verbs/settle/settlement-bundle.js';
import type { ContentDigestV1 } from '../../../src/workflow/admission/types.js';

/** The refusals of the copy. Each one stops the copy, and the scratch target is then of no use. */
export type WorkflowReplayErrorCode =
  | 'TARGET_NOT_EMPTY'
  | 'KEY_REUSED'
  | 'BOUND_SPLITS_A_RUN'
  | 'BUNDLE_MISSING'
  | 'SEQUENCE_DRIFT';

/** A refused copy. The message starts with the code. */
export class WorkflowReplayError extends Error {
  readonly code: WorkflowReplayErrorCode;

  constructor(code: WorkflowReplayErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'WorkflowReplayError';
    this.code = code;
  }
}

/** The options of one copy. `throughSequence` copies the rows at or below that sequence, and it must end a run. */
export interface CopyWorkflowStreamOptions {
  readonly throughSequence?: number;
}

/** The result of one copy: the source rows that it copied, in sequence order, and each bundle digest that it copied once. */
export interface CopiedStream {
  readonly rows: readonly WorkflowEvent[];
  readonly digests: readonly ContentDigestV1[];
}

/** The longest sequence of consecutive rows that share one idempotency key. A row with no key is a run of its own. */
interface Run {
  readonly key: string | undefined;
  readonly rows: readonly WorkflowEvent[];
  readonly first: number;
  readonly last: number;
}

/** The row type of a settlement record. Its bundle names the bundles of the verification segments. */
const SETTLEMENT_RECORD_TYPE = 'execution.settled';

/** The text form of a digest, as a message names it. */
function digestText(digest: ContentDigestV1): string {
  return `${digest.algorithm}:${digest.value}`;
}

/** Splits the rows into runs. A keyed row joins the run before it when the run has the same key. */
function runsOf(rows: readonly WorkflowEvent[]): Run[] {
  const runs: Run[] = [];
  let open: { key: string; rows: WorkflowEvent[] } | undefined;
  const close = (): void => {
    if (open === undefined) return;
    runs.push(runOf(open.key, open.rows));
    open = undefined;
  };
  for (const row of rows) {
    const key = row.idempotencyKey;
    if (key !== undefined && open !== undefined && open.key === key) {
      open.rows.push(row);
      continue;
    }
    close();
    if (key === undefined) runs.push(runOf(undefined, [row]));
    else open = { key, rows: [row] };
  }
  close();
  return runs;
}

/** One run with the sequences of its first and its last row. */
function runOf(key: string | undefined, rows: readonly WorkflowEvent[]): Run {
  const first = rows[0]?.sequence ?? 0;
  const last = rows[rows.length - 1]?.sequence ?? first;
  return { key, rows, first, last };
}

/** Refuses two runs that are not consecutive and share one key. A keyed append of the second run is a cache hit. */
function refuseReusedKeys(runs: readonly Run[]): void {
  const seen = new Map<string, number>();
  for (const run of runs) {
    if (run.key === undefined) continue;
    const earlier = seen.get(run.key);
    if (earlier !== undefined) {
      throw new WorkflowReplayError(
        'KEY_REUSED',
        `the key ${JSON.stringify(run.key)} holds the run at sequence ${earlier} and the run at sequence ${run.first}`,
      );
    }
    seen.set(run.key, run.first);
  }
}

/** The runs at or below the bound. A bound inside a keyed run refuses, because a part of a keyed append cannot exist. */
function runsThrough(runs: readonly Run[], bound: number): Run[] {
  const kept: Run[] = [];
  for (const run of runs) {
    if (run.last <= bound) {
      kept.push(run);
      continue;
    }
    if (run.first <= bound) {
      throw new WorkflowReplayError(
        'BOUND_SPLITS_A_RUN',
        `the bound ${bound} falls inside the run of key ${JSON.stringify(run.key)} from sequence ${run.first} to ${run.last}`,
      );
    }
    break;
  }
  return kept;
}

/** Reads the bytes of one digest from the source. A digest that does not resolve refuses with the sequence of its row. */
async function resolveIn(source: EventStore, digest: ContentDigestV1, sequence: number): Promise<Buffer> {
  try {
    return await source.bundleStore.resolve(digest);
  } catch (error) {
    if (error instanceof ContentAddressedStoreError) {
      throw new WorkflowReplayError(
        'BUNDLE_MISSING',
        `the digest ${digestText(digest)} that the row at sequence ${sequence} names does not resolve in the source (${error.code})`,
      );
    }
    throw error;
  }
}

/**
 * Copies each bundle that the rows name, and each bundle that the verification traces of a settlement bundle name.
 * Each write gives the expected digest, so a changed byte fails it. Each digest is copied once.
 */
async function copyBundles(source: EventStore, target: EventStore, rows: readonly WorkflowEvent[]): Promise<ContentDigestV1[]> {
  const copied = new Map<string, ContentDigestV1>();
  const copy = async (digest: ContentDigestV1, sequence: number): Promise<Buffer> => {
    const bytes = await resolveIn(source, digest, sequence);
    if (!copied.has(digestText(digest))) {
      await target.bundleStore.put(bytes, digest);
      copied.set(digestText(digest), digest);
    }
    return bytes;
  };
  for (const row of rows) {
    for (const ref of extractBundleRefs(row).refs) {
      const bytes = await copy(ref.digest, row.sequence);
      if (row.type !== SETTLEMENT_RECORD_TYPE) continue;
      for (const trace of decodeSettlementBundle(bytes).verification ?? []) {
        for (const segment of trace.bundleRefs ?? []) await copy(segment.digest, row.sequence);
      }
    }
  }
  return [...copied.values()];
}

/** The appender input of one row: each field of the row except its sequence and its event id. */
function appenderInput(row: WorkflowEvent): EventInput {
  const { sequence, ...input } = row;
  Reflect.deleteProperty(input, 'eventId');
  return input;
}

/** The key of the claim that the copy of a run writes. A run whose key holds no claim in the source gets no claim. */
function claimKeyOf(source: EventStore, streamId: string, run: Run): string | undefined {
  if (run.key === undefined) return undefined;
  const claim = source.getAppender().ensureSqliteBackendSync().lookupIdempotencyClaim(streamId, run.key);
  return claim === undefined ? undefined : run.key;
}

/** Appends one run to the target and checks that each copied row gets the sequence of its source row. */
async function appendRun(source: EventStore, target: EventStore, streamId: string, run: Run): Promise<void> {
  const appender = target.getAppender();
  const inputs = run.rows.map(appenderInput);
  const key = claimKeyOf(source, streamId, run);
  const result = key === undefined ? await appender.appendUnkeyed(streamId, inputs) : await appender.append(streamId, inputs, key);
  if (!result.ok) {
    throw new Error(`the target store refused the run at sequence ${run.first}: ${result.reason}`, { cause: result.cause });
  }
  const expected = run.rows.map((row) => row.sequence);
  if (result.sequences.length !== expected.length || result.sequences.some((sequence, index) => sequence !== expected[index])) {
    throw new WorkflowReplayError(
      'SEQUENCE_DRIFT',
      `the run at sequence ${run.first} got the sequences ${JSON.stringify(result.sequences)} in place of ${JSON.stringify(expected)}`,
    );
  }
}

/**
 * Copies one stream of the source into the target, in sequence order, with its bundles.
 * The checks of the target, the keys and the bound come before the first write, and the bundles come before the rows.
 */
export async function copyWorkflowStream(
  source: EventStore,
  target: EventStore,
  streamId: string,
  options: CopyWorkflowStreamOptions = {},
): Promise<CopiedStream> {
  const held = await target.query(streamId);
  if (held.length > 0) {
    throw new WorkflowReplayError('TARGET_NOT_EMPTY', `the target already holds ${held.length} row(s) of '${streamId}'`);
  }
  const runs = runsOf(await source.query(streamId));
  refuseReusedKeys(runs);
  const copied = options.throughSequence === undefined ? runs : runsThrough(runs, options.throughSequence);
  const rows = copied.flatMap((run) => run.rows);
  const digests = await copyBundles(source, target, rows);
  for (const run of copied) await appendRun(source, target, streamId, run);
  return { rows, digests };
}
