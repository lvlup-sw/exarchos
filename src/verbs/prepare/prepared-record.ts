// ─── The prepared record: a capsule in custody, pinned by digest ─────────────
//
// `prepare` compiles; this module makes a compilation durable and findable.
// The capsule and the definition it pins go to the run-bundle store as one
// content-addressed document FIRST, and only then is the `workflow.prepared`
// record that names those bytes committed. A custody write that fails therefore
// fails the whole preparation — no record, no claim — rather than leaving a pin
// on bytes nobody can read back.
//
// The record is also what settlement trusts. `settle` adjudicates only the
// capsule a record for its version pinned, read back out of custody, and a
// capsule a caller submits must match that record's digest, so the terms a
// batch is judged by are the terms it was compiled under and not whatever a
// caller submits.
//
// Both directions live here so the writer and the reader cannot disagree about
// the document's shape: settlement's tests seed through `commitPreparedCapsule`
// itself, never through a bypass that writes a record the production path
// would not.

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
import { WorkflowPreparedData, type WorkflowPrepared } from '../../events/schemas.js';
import { ArtifactIdSchema, type ArtifactId } from '../../workflow/admission/types.js';
import type { PreparedCapsuleReceipt } from './types.js';

/** The `kind` discriminator every prepared bundle carries. */
export const PREPARED_BUNDLE_KIND = 'prepared-capsule';

/** The document version. Bumped when a reader of this shape could misread the next. */
export const PREPARED_BUNDLE_VERSION = '1.0';

/** The payload version `workflow.prepared` rows are stamped with. */
export const WORKFLOW_PREPARED_SCHEMA_VERSION = '1.0';

const WORKFLOW_PREPARED_TYPE = 'workflow.prepared';

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
}

/**
 * Put a compiled capsule in custody and commit the record that pins it.
 *
 * Throws what the appender throws — a lost race on the stream tail, or the
 * operation claim held by a different request — and the caller decides how to
 * answer. Returns the claim's canonical receipt, which on a race is the
 * winner's, never a locally built one no claim records.
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
      // Appended through `decideOnce`, which the emitter-closure census does
      // not read — the same route the settlement record takes, covered by the
      // same allowance row.
      const event = stampFromAmbient({
        type: WORKFLOW_PREPARED_TYPE,
        data,
        timestamp: capsule.provenance.compiledAt,
        schemaVersion: WORKFLOW_PREPARED_SCHEMA_VERSION,
      });
      return ctx.eventStore
        .getAppender()
        .decideOnce<PreparedCapsuleReceipt>(operationId, requestDigest, (tx) => ({
          streamId,
          events: [event],
          ...(commit.expectedSequence !== undefined ? { expectedSequence: commit.expectedSequence } : {}),
          result: {
            operationId,
            streamId,
            workflowId: capsule.identity.workflowId,
            capsuleVersion: capsule.identity.capsuleVersion,
            capsuleDigest: digest,
            definitionVersion: capsule.identity.definitionVersion,
            capsule,
            // Read inside the write lock: the sequence this append lands on.
            tailSequence: tx.readStream(streamId).version + 1,
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
      readonly capsule: ExarchosCapsuleV1;
      readonly definition: WorkflowDefinitionV1;
    }
  | { readonly found: false };

/**
 * The prepared record for one compilation on one workflow stream, with the
 * capsule and definition read back out of custody.
 *
 * Matched by version alone: a stream is one workflow, and versions are
 * allocated per stream. Which workflow a submitted capsule claims to be is not
 * trusted here — it is part of what the digest comparison checks.
 *
 * `found: false` means no record exists — a caller question. Bytes in custody
 * that no longer match what their record pinned are not a caller question, and
 * throw: that is corruption, and answering "not prepared" would send the caller
 * off to recompile over it.
 */
export async function findPreparedCapsule(
  ctx: DispatchContext,
  streamId: string,
  capsuleVersion: number,
  bundleStore?: RunBundleStore,
): Promise<PreparedLookup> {
  const rows = await ctx.eventStore.query(streamId, { type: WORKFLOW_PREPARED_TYPE });
  let record: WorkflowPrepared | undefined;
  for (const row of rows) {
    const parsed = WorkflowPreparedData.safeParse(row.data);
    if (!parsed.success || parsed.data.capsuleVersion !== capsuleVersion) continue;
    record = parsed.data;
  }
  if (record === undefined) return { found: false };

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
  // The capsule names its definition by digest, and the definition it names is
  // in the same bundle. A bundle where the two disagree pins terms against a
  // definition other than the one it carries.
  const definitionDigest = contentDigest(decoded.definition);
  if (definitionDigest !== decoded.capsule.identity.definitionVersion) {
    throw new Error(
      `the prepared capsule v${capsuleVersion} on '${streamId}' names definition ` +
        `${decoded.capsule.identity.definitionVersion} and its bundle carries ${definitionDigest}`,
    );
  }
  return { found: true, record, capsule: decoded.capsule, definition: decoded.definition };
}
