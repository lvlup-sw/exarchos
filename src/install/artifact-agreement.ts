/**
 * Agreement checks for the standard generated artifacts. Each artifact has one
 * authored source and one generator. Its copies in source, package, install and
 * cache must give the same digest. A stale cache or a hand-edited copy fails.
 *
 * {@link digestText} copies the digest in `src/contract/authority-digest.ts`.
 * {@link digestTree} copies the digest in `src/install/install-identity.ts`.
 * Both normalize line endings, so a Windows checkout agrees with a Linux render.
 * A consistency test asserts that each copy gives the same digest as its source.
 *
 * This module is pure. Callers read the copies from disk and pass them in.
 */

import { createHash } from 'node:crypto';

/**
 * Change CRLF and CR to LF and remove trailing newlines. Other content does not
 * change. Copies `canonicalizeText` in `authority-digest.ts`.
 */
export function canonicalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/, '');
}

/** `sha256:<hex>` over canonicalized text. Copies `digestText` in `authority-digest.ts`. */
export function digestText(text: string): string {
  const hex = createHash('sha256').update(canonicalizeText(text), 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/** A single path/content pair contributing to a tree digest. */
export interface DigestEntry {
  readonly path: string;
  readonly content: string;
}

/**
 * Normalize line endings to LF and remove a UTF-8 BOM. Trailing newlines stay,
 * because they are content in a tree entry. Copies `normalizeLineEndings` in
 * `install-identity.ts`.
 */
export function normalizeTreeContent(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Normalize a path to POSIX separators. Copies `normalizePath` in `install-identity.ts`. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Digest a set of path/content entries, independent of order and platform. The
 * entries sort by POSIX path. Each adds its path and normalized content, with
 * NUL delimiters. Copies `digestTree` in `install-identity.ts`.
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

/**
 * One copy of an artifact at a named dimension, such as `source` or `cache`. A
 * `text` copy is one file. A `tree` copy is a set of files.
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
 * reference, and each other copy must give the same digest. An artifact with
 * fewer than two copies agrees.
 *
 * @throws if two copies have the same `dimension` name, or if a recorded digest
 *   is missing.
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

  const readDigest = (dimension: string): string => {
    const digest = digestByDimension[dimension];
    if (digest === undefined) {
      throw new Error(`artifact-agreement: no digest recorded for dimension '${dimension}'`);
    }
    return digest;
  };
  const referenceDigest = readDigest(first.dimension);
  const disagreements: Disagreement[] = [];
  for (const copy of artifact.copies.slice(1)) {
    const digest = readDigest(copy.dimension);
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
 * Check each artifact and throw {@link ArtifactDisagreementError} if copies
 * diverge. On success, return the agreement list so that callers can log the
 * digests.
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
