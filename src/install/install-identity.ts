/**
 * A typed, content-addressed record of the identity of an Exarchos install.
 * It has five dimensions: `binary`, `plugin`, `skill`, `schema`, and `cache`. A mixed or stale install differs on one or more of them.
 * Each digest normalizes line endings and path separators.
 * Thus the same content gives the same digest on Windows and on Linux, and the freshness check gives no false positive across platforms.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

/** A single path/content pair contributing to a content-addressed tree digest. */
export interface DigestEntry {
  readonly path: string;
  readonly content: string;
}

/** Digest string shape: `sha256:<64 lowercase hex>`. */
export const DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected a sha256:<hex> content digest');

/** Remove a UTF-8 BOM, and change each CRLF (`\r\n`) and each lone CR (`\r`) to `\n`. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Change each `\` in a path to `/`, so a Windows path sorts and digests the same as its POSIX form. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** sha256 over line-ending-normalized text, prefixed `sha256:`. */
export function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(normalizeLineEndings(text)).digest('hex')}`;
}

/**
 * A digest over path and content entries that does not depend on entry order or platform.
 * It sorts the entries by normalized path. A NUL delimiter follows each path and each content, so `{path:"a", content:"b"}` cannot collide with `{path:"ab", content:""}`.
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

/**
 * The binary version that `collect-identity.ts` uses when it cannot read the version from `package.json`.
 * It marks an absent observation, not a version. Thus two copies of it must never compare as equal.
 * The `indeterminate` verdict in `freshness-check.ts` applies this rule.
 */
export const UNKNOWN_VERSION_SENTINEL = '0.0.0-unknown';

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

/** The raw inputs of an install identity, before the digest step. The caller reads them from disk, so this module has no filesystem access. */
export interface RawInstallInputs {
  /** The version of the running binary, for example the `version` field of `package.json`. */
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
 * Build a validated {@link InstallIdentity} from raw inputs. Equal inputs give an equal record on each platform.
 * Zod throws when a computed field is malformed, for example an empty binary version.
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
