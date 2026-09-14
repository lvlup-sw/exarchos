// ─── The workflow stream a semantic-plane call is about ──────────────────────
//
// `prepare` and `settle` both name their subject the way the executor does:
// `featureId`, with `streamId` accepted as an alias because the workflow stream
// id IS the bare featureId. Resolved once here so the two verbs cannot drift on
// which spelling wins, or on whether a reserved infrastructure stream can be a
// workflow's subject.

import { isFeatureStream } from './infra-streams.js';

export type SubjectStream =
  | { readonly ok: true; readonly streamId: string }
  | { readonly ok: false; readonly message: string };

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The subject stream, `featureId` first — the same precedence the dispatch
 * stream resolver uses. Two spellings that disagree are not a precedence
 * question, so a disagreement is refused rather than resolved.
 */
export function resolveSubjectStream(raw: Record<string, unknown>): SubjectStream {
  const featureId = readString(raw, 'featureId');
  const streamAlias = readString(raw, 'streamId');
  if (featureId !== undefined && streamAlias !== undefined && featureId !== streamAlias) {
    return {
      ok: false,
      message:
        `featureId '${featureId}' and streamId '${streamAlias}' name different streams. ` +
        'They are two spellings of one subject — pass one, or pass the same value for both.',
    };
  }
  const streamId = featureId ?? streamAlias;
  if (streamId === undefined) {
    return {
      ok: false,
      message:
        'streamId is required (featureId is accepted as an alias — the workflow stream id is the bare featureId)',
    };
  }
  if (!isFeatureStream(streamId)) {
    return {
      ok: false,
      message:
        `'${streamId}' is a reserved infrastructure stream, not a workflow subject — ` +
        "pass the feature's own id",
    };
  }
  return { ok: true, streamId };
}
