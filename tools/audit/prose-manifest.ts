/**
 * The prose exodus manifest, and the reconciliation that gates deletion.
 *
 * Documents leaving this repository go to an external documents repository.
 * Deletion here is IRREVERSIBLE from the reader's point of view — a link that
 * used to resolve stops resolving — so preservation has to be provable before
 * anything is removed, not asserted afterwards.
 *
 * The manifest is that proof. It records, per file, the source path, the
 * destination path, the byte length and a SHA-256 of the content. Reconciling
 * means reading the destination and recomputing: a file that is present but
 * different fails exactly like a file that is absent, which is the property a
 * copy-and-hope transfer does not have.
 *
 * ── WHAT STAYS, AND WHY THE RULE IS STATED THIS WAY ROUND ───────────────────
 * Eligibility was once "no live referrer points at this subtree". Measured,
 * that rule blocked 462 files on 362 references — and 200 of those were a PATH
 * IN A COMMENT, a citation a reader might follow rather than anything the
 * program reads. Of those, 128 pointed into `docs/designs/` or `docs/plans/`,
 * which the comment policy already forbids on the stated grounds that "the
 * document may move out of this repository". The gate was preserving links the
 * policy wanted deleted.
 *
 * So the rule is inverted: name what STAYS, and move the rest. A retained entry
 * has to earn its place by being READ — by the program, by a test, or by a user
 * who was handed the path — not by being mentioned. {@link RETAINED} is that
 * list and each entry carries its reason.
 *
 * A citation left pointing at a relocated document is not a break: the mount
 * puts the file back at its original path. Unmounted it does not resolve, and
 * that is the honest trade — nothing FAILS, because nothing reads it.
 *
 * ── THE DESTINATION LAYOUT ──────────────────────────────────────────────────
 * `<documents-repo>/exarchos/<source-path>` — the repository name as the key,
 * then the source path preserved verbatim underneath. Two consequences, both
 * intended: a reader at the destination can see where a document came from
 * without a lookup table, and the mapping is mechanical enough that a symlink
 * mount is a per-directory `ln -s` rather than a translation.
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
  /** The subtrees this manifest covers, and why they were eligible. */
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

/** Build the manifest for an explicit list of source paths. */
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
  // The subtree list is DERIVED from what was actually included, so it can
  // never claim coverage the entries do not have.
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
 * `checked` is reported alongside `ok` on purpose: a reconciliation over an
 * empty manifest is clean for every destination, including one that received
 * nothing at all, so the caller has to be able to see the denominator.
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
