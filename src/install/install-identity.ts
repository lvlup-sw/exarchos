/**
 * install-identity — a typed, content-addressed record of an Exarchos
 * installation's identity across the five dimensions a mixed/stale install can
 * diverge on (P05-04; ART-006, ART-007, ART-009, ART-013):
 *
 *   - `binary`  — the running binary's version + a content digest of its
 *                 distributed artifact(s).
 *   - `plugin`  — a digest of the plugin manifest (`plugin.json` / `manifest.json`).
 *   - `skill`   — a digest of the rendered skill tree (`skills/<runtime>/…`).
 *   - `schema`  — the event-store schema version the record refers to (the
 *                 single source of truth is `SCHEMA_VERSION` in the SQLite
 *                 backend).
 *   - `cache`   — the resolved cache location + a digest of its content.
 *
 * Every digest is deterministic and **line-ending / path-separator
 * normalized**: the artifacts are authored on Windows (CRLF, `\` separators)
 * but CI and production may render/read them on Linux (LF, `/`). Without
 * normalization the same logical content would produce different digests on the
 * two platforms and the freshness check would false-positive on every
 * cross-platform install.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

// ─── Digest primitives ───────────────────────────────────────────────────────

/** A single path/content pair contributing to a content-addressed tree digest. */
export interface DigestEntry {
  readonly path: string;
  readonly content: string;
}

/** Digest string shape: `sha256:<64 lowercase hex>`. */
export const DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected a sha256:<hex> content digest');

/**
 * Normalize line endings to LF and strip a UTF-8 BOM. CRLF (`\r\n`) and lone CR
 * (`\r`) both collapse to `\n` so a file authored on Windows digests
 * identically to the same file checked out with LF on Linux.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * Normalize a path to POSIX separators so a Windows-authored `skills\a\SKILL.md`
 * sorts and digests identically to a Linux `skills/a/SKILL.md`.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** sha256 over line-ending-normalized text, prefixed `sha256:`. */
export function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(normalizeLineEndings(text)).digest('hex')}`;
}

/**
 * Content-addressed digest over a set of path/content entries, order-independent
 * and platform-independent. Entries are sorted by their POSIX-normalized path;
 * each contributes its normalized path and line-ending-normalized content with
 * NUL delimiters so `{path:"a", content:"b"}` cannot collide with
 * `{path:"ab", content:""}`.
 */
export function digestTree(entries: ReadonlyArray<DigestEntry>): string {
  const hash = createHash('sha256');
  const sorted = [...entries]
    .map((e) => ({ path: normalizePath(e.path), content: normalizeLineEndings(e.content) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

// ─── Install-identity record ─────────────────────────────────────────────────

export const BinaryIdentitySchema = z.object({
  version: z.string().min(1),
  digest: DigestSchema,
});

export const PluginIdentitySchema = z.object({
  manifestDigest: DigestSchema,
});

export const SkillIdentitySchema = z.object({
  digest: DigestSchema,
});

export const SchemaIdentitySchema = z.object({
  version: z.number().int().nonnegative(),
});

export const CacheIdentitySchema = z.object({
  location: z.string().min(1),
  digest: DigestSchema,
});

export const InstallIdentitySchema = z.object({
  binary: BinaryIdentitySchema,
  plugin: PluginIdentitySchema,
  skill: SkillIdentitySchema,
  schema: SchemaIdentitySchema,
  cache: CacheIdentitySchema,
});

export type InstallIdentity = z.infer<typeof InstallIdentitySchema>;

/**
 * Raw materials for an install identity, before digesting. Each dimension's
 * source content is supplied as plain strings / entry lists so the identity can
 * be built hermetically (no filesystem access here); a caller-side collector is
 * responsible for reading these off disk.
 */
export interface RawInstallInputs {
  /** Running binary version string (e.g. package.json `version`). */
  readonly binaryVersion: string;
  /** Content-addressing entries for the distributed binary artifact(s). */
  readonly binaryEntries: ReadonlyArray<DigestEntry>;
  /** Raw plugin manifest text (`plugin.json` / `manifest.json`). */
  readonly pluginManifest: string;
  /** Rendered skill-tree entries (`skills/<runtime>/<name>/…`). */
  readonly skillEntries: ReadonlyArray<DigestEntry>;
  /** Event-store schema version this record refers to (`SCHEMA_VERSION`). */
  readonly schemaVersion: number;
  /** Resolved cache directory location. */
  readonly cacheLocation: string;
  /** Content-addressing entries for the cache directory. */
  readonly cacheEntries: ReadonlyArray<DigestEntry>;
}

/**
 * Build a validated {@link InstallIdentity} from raw inputs. Pure and
 * deterministic: identical inputs (modulo line endings / path separators)
 * always yield an identical record, on any platform. Throws (via Zod) if any
 * computed field is malformed — e.g. an empty binary version.
 */
export function buildInstallIdentity(raw: RawInstallInputs): InstallIdentity {
  return InstallIdentitySchema.parse({
    binary: {
      version: raw.binaryVersion,
      digest: digestTree(raw.binaryEntries),
    },
    plugin: {
      manifestDigest: digestText(raw.pluginManifest),
    },
    skill: {
      digest: digestTree(raw.skillEntries),
    },
    schema: {
      version: raw.schemaVersion,
    },
    cache: {
      location: normalizePath(raw.cacheLocation),
      digest: digestTree(raw.cacheEntries),
    },
  });
}
