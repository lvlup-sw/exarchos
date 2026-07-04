#!/usr/bin/env node
/**
 * Multi-release legacy-render hash manifest generator (Task 023, DR-8).
 *
 * WHY THIS EXISTS
 * ---------------
 * Later tasks in the harness conform-and-shrink bundle delete stale
 * per-runtime *procedural* skill renders from consumer installs. Deleting a
 * consumer's on-disk `skills/<runtime>/<skill>/SKILL.md` is only safe when we
 * can prove the file provably came from us — i.e. its content hash matches a
 * render we once shipped. An install created from an OLD release hashed
 * against that OLD release's render content, so a single current-tree hash is
 * insufficient: we need the newline-normalized content hash of every
 * per-runtime skill render *across every historical release*.
 *
 * This manifest is derived from GIT HISTORY at the release tags, and is
 * deliberately INDEPENDENT of the current working tree. That independence is
 * load-bearing: a later `cleanStaleFiles` deletion pass runs during skills
 * regeneration, and if this generator read the worktree it could hash a
 * half-deleted tree and orphan a legitimately-installed file. Reading git
 * objects (`git ls-tree` + `git cat-file --batch`) sidesteps that entirely.
 *
 * SCOPE — ALL renders (superset), not procedural-only.
 * ----------------------------------------------------
 * The spec permits hashing every `skills/<runtime>/<skill>/SKILL.md` render at
 * each ref as a safe superset for provenance matching, and prefers it when a
 * clean procedural-vs-orchestration split is not readily derivable at a
 * historical ref. It is not: the procedural/orchestration classification lives
 * in `skills-src/` metadata that has moved across releases, and reconstructing
 * it per-tag is fragile. Hashing every render is provenance-safe (a superset
 * can only make a consumer file *more* likely to match a known-good render,
 * never less), so this generator hashes ALL renders. The only directory
 * excluded is `skills/test-fixtures/`, which is repo-internal test scaffolding
 * that never ships to a consumer install.
 *
 * RELEASE ENUMERATION
 * -------------------
 * Release tags are discovered with `git tag --list 'v2.*'` and filtered to
 * those whose numeric (major, minor, patch) is >= (2, 9, 0). A pre-release
 * tag whose base version qualifies (e.g. `v2.9.0-rc.1`, `v2.10.0-preview.2`)
 * is INCLUDED — installs were published from those pre-releases, and covering
 * them is the same provenance-safe superset. The current HEAD is appended as a
 * pseudo-release so the release being cut is always covered.
 *
 * DETERMINISM
 * -----------
 * The emitted JSON contains no timestamps or resolved HEAD sha, so
 * regenerating on the same tree is byte-idempotent (no spurious git churn).
 * Entries are sorted by (release order, path).
 *
 * Usage:
 *   node scripts/generate-legacy-skill-hashes.mjs [--out <path>] [--print]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
export const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'migrations',
  'legacy-skill-render-hashes.json',
);

/** Lowest release line covered by the manifest (inclusive). */
export const MIN_RELEASE = [2, 9, 0];

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
 * Semver-style comparison for release tags (base triple first, then a
 * pre-release is ordered *before* its release, then identifier-by-identifier
 * with numeric identifiers compared numerically and ranked below alphanumeric
 * ones). Deterministic and independent of git's own version-sort quirks.
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
  // Equal base: no-prerelease outranks any prerelease.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = a.pre[i];
    const bi = b.pre[i];
    if (ai === undefined) return -1; // shorter prerelease ranks lower
    if (bi === undefined) return 1;
    const aNum = /^\d+$/u.test(ai);
    const bNum = /^\d+$/u.test(bi);
    if (aNum && bNum) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Enumerate the release refs the manifest covers: every `v2.*` tag whose base
 * version is >= MIN_RELEASE (pre-releases of a qualifying base included),
 * sorted ascending, with the current HEAD appended as a pseudo-release.
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
      return v !== null && compareBase(v.base, MIN_RELEASE) >= 0;
    })
    .sort(compareVersionTags);
  return [...tags, 'HEAD'];
}

/**
 * List the per-runtime skill render paths (`skills/<runtime>/<skill>/SKILL.md`)
 * that exist in the committed tree at `ref`, excluding non-shipping fixture
 * directories. Reads the git tree object — never the working directory.
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
      // skills/<runtime>/<skill>/SKILL.md
      return (
        parts.length === 4 &&
        parts[0] === 'skills' &&
        parts[3] === 'SKILL.md' &&
        !EXCLUDED_RUNTIME_DIRS.has(parts[1])
      );
    })
    .sort();
}

/**
 * Newline-normalize (CRLF -> LF) then sha256-hash content. Accepts a string
 * or Buffer; SKILL.md renders are UTF-8 text. This normalization is the reason
 * a consumer file that only differs by line endings still hash-matches.
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
 * Read many git blobs in a single `git cat-file --batch` process. Input specs
 * are `<ref>:<path>` object names; output is a Map keyed by the same spec with
 * the raw blob Buffer as value. Missing objects are omitted from the map.
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
    // Header is either `<sha> <type> <size>` or `<name> missing`.
    if (/ missing$/u.test(header)) {
      continue;
    }
    const parts = header.split(' ');
    const size = Number(parts[parts.length - 1]);
    if (!Number.isFinite(size)) {
      throw new Error(`git cat-file --batch: bad header for ${spec}: ${header}`);
    }
    const content = buf.subarray(cursor, cursor + size);
    cursor += size + 1; // skip trailing LF after content
    out.set(spec, Buffer.from(content));
  }
  return out;
}

/**
 * Build the manifest object from git history. Pure with respect to the working
 * tree: it only consults git objects at the enumerated refs.
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

  // Gather (ref, path) pairs, dropping refs that carry no renders.
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

  // Deterministic order: release enumeration order, then path.
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
        'Usage: node scripts/generate-legacy-skill-hashes.mjs [--out <path>] [--print]\n',
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

// Run main() only when executed directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
