#!/usr/bin/env node
/**
 * Generates the manifest of legacy skill render hashes across releases.
 *
 * The migration deletes a stale per-runtime `SKILL.md` from a consumer install only when its hash
 * matches a render that a release shipped. An old install holds the renders of its own release.
 * The manifest thus holds the hash of every render at every release tag in the legacy window.
 *
 * The generator reads git objects at the release tags, never the working tree. A deletion pass can
 * run during skills regeneration, and a hash of a half-deleted tree can orphan a valid file. It
 * hashes every render, not only the procedural ones, because a superset can only add matches. It
 * enumerates only release tags, never `HEAD`, and the output has no timestamp. A second run on the
 * same tags thus gives the same bytes.
 *
 * Usage: node tools/release/generate-legacy-skill-hashes.mjs [--out <path>] [--print]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
export const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'tools',
  'migrations',
  'legacy-skill-render-hashes.json',
);

/** Lowest release line covered by the manifest (inclusive). */
export const MIN_RELEASE = [2, 9, 0];

/**
 * The first release line that the manifest does not cover. The manifest records the per-runtime
 * renders before the skill rename in `v2.12.0`, so a pre-rename install can match. Without this
 * bound, a new `v2.12.x` tag changes the result of a fresh `buildManifest()`. That result then
 * differs from the committed manifest, and the manifest test fails.
 */
export const MAX_RELEASE_EXCLUSIVE = [2, 12, 0];

/** Top-level `skills/` directories that never ship to a consumer install. */
const EXCLUDED_RUNTIME_DIRS = new Set(['test-fixtures']);

/**
 * Run a git command and return trimmed stdout. Throws on non-zero exit so
 * callers fail loud rather than silently hashing an empty tree.
 *
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
function git(args, opts = {}) {
  const cwd = opts.cwd ?? REPO_ROOT;
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`git ${args.join(' ')} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.status}: ${result.stderr ?? ''}`,
    );
  }
  return (result.stdout ?? '').replace(/\n$/u, '');
}

/**
 * Parse a `vX.Y.Z[-pre.N]` tag into a structured version. Returns null for
 * tags that do not match (they are ignored during enumeration).
 *
 * @param {string} tag
 * @returns {{ base: [number, number, number], pre: string[] } | null}
 */
export function parseVersionTag(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/u.exec(tag);
  if (!m) return null;
  const base = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4] ? m[4].split('.') : [];
  return { base, pre };
}

/**
 * Compare two `[major, minor, patch]` triples lexically.
 *
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
function compareBase(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Semver-style comparison of release tags, independent of the git version sort. The base triple
 * compares first, and a pre-release ranks before its release. Pre-release identifiers then compare
 * one by one. Numbers compare as numbers and rank below text. When the shared identifiers are
 * equal, the shorter list ranks lower.
 *
 * @param {string} tagA
 * @param {string} tagB
 * @returns {number}
 */
export function compareVersionTags(tagA, tagB) {
  const a = parseVersionTag(tagA);
  const b = parseVersionTag(tagB);
  if (!a || !b) return tagA < tagB ? -1 : tagA > tagB ? 1 : 0;
  const baseCmp = compareBase(a.base, b.base);
  if (baseCmp !== 0) return baseCmp;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = a.pre[i];
    const bi = b.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/u.test(ai);
    const bNum = /^\d+$/u.test(bi);
    if (aNum && bNum) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Lists the release tags that the manifest covers, in ascending order. These are the `v2.*` tags
 * whose base version is in `[MIN_RELEASE, MAX_RELEASE_EXCLUSIVE)`, with their pre-releases. `HEAD`
 * is not in the list, so a change to the working tree does not change the manifest.
 *
 * @param {{ cwd?: string }} [opts]
 * @returns {string[]}
 */
export function enumerateReleaseRefs(opts = {}) {
  const raw = git(['tag', '--list', 'v2.*'], opts);
  const tags = raw
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => {
      const v = parseVersionTag(t);
      return (
        v !== null &&
        compareBase(v.base, MIN_RELEASE) >= 0 &&
        compareBase(v.base, MAX_RELEASE_EXCLUSIVE) < 0
      );
    })
    .sort(compareVersionTags);
  return tags;
}

/**
 * Lists the render paths `skills/<runtime>/<skill>/SKILL.md` in the git tree at `ref`, without
 * the fixture directories. It reads the tree object, never the working directory.
 *
 * @param {string} ref
 * @param {{ cwd?: string }} [opts]
 * @returns {string[]} sorted paths
 */
export function listSkillRenderPaths(ref, opts = {}) {
  const raw = git(['ls-tree', '-r', '--name-only', ref, '--', 'skills/'], opts);
  if (!raw) return [];
  return raw
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const parts = p.split('/');
      const rel = parts[0] === 'rendered' ? parts.slice(1) : parts;
      return (
        rel.length === 4 &&
        rel[0] === 'skills' &&
        rel[3] === 'SKILL.md' &&
        !EXCLUDED_RUNTIME_DIRS.has(rel[1])
      );
    })
    .sort();
}

/**
 * Converts CRLF to LF, then returns the sha256 digest of the UTF-8 content. A consumer file that
 * differs only in line endings thus still matches.
 *
 * @param {string | Buffer} content
 * @returns {string} sha256 hex digest
 */
export function normalizeAndHash(content) {
  const text = (Buffer.isBuffer(content) ? content.toString('utf8') : content).replace(
    /\r\n/gu,
    '\n',
  );
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Reads many git blobs in one `git cat-file --batch` process. Each spec is a `<ref>:<path>` object
 * name. The result maps each spec to its raw blob, and a missing object is not in the map. Git
 * writes a header `<sha> <type> <size>` or `<name> missing` for each spec, and a LF after a blob.
 *
 * @param {string[]} specs
 * @param {{ cwd?: string }} [opts]
 * @returns {Map<string, Buffer>}
 */
export function readBlobsBatch(specs, opts = {}) {
  const out = new Map();
  if (specs.length === 0) return out;
  const cwd = opts.cwd ?? REPO_ROOT;
  const result = spawnSync('git', ['cat-file', '--batch', '--buffer'], {
    cwd,
    input: specs.join('\n') + '\n',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`git cat-file --batch failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git cat-file --batch exited ${result.status}: ${result.stderr?.toString() ?? ''}`,
    );
  }
  const buf = /** @type {Buffer} */ (result.stdout);
  let cursor = 0;
  const NL = 0x0a;
  for (const spec of specs) {
    const nl = buf.indexOf(NL, cursor);
    if (nl === -1) {
      throw new Error(`git cat-file --batch: truncated output for ${spec}`);
    }
    const header = buf.toString('utf8', cursor, nl);
    cursor = nl + 1;
    if (/ missing$/u.test(header)) {
      continue;
    }
    const parts = header.split(' ');
    const size = Number(parts[parts.length - 1]);
    if (!Number.isFinite(size)) {
      throw new Error(`git cat-file --batch: bad header for ${spec}: ${header}`);
    }
    const content = buf.subarray(cursor, cursor + size);
    cursor += size + 1;
    out.set(spec, Buffer.from(content));
  }
  return out;
}

/**
 * Builds the manifest from the git objects at the release refs. Entries sort by release, then path.
 *
 * @param {{ refs?: string[], cwd?: string }} [opts]
 * @returns {{
 *   algorithm: string,
 *   normalization: string,
 *   scope: string,
 *   source: string,
 *   minRelease: string,
 *   releases: string[],
 *   entries: { release: string, runtime: string, skill: string, path: string, hash: string }[],
 * }}
 */
export function buildManifest(opts = {}) {
  const cwd = opts.cwd ?? REPO_ROOT;
  const refs = opts.refs ?? enumerateReleaseRefs({ cwd });

  const releases = [];
  /** @type {{ release: string, path: string, spec: string }[]} */
  const items = [];
  for (const ref of refs) {
    const paths = listSkillRenderPaths(ref, { cwd });
    if (paths.length === 0) continue;
    releases.push(ref);
    for (const p of paths) {
      items.push({ release: ref, path: p, spec: `${ref}:${p}` });
    }
  }

  const blobs = readBlobsBatch(
    items.map((i) => i.spec),
    { cwd },
  );

  const entries = items.map((i) => {
    const blob = blobs.get(i.spec);
    if (blob === undefined) {
      throw new Error(`missing blob for ${i.spec} (tree/object mismatch)`);
    }
    const parts = i.path.split('/');
    return {
      release: i.release,
      runtime: parts[1],
      skill: parts[2],
      path: i.path,
      hash: normalizeAndHash(blob),
    };
  });

  const releaseRank = new Map(releases.map((r, idx) => [r, idx]));
  entries.sort((a, b) => {
    const ra = releaseRank.get(a.release) ?? 0;
    const rb = releaseRank.get(b.release) ?? 0;
    if (ra !== rb) return ra - rb;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return {
    algorithm: 'sha256',
    normalization: 'crlf-to-lf',
    scope: 'all-skill-renders',
    source: 'git-history',
    minRelease: `v${MIN_RELEASE.join('.')}`,
    releases,
    entries,
  };
}

/** Serialize the manifest with a trailing newline (stable on-disk form). */
export function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

function parseArgs(argv) {
  let out = MANIFEST_PATH;
  let print = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--out') {
      const value = argv[++i];
      if (!value) {
        process.stderr.write('generate-legacy-skill-hashes: --out requires a path\n');
        process.exit(2);
      }
      out = path.resolve(value);
    } else if (flag === '--print') {
      print = true;
    } else if (flag === '-h' || flag === '--help') {
      process.stderr.write(
        'Usage: node tools/release/generate-legacy-skill-hashes.mjs [--out <path>] [--print]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`generate-legacy-skill-hashes: unknown flag: ${flag}\n`);
      process.exit(2);
    }
  }
  return { out, print };
}

function main() {
  const { out, print } = parseArgs(process.argv.slice(2));
  const manifest = buildManifest();
  const serialized = serializeManifest(manifest);
  if (print) {
    process.stdout.write(serialized);
  }
  writeFileSync(out, serialized, 'utf8');
  process.stderr.write(
    `generate-legacy-skill-hashes: wrote ${manifest.entries.length} entries across ` +
      `${manifest.releases.length} releases to ${path.relative(REPO_ROOT, out)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
