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
import { loadInvariantIds } from './invariants-loader.js';
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';

export interface VocabularyFinding {
  file: string;
  line: number;
  token: string;
  kind: 'unknown-invariant';
}

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
