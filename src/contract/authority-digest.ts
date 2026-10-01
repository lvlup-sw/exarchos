/**
 * Content digests for the frozen contract authorities. Each authority whose identity is its
 * content is pinned by a `sha256:<hex>` digest of its canonical bytes.
 *
 * The hash runs on text with normalized line endings. Thus a CRLF checkout and an LF checkout
 * give the same digest. This module is pure. The collector (`authority-collector.ts`) supplies the bytes.
 */

import { createHash } from 'node:crypto';

/** The single digest algorithm. Digests are emitted as `sha256:<64 hex>`. */
export const DIGEST_ALGORITHM = 'sha256' as const;

/** Matches a well-formed digest string: `sha256:` + 64 lowercase hex chars. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Changes `\r\n` and `\r` to `\n` and removes the trailing newlines. Other content stays the
 * same. The transform is idempotent.
 */
export function canonicalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/, '');
}

/** Returns the `sha256:<hex>` digest of the canonicalized text. */
export function digestText(text: string): string {
  const canonical = canonicalizeText(text);
  const hex = createHash(DIGEST_ALGORITHM).update(canonical, 'utf8').digest('hex');
  return `${DIGEST_ALGORITHM}:${hex}`;
}

/**
 * Digests the canonicalized parts joined with `\n`. The order is significant. For a digest
 * that ignores order, use {@link digestIdentifierSet}.
 */
export function digestParts(parts: readonly string[]): string {
  return digestText(parts.map(canonicalizeText).join('\n'));
}

/**
 * Digests a set of identifiers. It removes duplicates and sorts the identifiers first, so the
 * source order has no effect on the digest.
 */
export function digestIdentifierSet(identifiers: readonly string[]): string {
  const canonical = [...new Set(identifiers)].sort();
  return digestParts(canonical);
}

/** True when `digest` is a well-formed `sha256:<64 hex>` string. */
export function isWellFormedDigest(digest: string): boolean {
  return DIGEST_RE.test(digest);
}

/**
 * True when a version spec is not an exact pin. A frozen authority must name one exact version,
 * because a range or a dist-tag lets the resolved version drift.
 *
 * These forms float: an empty spec, `^` or `~`, `<` or `>`, `||`, and a spaced hyphen range.
 * An `x` or `*` segment and the `latest` and `next` tags also float. A prerelease such as
 * `2.12.0-preview.3` and a date version such as `2025-11-25` are exact pins.
 */
export function isFloatingVersionSpec(spec: string): boolean {
  const s = spec.trim();
  if (s.length === 0) return true;
  if (/^(latest|next|\*)$/i.test(s)) return true;
  if (/[\^~]/.test(s)) return true;
  if (/[<>]/.test(s)) return true;
  if (/\|\|/.test(s)) return true;
  if (/\s-\s/.test(s)) return true;
  if (/(^|[.\s])[xX*](\.|$|\s)/.test(s)) return true;
  return false;
}

/** Convenience inverse of {@link isFloatingVersionSpec}. */
export function isExactVersionPin(spec: string): boolean {
  return !isFloatingVersionSpec(spec);
}
