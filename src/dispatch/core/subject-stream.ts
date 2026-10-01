// Resolves the workflow stream that a `prepare` or `settle` call is about.
// Both verbs take `featureId`, and accept `streamId` as an alias, because the workflow stream id is the bare featureId.
// One resolver keeps the two verbs in agreement.

import { isFeatureStream } from './infra-streams.js';

export type SubjectStream =
  | { readonly ok: true; readonly streamId: string }
  | { readonly ok: false; readonly message: string };

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolve the subject stream, with `featureId` first.
 * It refuses two spellings that disagree, and it refuses a reserved infrastructure stream.
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
