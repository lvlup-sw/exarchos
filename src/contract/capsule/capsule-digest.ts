// ─── Content addresses for compiled artifacts ────────────────────────────────
//
// A capsule is pinned by what it says, not by where it was stored or when it
// was written. Both it and the definition it compiled from are named by the
// sha256 of their canonical JSON, spelled as bare lowercase hex — the kernel's
// digest spelling, so a digest computed here is one `definitionVersion` and
// every other kernel digest field accepts as it stands.
//
// Canonical, because two encodings of one document that differ only by object
// key order are one document. A digest over plain `JSON.stringify` would name
// the same capsule twice, and a settlement comparing the two would refuse its
// own compilation.

import { createHash } from 'node:crypto';

import { canonicalJson } from '../request-context.js';
import type { ExarchosCapsuleV1 } from './exarchos-capsule.js';

/** The bare 64-hex sha256 of a document's canonical JSON. */
export function contentDigest(document: unknown): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}

/** The content address of one compiled capsule. */
export function capsuleDigest(capsule: ExarchosCapsuleV1): string {
  return contentDigest(capsule);
}
