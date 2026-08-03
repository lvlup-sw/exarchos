// ─── Content-addressed authority digests (P03-01) ────────────────────────────
//
// Deterministic, reproducible content digests for the frozen contract
// authorities (PROGRAM-03 head). Every authority whose identity is its content
// (schema module, invariant catalog, ActionId registry, compatibility policy)
// is pinned by a `sha256:<hex>` digest computed from its CANONICAL bytes.
//
// ## Cross-machine reproducibility (line-ending normalization)
//
// This repo is authored on Windows (CRLF working tree) and CI runs on Linux
// (LF). A raw byte hash would differ between the two, so the lockfile would
// never verify across machines. `canonicalizeText` normalizes CRLF/CR → LF and
// strips trailing newlines BEFORE hashing, so the digest depends only on the
// meaningful content — identical on Windows, macOS, and Linux, and stable
// regardless of the checkout's `core.autocrlf` setting.
//
// This module is pure (no filesystem, no clock, no registry import) so the
// normalization + floating-detection rules are unit-testable in isolation. The
// collector (`authority-collector.ts`) supplies the real bytes.
// ────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

/** The single digest algorithm. Digests are emitted as `sha256:<64 hex>`. */
export const DIGEST_ALGORITHM = 'sha256' as const;

/** Matches a well-formed digest string: `sha256:` + 64 lowercase hex chars. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Canonicalize text before hashing so the digest is byte-identical across
 * machines and checkout settings:
 *
 *   1. `\r\n` → `\n`  (Windows CRLF)
 *   2. `\r`   → `\n`  (classic-Mac CR)
 *   3. strip all trailing newlines at EOF (editor / git artifact)
 *
 * Interior content is preserved exactly. The transform is idempotent:
 * `canonicalizeText(canonicalizeText(x)) === canonicalizeText(x)`.
 */
export function canonicalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/, '');
}

/**
 * Compute the content digest of a single text blob. Returns `sha256:<hex>`.
 * The input is canonicalized (line endings normalized) before hashing.
 */
export function digestText(text: string): string {
  const canonical = canonicalizeText(text);
  const hex = createHash(DIGEST_ALGORITHM).update(canonical, 'utf8').digest('hex');
  return `${DIGEST_ALGORITHM}:${hex}`;
}

/**
 * Compute a digest over an ordered list of string parts. Each part is
 * canonicalized, then the parts are joined with `\n` and hashed. Order is
 * significant — callers that want an order-independent digest (e.g. a set of
 * identifiers) must sort first (see {@link digestIdentifierSet}).
 */
export function digestParts(parts: readonly string[]): string {
  return digestText(parts.map(canonicalizeText).join('\n'));
}

/**
 * Digest a SET of identifiers (e.g. ActionIds) order-independently: duplicates
 * are removed and the identifiers are sorted before hashing, so two registries
 * that declare the same ActionIds in a different source order produce the same
 * digest.
 */
export function digestIdentifierSet(identifiers: readonly string[]): string {
  const canonical = [...new Set(identifiers)].sort();
  return digestParts(canonical);
}

/**
 * True when `digest` is a well-formed `sha256:<64 hex>` string.
 */
export function isWellFormedDigest(digest: string): boolean {
  return DIGEST_RE.test(digest);
}

/**
 * True when a version SPEC is FLOATING — i.e. it is not an exact pin. A frozen
 * authority must name a single, exact version; a range or dist-tag would let
 * the resolved version drift silently, which the freeze exists to prevent.
 *
 * Floating forms detected:
 *   - empty / whitespace-only        (no pin at all)
 *   - caret / tilde ranges           (`^1.2.3`, `~1.2.3`)
 *   - comparator ranges              (`>=1.2.0`, `<2.0.0`)
 *   - union ranges                   (`1.2.0 || 2.0.0`)
 *   - hyphenated ranges              (`1.2.0 - 1.3.0`)
 *   - wildcard segments / bare star  (`1.x`, `1.2.*`, `*`)
 *   - dist-tags                      (`latest`, `next`)
 *
 * Exact pins pass (return false), including semver prereleases
 * (`2.12.0-preview.3`) and MCP protocol date versions (`2025-11-25`) whose
 * internal `-` is NOT a range operator.
 */
export function isFloatingVersionSpec(spec: string): boolean {
  const s = spec.trim();
  if (s.length === 0) return true; // no pin
  if (/^(latest|next|\*)$/i.test(s)) return true; // dist-tags / bare star
  if (/[\^~]/.test(s)) return true; // caret / tilde
  if (/[<>]/.test(s)) return true; // comparators
  if (/\|\|/.test(s)) return true; // union
  if (/\s-\s/.test(s)) return true; // hyphen range (spaces required)
  if (/(^|[.\s])[xX*](\.|$|\s)/.test(s)) return true; // wildcard segment / bare star
  return false;
}

/** Convenience inverse of {@link isFloatingVersionSpec}. */
export function isExactVersionPin(spec: string): boolean {
  return !isFloatingVersionSpec(spec);
}
