/**
 * Vocabulary-lint scanner for invariant references (issue #1260).
 *
 * Walks markdown files under the given roots, finds tokens matching
 * `/\b(INV-\d+[a-d]?|DIM-\d+)\b/`, and cross-checks them against the IDs
 * declared in `docs/architecture/invariants.md`. Unknown references are
 * returned as findings.
 *
 * Designed to be a thin library that the `npm run lint:invariants` CLI
 * wrapper can call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInvariantIds, loadInvariants } from './invariants-loader.js';
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';

export interface VocabularyFinding {
  file: string;
  line: number;
  token: string;
  kind: 'unknown-invariant';
}

/**
 * Coverage-closure finding (DR-8). Emitted for a `DIM-*` catalog entry that
 * is neither specialized by any `INV-*` (via `axiom_overlap`) nor explicitly
 * exempted with the `coverage: n/a` marker. `line` is 0 because the finding
 * is structural (derived from the catalog frontmatter), not a token on a
 * specific source line.
 */
export interface CoverageFinding {
  /** Absolute path to the invariants catalog the gap was found in. */
  file: string;
  /** Always 0 — structural finding, not anchored to a source line. */
  line: number;
  /** The uncovered `DIM-*` id. */
  token: string;
  kind: 'coverage-gap';
}

/**
 * Frontmatter marker that exempts a `DIM-*` entry from coverage closure.
 * The least-invasive convention chosen for DR-8: a `coverage: n/a` field on
 * the DIM entry. Surfaced through `InvariantEntry.raw` (the loader preserves
 * unknown fields), so no loader schema change is required.
 */
const COVERAGE_NA_MARKER = 'n/a';

export interface ScanOptions {
  /**
   * Absolute path to the invariants catalog markdown file. Defaults to
   * `<repoRoot>/docs/architecture/invariants.md`.
   */
  invariantsDoc?: string;
  /** Skip these directory names while walking. */
  skipDirs?: string[];
  /**
   * Optional Exarchos config — dependency injection for tests so they don't
   * depend on the state of the repo's `.exarchos.yml`. When omitted, the
   * underlying `loadInvariantIds` walks up from the catalog file to find
   * the closest `.exarchos.yml` and honours `invariants.devCatalog`. When
   * the gate is not `enabled`, the known-ID set is empty and every token
   * surfaces as a finding — consumers using Exarchos as a plugin therefore
   * opt into vocabulary-lint by declaring `invariants.devCatalog: enabled`
   * in their own `.exarchos.yml`.
   */
  config?: ExarchosConfig;
}

const TOKEN_RE = /\b(INV-\d+[a-d]?|DIM-\d+)\b/g;
const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
]);

/**
 * Resolve the repository root from this module's location.
 *
 * src/architecture/vocabulary-lint.ts → repo root is four levels up.
 */
function resolveRepoRoot(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '../../../..');
}

function defaultInvariantsDoc(): string {
  return path.join(resolveRepoRoot(), 'docs/architecture/invariants.md');
}

/**
 * Scan a single file for unknown invariant references.
 */
export function scanFile(
  file: string,
  options: ScanOptions = {},
): VocabularyFinding[] {
  const docPath = options.invariantsDoc ?? defaultInvariantsDoc();
  const knownIds = loadInvariantIds(docPath, options.config);
  return scanFileWithKnown(file, knownIds);
}

function scanFileWithKnown(
  file: string,
  knownIds: Set<string>,
): VocabularyFinding[] {
  const text = fs.readFileSync(file, 'utf8');
  const findings: VocabularyFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = TOKEN_RE.exec(line)) !== null) {
      const token = match[1]!;
      if (knownIds.has(token)) continue;
      // De-dup within a line so a token repeated on the same line is one
      // finding (line:token uniqueness).
      const key = token;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        file,
        line: i + 1,
        token,
        kind: 'unknown-invariant',
      });
    }
  }
  return findings;
}

/**
 * Walk one or more paths (files or directories) and scan every markdown file
 * (`*.md`) for unknown invariant references. Aggregates findings across files.
 */
export function scanPaths(
  paths: string[],
  options: ScanOptions = {},
): VocabularyFinding[] {
  const docPath = options.invariantsDoc ?? defaultInvariantsDoc();
  const knownIds = loadInvariantIds(docPath, options.config);
  const skipDirs = new Set([
    ...DEFAULT_SKIP_DIRS,
    ...(options.skipDirs ?? []),
  ]);
  const findings: VocabularyFinding[] = [];
  for (const root of paths) {
    if (!fs.existsSync(root)) continue;
    const stat = fs.statSync(root);
    if (stat.isFile()) {
      if (root.endsWith('.md')) {
        findings.push(...scanFileWithKnown(root, knownIds));
      }
      continue;
    }
    if (stat.isDirectory()) {
      walkDirectory(root, skipDirs, (file) => {
        findings.push(...scanFileWithKnown(file, knownIds));
      });
    }
  }
  return findings;
}

function walkDirectory(
  root: string,
  skipDirs: Set<string>,
  visit: (file: string) => void,
): void {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walkDirectory(full, skipDirs, visit);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      visit(full);
    }
  }
}

/**
 * Default scan: walks `docs/`, `skills-src/`, and `commands/` from the repo
 * root and returns aggregated findings. The exclusion list intentionally
 * omits `skills/<runtime>/` (generated content — drift in source surfaces
 * through `skills:guard`).
 */
export function scanRepoDefaults(
  options: ScanOptions = {},
): VocabularyFinding[] {
  const root = resolveRepoRoot();
  return scanPaths(
    [
      path.join(root, 'docs'),
      path.join(root, 'skills-src'),
      path.join(root, 'commands'),
    ],
    options,
  );
}

/**
 * Coverage-closure scan (DR-8). Every `DIM-*` entry in the catalog must be
 * "closed": either specialized by at least one `INV-*` whose `axiom_overlap`
 * points at it, OR explicitly exempted with the `coverage: n/a` marker on the
 * DIM entry. A `DIM-*` with neither is returned as a `coverage-gap` finding,
 * which drives the lint CLI to a non-zero exit.
 *
 * Additive to the existing token scanner: this inspects the parsed catalog
 * frontmatter (via `loadInvariants`) rather than walking markdown bodies, so
 * it composes alongside `scanRepoDefaults` without changing its behavior.
 *
 * When the `devCatalog` gate is not `enabled`, `loadInvariants` returns `[]`
 * and this scan yields no findings — consistent with the rest of the lint
 * opting out for plugin consumers who have not enabled the dev catalog.
 */
export function scanCoverageClosure(
  options: ScanOptions = {},
): CoverageFinding[] {
  const docPath = options.invariantsDoc ?? defaultInvariantsDoc();
  const entries = loadInvariants(docPath, { scope: 'all' }, options.config);

  // Set of DIM-* ids that at least one INV-* specializes via axiom_overlap.
  const specialized = new Set<string>();
  for (const entry of entries) {
    if (entry.axiomOverlap !== undefined) {
      specialized.add(entry.axiomOverlap);
    }
  }

  const findings: CoverageFinding[] = [];
  for (const entry of entries) {
    if (!entry.id.startsWith('DIM-')) continue;
    if (specialized.has(entry.id)) continue;
    if (hasCoverageNaMarker(entry.raw)) continue;
    findings.push({
      file: docPath,
      line: 0,
      token: entry.id,
      kind: 'coverage-gap',
    });
  }
  return findings;
}

/**
 * Detect the `coverage: n/a` exemption marker on a raw catalog entry.
 * Case-insensitive on the value so `N/A` reads the same as `n/a`.
 */
function hasCoverageNaMarker(raw: Record<string, unknown>): boolean {
  const value = raw['coverage'];
  return typeof value === 'string' && value.trim().toLowerCase() === COVERAGE_NA_MARKER;
}
