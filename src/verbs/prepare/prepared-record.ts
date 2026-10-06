/**
 * Makes a compiled capsule durable and findable. `commitPreparedCapsule` puts the capsule and its
 * definition in the run-bundle store as one content-addressed document. Then it commits the
 * `workflow.prepared` record that names those bytes. A failed custody write fails the whole
 * preparation, so no record pins bytes that nobody can read back.
 *
 * `settle` judges the capsule that a record pins, read back from custody. A submitted capsule must
 * match the digest of that record. The writer and the reader live in one module, so they agree on
 * the document shape.
 */

import {
  WorkflowDefinitionV1Schema,
  type WorkflowDefinitionV1,
} from '@lvlup-sw/strategos-contracts';
import { z } from 'zod';

import { capsuleDigest, contentDigest } from '../../contract/capsule/capsule-digest.js';
import {
  ExarchosCapsuleV1Schema,
  type ExarchosCapsuleV1,
} from '../../contract/capsule/exarchos-capsule.js';
import { canonicalJson } from '../../contract/request-context.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { outerCorrelation, stampFromAmbient } from '../../dispatch/core/outer-correlation.js';
import { runWithDispatchContext } from '../../dispatch/dispatch-context.js';
import type { BundleRefV1 } from '../../events/bundle/digest-references.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { TaskAssignedData, WorkflowPreparedData, type WorkflowPrepared } from '../../events/schemas.js';
import { ArtifactIdSchema, type ArtifactId } from '../../workflow/admission/types.js';
import type { PreparedCapsuleReceipt } from './types.js';

/** The `kind` discriminator every prepared bundle carries. */
export const PREPARED_BUNDLE_KIND = 'prepared-capsule';

/** The document version. A change that an old reader can misread needs a new version. */
export const PREPARED_BUNDLE_VERSION = '1.0';

/** The payload version `workflow.prepared` rows are stamped with. */
export const WORKFLOW_PREPARED_SCHEMA_VERSION = '1.0';

const WORKFLOW_PREPARED_TYPE = 'workflow.prepared';
const TASK_ASSIGNED_TYPE = 'task.assigned';

export const PreparedBundleV1Schema = z
  .object({
    bundleVersion: z.literal(PREPARED_BUNDLE_VERSION),
    kind: z.literal(PREPARED_BUNDLE_KIND),
    capsule: ExarchosCapsuleV1Schema,
    /** Validated against the published kernel on decode, not trusted as an opaque record. */
    definition: z.record(z.string(), z.unknown()),
  })
  .strict();

export interface PreparedBundleV1 {
  readonly capsule: ExarchosCapsuleV1;
  readonly definition: WorkflowDefinitionV1;
}

/** Encode through the schema first, so a document no reader recognises never reaches custody. */
export function encodePreparedBundle(bundle: PreparedBundleV1): Uint8Array {
  const validated = PreparedBundleV1Schema.parse({
    bundleVersion: PREPARED_BUNDLE_VERSION,
    kind: PREPARED_BUNDLE_KIND,
    capsule: bundle.capsule,
    definition: bundle.definition,
  });
  return Buffer.from(`${canonicalJson(validated)}\n`, 'utf8');
}

/** Decode bytes recovered from custody. Throws on anything either contract refuses. */
export function decodePreparedBundle(bytes: Uint8Array): PreparedBundleV1 {
  const parsed = PreparedBundleV1Schema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  return { capsule: parsed.capsule, definition: WorkflowDefinitionV1Schema.parse(parsed.definition) };
}

/** Names the bundle beside its digest. The store keys bytes by digest, never by this id. */
export function preparedBundleArtifactId(workflowId: string, capsuleVersion: number): ArtifactId {
  return ArtifactIdSchema.parse(`run-bundle:${PREPARED_BUNDLE_KIND}:${workflowId}:${capsuleVersion}`);
}

export interface PreparedCommit {
  readonly streamId: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly workflowType: string;
  readonly capsule: ExarchosCapsuleV1;
  readonly definition: WorkflowDefinitionV1;
  /**
   * The stream tail the compilation read its capsule version from. The commit
   * is refused if the stream has moved since, so two compilations racing for
   * one version cannot both record it.
   */
  readonly expectedSequence?: number;
  /**
   * The compiled tasks that the stream does not know yet. The commit appends one `task.assigned`
   * for each task before the record, so the compilation meets the event contract of the delegate phase.
   * The caller leaves out a task that the stream already shows as assigned, because the projection
   * reads a second announcement as a return to `assigned`.
   */
  readonly announce?: readonly { readonly taskId: string; readonly title: string }[];
}

/**
 * Puts a compiled capsule in custody and commits the record that pins it.
 * The `task.assigned` announcements come first and the record comes last. The sequence of the
 * record, read inside the write lock, is the tail of the receipt.
 * The append goes through `decideOnce`, which the emitter-closure census does not read. The
 * allowance row of the settlement record also covers this route.
 *
 * It throws what the appender throws: a lost race on the stream tail, or an operation claim held by
 * a different request. It returns the canonical receipt of the claim, which is the receipt of the winner on a race.
 */
export async function commitPreparedCapsule(
  ctx: DispatchContext,
  commit: PreparedCommit,
  bundleStore?: RunBundleStore,
): Promise<PreparedCapsuleReceipt> {
  const { streamId, operationId, requestDigest, capsule, definition } = commit;
  const digest = capsuleDigest(capsule);
  const bytes = encodePreparedBundle({ capsule, definition });
  const bundles = bundleStore ?? ctx.eventStore.bundleStore;
  const artifactId = preparedBundleArtifactId(capsule.identity.workflowId, capsule.identity.capsuleVersion);
  const outer = outerCorrelation(ctx);

  return bundles.putThenReference(artifactId, bytes, async (ref: BundleRefV1) => {
    const data: Record<string, unknown> = WorkflowPreparedData.parse({
      operationId,
      workflowId: capsule.identity.workflowId,
      workflowType: commit.workflowType,
      capsuleVersion: capsule.identity.capsuleVersion,
      definitionVersion: capsule.identity.definitionVersion,
      designVersion: capsule.identity.designVersion,
      capsuleDigest: digest,
      compilerVersion: capsule.provenance.compilerVersion,
      taskCount: capsule.graph.tasks.length,
      requestDigest,
      bundleRefs: [ref],
    });

    return runWithDispatchContext(outer, async () => {
      const announcements = (commit.announce ?? []).map((task) =>
        stampFromAmbient({
          type: TASK_ASSIGNED_TYPE,
          data: TaskAssignedData.parse({ taskId: task.taskId, title: task.title }),
          timestamp: capsule.provenance.compiledAt,
        }),
      );
      const record = stampFromAmbient({
        type: WORKFLOW_PREPARED_TYPE,
        data,
        timestamp: capsule.provenance.compiledAt,
        schemaVersion: WORKFLOW_PREPARED_SCHEMA_VERSION,
      });
      const events = [...announcements, record];
      return ctx.eventStore
        .getAppender()
        .decideOnce<PreparedCapsuleReceipt>(operationId, requestDigest, (tx) => ({
          streamId,
          events,
          ...(commit.expectedSequence !== undefined ? { expectedSequence: commit.expectedSequence } : {}),
          result: {
            operationId,
            streamId,
            workflowId: capsule.identity.workflowId,
            capsuleVersion: capsule.identity.capsuleVersion,
            capsuleDigest: digest,
            definitionVersion: capsule.identity.definitionVersion,
            capsule,
            tailSequence: tx.readStream(streamId).version + events.length,
            bundleRefs: [ref],
          },
        }));
    });
  });
}

export type PreparedLookup =
  | {
      readonly found: true;
      readonly record: WorkflowPrepared;
      /** The stream sequence of the record. A row with a higher sequence came after the compilation. */
      readonly sequence: number;
      readonly capsule: ExarchosCapsuleV1;
      readonly definition: WorkflowDefinitionV1;
    }
  | { readonly found: false };

/**
 * Finds the prepared record for one capsule version on one workflow stream, and reads the capsule
 * and definition back from custody. It matches by version alone, because versions are per stream.
 * The digest comparison checks which workflow a submitted capsule claims to be.
 * `found: false` means that no record exists. Custody bytes that do not match their record throw,
 * because that is corruption and a "not prepared" answer sends the caller to compile again.
 * A capsule that names a definition digest other than the definition in its bundle also throws.
 *
 * The lookup also gives the stream sequence of the record that it found.
 */
export async function findPreparedCapsule(
  ctx: DispatchContext,
  streamId: string,
  capsuleVersion: number,
  bundleStore?: RunBundleStore,
): Promise<PreparedLookup> {
  const rows = await ctx.eventStore.query(streamId, { type: WORKFLOW_PREPARED_TYPE });
  let latest: { readonly record: WorkflowPrepared; readonly sequence: number } | undefined;
  for (const row of rows) {
    const parsed = WorkflowPreparedData.safeParse(row.data);
    if (!parsed.success || parsed.data.capsuleVersion !== capsuleVersion) continue;
    latest = { record: parsed.data, sequence: row.sequence };
  }
  if (latest === undefined) return { found: false };
  const { record, sequence } = latest;

  const ref = record.bundleRefs[0];
  if (ref === undefined) return { found: false };
  const bundles = bundleStore ?? ctx.eventStore.bundleStore;
  const decoded = decodePreparedBundle(await bundles.resolve(ref.digest));
  const actual = capsuleDigest(decoded.capsule);
  if (actual !== record.capsuleDigest) {
    throw new Error(
      `the prepared capsule v${capsuleVersion} on '${streamId}' is in custody under a digest its ` +
        `record did not pin (record ${record.capsuleDigest}, bytes ${actual})`,
    );
  }
  const definitionDigest = contentDigest(decoded.definition);
  if (definitionDigest !== decoded.capsule.identity.definitionVersion) {
    throw new Error(
      `the prepared capsule v${capsuleVersion} on '${streamId}' names definition ` +
        `${decoded.capsule.identity.definitionVersion} and its bundle carries ${definitionDigest}`,
    );
  }
  return { found: true, record, sequence, capsule: decoded.capsule, definition: decoded.definition };
}
