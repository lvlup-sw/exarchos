/**
 * artifact-agreement — content-addressed agreement checks for the standard
 * generated artifacts (P03-07; API-008, CTR-011).
 *
 * "Emit once, agree everywhere": each standard artifact (Agent Skills, the
 * AGENTS.md/CLAUDE.md binding block, MCP instructions, agent principles,
 * invariant documentation) has exactly ONE authored source rendered by ONE
 * generator. The copy that lands in source, is bundled in the PACKAGE, written
 * at INSTALL, and kept in the CACHE must all AGREE. Disagreement — a stale
 * cached skill tree, a hand-edited installed copy, an out-of-band re-render — is
 * the defect this module detects.
 *
 * ## Digesting
 *
 * Every comparison is over a canonical, cross-platform digest so a Windows
 * (CRLF, `\`) checkout agrees with a Linux (LF, `/`) render:
 *
 *   - {@link digestText} mirrors the frozen-authority digest (P03-01,
 *     `servers/exarchos-mcp/src/contract/authority-digest.ts`): CRLF/CR → LF and
 *     trailing newlines stripped before `sha256`. Use it for single-file text
 *     artifacts (the binding block, AGENTS.md, invariant docs).
 *   - {@link digestTree} mirrors the install-identity skill-tree digest (P05-04,
 *     `servers/exarchos-mcp/src/install/install-identity.ts`): path-normalized,
 *     order-independent, NUL-delimited, line-ending-normalized. Use it for
 *     multi-file tree artifacts (the rendered `skills/` tree).
 *
 * The digest semantics are re-implemented here (not imported) because this root
 * module lives under `rootDir: ./src` and cannot import the MCP-package sources
 * in production. The `artifact-agreement.consistency.test.ts` cross-check imports
 * both upstreams and asserts byte-identical digests, so the mirror cannot drift.
 *
 * This module is pure — no filesystem, no clock. Callers assemble the copies
 * (reading source, package, install, cache off disk) and hand them in.
 */

import { createHash } from 'node:crypto';

// ─── Text digest (mirrors P03-01 authority-digest) ───────────────────────────

/**
 * Canonicalize text before hashing: CRLF/CR → LF and strip trailing newlines.
 * Idempotent. Interior content is preserved exactly. Mirrors P03-01's
 * `canonicalizeText`.
 */
export function canonicalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/, '');
}

/** `sha256:<hex>` over canonicalized text. Mirrors P03-01's `digestText`. */
export function digestText(text: string): string {
  const hex = createHash('sha256').update(canonicalizeText(text), 'utf8').digest('hex');
  return `sha256:${hex}`;
}

// ─── Tree digest (mirrors P05-04 install-identity) ───────────────────────────

/** A single path/content pair contributing to a tree digest. */
export interface DigestEntry {
  readonly path: string;
  readonly content: string;
}

/**
 * Normalize line endings to LF and strip a UTF-8 BOM (NOT trailing newlines —
 * a tree entry's trailing newline is meaningful content). Mirrors P05-04's
 * `normalizeLineEndings`.
 */
export function normalizeTreeContent(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Normalize a path to POSIX separators. Mirrors P05-04's `normalizePath`. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Content-addressed digest over a set of path/content entries, order- and
 * platform-independent. Entries are sorted by POSIX-normalized path; each
 * contributes its normalized path and LF-normalized content with NUL
 * delimiters. Mirrors P05-04's `digestTree`.
 */
export function digestTree(entries: ReadonlyArray<DigestEntry>): string {
  const hash = createHash('sha256');
  const sorted = [...entries]
    .map((e) => ({ path: normalizePath(e.path), content: normalizeTreeContent(e.content) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

// ─── Artifact model ──────────────────────────────────────────────────────────

/**
 * One copy of an artifact, as it appears at a named dimension (e.g. `source`,
 * `package`, `install`, `cache`). A `text` copy is a single file; a `tree` copy
 * is a set of files (used for multi-file artifacts like the rendered skill tree).
 */
export type ArtifactCopy =
  | { readonly dimension: string; readonly kind: 'text'; readonly text: string }
  | { readonly dimension: string; readonly kind: 'tree'; readonly entries: ReadonlyArray<DigestEntry> };

/** A standard artifact and every copy of it that must agree. */
export interface Artifact {
  readonly name: string;
  readonly copies: ReadonlyArray<ArtifactCopy>;
}

/** The digest for a single copy, per its kind. */
export function digestCopy(copy: ArtifactCopy): string {
  return copy.kind === 'text' ? digestText(copy.text) : digestTree(copy.entries);
}

/** A dimension whose digest diverges from the reference copy. */
export interface Disagreement {
  readonly dimension: string;
  readonly digest: string;
}

/** Agreement outcome for one artifact. */
export interface ArtifactAgreement {
  readonly name: string;
  readonly agree: boolean;
  /** Digest per dimension, in copy order. */
  readonly digestByDimension: Readonly<Record<string, string>>;
  /** The reference dimension (the first copy) all others are compared against. */
  readonly reference: string;
  /** Dimensions whose digest differs from the reference. */
  readonly disagreements: ReadonlyArray<Disagreement>;
}

/**
 * Digest each copy of `artifact` and compare them. The first copy is the
 * reference; every other copy must produce an identical digest. An artifact
 * with fewer than two copies trivially agrees (nothing to compare).
 *
 * @throws if two copies share the same `dimension` name (an assembly bug — the
 *   comparison would be ambiguous).
 */
export function checkArtifactAgreement(artifact: Artifact): ArtifactAgreement {
  const digestByDimension: Record<string, string> = {};
  for (const copy of artifact.copies) {
    if (Object.prototype.hasOwnProperty.call(digestByDimension, copy.dimension)) {
      throw new Error(
        `artifact '${artifact.name}' has duplicate dimension '${copy.dimension}'`,
      );
    }
    digestByDimension[copy.dimension] = digestCopy(copy);
  }

  const first = artifact.copies[0];
  if (first === undefined) {
    return {
      name: artifact.name,
      agree: true,
      digestByDimension,
      reference: '',
      disagreements: [],
    };
  }

  const referenceDigest = digestByDimension[first.dimension]!;
  const disagreements: Disagreement[] = [];
  for (const copy of artifact.copies.slice(1)) {
    const digest = digestByDimension[copy.dimension]!;
    if (digest !== referenceDigest) {
      disagreements.push({ dimension: copy.dimension, digest });
    }
  }

  return {
    name: artifact.name,
    agree: disagreements.length === 0,
    digestByDimension,
    reference: first.dimension,
    disagreements,
  };
}

// ─── Assertion helper ────────────────────────────────────────────────────────

/** Thrown by {@link assertArtifactsAgree} when any artifact's copies diverge. */
export class ArtifactDisagreementError extends Error {
  override readonly name = 'ArtifactDisagreementError';
  readonly code = 'ARTIFACT_DISAGREEMENT';
  constructor(public readonly disagreeing: ReadonlyArray<ArtifactAgreement>) {
    super(
      `Standard artifacts disagree across dimensions — ${disagreeing.length} artifact(s):\n` +
        disagreeing
          .map((a) => {
            const ref = `${a.reference}=${a.digestByDimension[a.reference]}`;
            const bad = a.disagreements
              .map((d) => `      ${d.dimension}=${d.digest}`)
              .join('\n');
            return `  • ${a.name} (reference ${ref}):\n${bad}`;
          })
          .join('\n'),
    );
  }
}

/**
 * Check every artifact and THROW {@link ArtifactDisagreementError} if any copies
 * diverge. Returns the full per-artifact agreement list on success so callers
 * can log the digests.
 */
export function assertArtifactsAgree(
  artifacts: ReadonlyArray<Artifact>,
): ReadonlyArray<ArtifactAgreement> {
  const results = artifacts.map(checkArtifactAgreement);
  const disagreeing = results.filter((r) => !r.agree);
  if (disagreeing.length > 0) {
    throw new ArtifactDisagreementError(disagreeing);
  }
  return results;
}
