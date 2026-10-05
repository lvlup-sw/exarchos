/**
 * Content addresses for compiled artifacts. A capsule and its source definition are named by the
 * sha256 of their canonical JSON, as bare lowercase hex. This is the kernel digest spelling, so
 * `definitionVersion` and the other kernel digest fields accept the value as it is.
 *
 * The JSON is canonical so that two encodings that differ only in key order get one digest. A plain
 * `JSON.stringify` digest can name one capsule twice, and then settlement refuses its own compiled
 * capsule.
 */

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
