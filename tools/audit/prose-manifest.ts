/**
 * The prose exodus manifest, and the reconciliation that gates deletion.
 *
 * Documents that leave this repository go to an external documents repository. The manifest
 * records the source path, destination path, byte length and SHA-256 of each file. Reconcile
 * reads the destination and recomputes each digest, so a changed file fails like an absent file.
 *
 * The rule names what stays, and the rest moves. A retained entry must be read by the program,
 * a test, or a user who has the path. {@link RETAINED} lists each entry with its reason.
 * When the mount is active, a citation to a moved document resolves at its original path.
 *
 * The destination layout is `<documents-repo>/exarchos/<source-path>`. A reader can see the
 * origin of a document, and a symlink mount is one `ln -s` for each directory.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The repository name that keys this project's documents at the destination. */
export const DESTINATION_KEY = 'exarchos';

/**
 * Paths under `docs/` that STAY, and the reason each is read rather than
 * merely mentioned. Everything else under `docs/` relocates.
 *
 * A prefix match: naming a directory retains it whole.
 */
export const RETAINED: ReadonlyArray<{ readonly path: string; readonly because: string }> =
  Object.freeze([
    {
      path: 'docs/README.md',
      because:
        'Every structural directory states what belongs in it and what does not; a test ' +
        'enumerates the directories so a seventh cannot appear without one.',
    },
    {
      path: 'docs/system-design.html',
      because:
        'The canonical statement of the nine-layer architecture — the one description of the ' +
        'system that is kept rather than relocated.',
    },
    {
      path: 'docs/phase-gate-taxonomy.html',
      because:
        'The canonical statement of the phase-gate architecture, measured from the live registry, ' +
        'HSM factories, policy tables and effect ledger rather than transcribed. It is READ when a ' +
        'gate is added, retyped or re-bound: it names the four resolver families, the three ' +
        'execution tracks, and which obligations record nothing. Sibling to system-design.html.',
    },
    {
      path: 'docs/.vitepress/',
      because:
        'The published site is built from this directory: `npm run docs:build` reads the config, ' +
        'and the deploy workflow uploads what it emits. Read by a program, not by a reader.',
    },
    {
      path: 'docs/index.md',
      because:
        'The only page the site has. VitePress requires a home page to build at all, so this is ' +
        'part of the build input rather than a document.',
    },
    {
      path: 'docs/public/',
      because:
        'Served verbatim at the site root. The deploy workflow stages the bootstrap installers ' +
        'here, which is what makes the README install one-liner resolve to a stable URL.',
    },
    {
      path: 'docs/migrations/2026-08-10-event-name-grammar.md',
      because:
        'The event-name grammar the persisted-replay tests bind to. A dated migration ' +
        'record that is read, not a planning document that relocates.',
    },
  ]);

/** Is this path retained? */
export function isRetained(rel: string): boolean {
  return RETAINED.some((r) => (r.path.endsWith('/') ? rel.startsWith(r.path) : rel === r.path));
}

/** Where the documents go. Recorded so the manifest names its own destination. */
export const DESTINATION_REPO = 'lvlup-sw/docs';

export interface ProseManifestEntry {
  /** Repo-relative source path, as tracked by git. */
  readonly source: string;
  /** Path within the destination repository. */
  readonly destination: string;
  readonly bytes: number;
  /** `sha256:<hex>` over the file's exact bytes. */
  readonly digest: string;
}

export interface ProseManifest {
  readonly destinationRepo: string;
  readonly destinationKey: string;
  readonly capturedAt: string;
  /** The subtrees that the entries cover. */
  readonly subtrees: readonly string[];
  readonly counts: { readonly files: number; readonly bytes: number };
  readonly entries: readonly ProseManifestEntry[];
}

export function digestOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Map a source path to its destination path under the key. */
export function destinationFor(source: string): string {
  return `${DESTINATION_KEY}/${source}`;
}

/** Tracked files under a subtree, repo-relative and forward-slashed. */
export function trackedUnder(repoRoot: string, subtree: string): string[] {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '--', subtree], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((rel) => rel.length > 0);
}

/**
 * Build the manifest for an explicit list of source paths. The subtree list derives from the
 * entries, so it cannot claim coverage that the entries do not have.
 */
export function buildManifest(
  repoRoot: string,
  sources: readonly string[],
  capturedAt: string,
): ProseManifest {
  const entries: ProseManifestEntry[] = [];
  for (const source of [...sources].sort()) {
    const bytes = readFileSync(path.join(repoRoot, source));
    entries.push({
      source,
      destination: destinationFor(source),
      bytes: bytes.length,
      digest: digestOf(bytes),
    });
  }
  const subtrees = [
    ...new Set(entries.map((e) => e.source.split('/').slice(0, 2).join('/'))),
  ].sort();
  return {
    destinationRepo: DESTINATION_REPO,
    destinationKey: DESTINATION_KEY,
    capturedAt,
    subtrees,
    counts: {
      files: entries.length,
      bytes: entries.reduce((n, e) => n + e.bytes, 0),
    },
    entries,
  };
}

export interface ReconcileFinding {
  readonly source: string;
  readonly destination: string;
  readonly reason: 'absent' | 'digest-mismatch';
}

export interface ReconcileResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly findings: readonly ReconcileFinding[];
}

/**
 * Read the destination and recompute every digest.
 *
 * The result reports `checked` next to `ok`, because a reconcile of an empty
 * manifest is clean for any destination. The caller must see that count.
 */
export function reconcile(manifest: ProseManifest, destinationRoot: string): ReconcileResult {
  const findings: ReconcileFinding[] = [];
  for (const entry of manifest.entries) {
    const abs = path.join(destinationRoot, entry.destination);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      findings.push({ source: entry.source, destination: entry.destination, reason: 'absent' });
      continue;
    }
    if (digestOf(readFileSync(abs)) !== entry.digest) {
      findings.push({
        source: entry.source,
        destination: entry.destination,
        reason: 'digest-mismatch',
      });
    }
  }
  return { ok: findings.length === 0, checked: manifest.entries.length, findings };
}

/** Render a reconciliation for a failing assertion or a console. */
export function formatReconcile(result: ReconcileResult): string {
  if (result.ok) return `reconciled ${result.checked} file(s) against the destination — all match`;
  return [
    `${result.findings.length} of ${result.checked} file(s) did not reconcile:`,
    ...result.findings.map((f) => `  ${f.reason.padEnd(16)} ${f.destination}`),
    '',
    'Deletion is gated on this passing. A file that is present but DIFFERENT fails',
    'here exactly like one that is absent — that is the point of the digest.',
  ].join('\n');
}
