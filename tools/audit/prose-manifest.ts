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
 * ── WHY ONLY SOME SUBTREES ──────────────────────────────────────────────────
 * The reference census measures, per subtree, whether anything still points at
 * it. Only a subtree with ZERO live referrers is eligible: moving one that is
 * still referenced converts a working link into a broken one, and does it in
 * bulk. Eligibility is read from the census at generation time rather than
 * listed here, so this tool cannot drift from the measurement that governs it.
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

/** Build the manifest for the given subtrees. */
export function buildManifest(
  repoRoot: string,
  subtrees: readonly string[],
  capturedAt: string,
): ProseManifest {
  const entries: ProseManifestEntry[] = [];
  for (const subtree of [...subtrees].sort()) {
    for (const source of trackedUnder(repoRoot, subtree).sort()) {
      const bytes = readFileSync(path.join(repoRoot, source));
      entries.push({
        source,
        destination: destinationFor(source),
        bytes: bytes.length,
        digest: digestOf(bytes),
      });
    }
  }
  return {
    destinationRepo: DESTINATION_REPO,
    destinationKey: DESTINATION_KEY,
    capturedAt,
    subtrees: [...subtrees].sort(),
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
