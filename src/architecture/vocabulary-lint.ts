/**
 * Vocabulary-lint scanner for invariant references. It finds `INV-*` and `DIM-*`
 * tokens in Markdown files and in registry action text. It reports each token that
 * the invariants catalog does not declare. The `npm run lint:invariants` CLI calls it.
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
  /** Absolute path to the invariants catalog. Defaults to `<repoRoot>/.exarchos/invariants.md`. */
  invariantsDoc?: string;
  /** Skip these directory names while walking. */
  skipDirs?: string[];
  /**
   * Explicit config for tests. Without it, `loadInvariantIds` reads the closest
   * `.exarchos.yml`. When that config does not register the catalog, the set of
   * known ids is empty, and every token is a finding.
   */
  config?: ExarchosConfig;
}

/** Matches invariant ids and the retired `DIM-*` ids, so a stale `DIM-*` reference is a finding. */
const TOKEN_RE = /\b(INV-\d+[a-d]?|DIM-\d+)\b/g;
const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
]);

/** Resolves the repository root, two directory levels above this module. */
function resolveRepoRoot(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '../..');
}

function defaultInvariantsDoc(): string {
  return path.join(resolveRepoRoot(), '.exarchos/invariants.md');
}

/** Scans one file for unknown invariant references. */
export function scanFile(
  file: string,
  options: ScanOptions = {},
): VocabularyFinding[] {
  const docPath = options.invariantsDoc ?? defaultInvariantsDoc();
  const knownIds = loadInvariantIds(docPath, options.config);
  return scanFileWithKnown(file, knownIds);
}

/**
 * Core token scan. Reports each `INV-*` or `DIM-*` token in `text` that is not in
 * `knownIds`, once per line, with `locator` as its `file`. It does no file I/O, so
 * the file scan and the registry scan share it.
 */
export function scanText(
  text: string,
  locator: string,
  knownIds: Set<string>,
): VocabularyFinding[] {
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
      const key = token;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        file: locator,
        line: i + 1,
        token,
        kind: 'unknown-invariant',
      });
    }
  }
  return findings;
}

function scanFileWithKnown(
  file: string,
  knownIds: Set<string>,
): VocabularyFinding[] {
  const text = fs.readFileSync(file, 'utf8');
  return scanText(text, file, knownIds);
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

/** The artifact directories that `datedRecordTrees` takes from their owner. */
export interface ArtifactDirs {
  /** The unified spec directory. Owner: `config/artifacts` `DEFAULT_SPEC_DIR`. */
  readonly specDir: string;
  /** The superseded design directory. Owner: `DEFAULT_LEGACY_DESIGN_DIR`. */
  readonly legacyDesignDir: string;
}

/**
 * Dated record trees: point-in-time artifacts that the vocabulary lint does not walk.
 * A token that was valid when a record was written must not fail the lint later.
 * The two artifact directories come from their owner as a parameter, because this
 * conformance module must not import the tree that it inspects.
 */
export function datedRecordTrees(dirs: ArtifactDirs): readonly string[] {
  return Object.freeze([
    dirs.legacyDesignDir,
    'docs/plans/',
    dirs.specDir,
    'docs/research/',
    'docs/rca/',
    'docs/contexts/',
    'docs/followups/',
    'docs/proposals/',
  ]);
}

/**
 * Default scan of the live normative surface: the `content/` tree of the repo. It
 * covers the authored commands under `content/<domain>/commands/`. It does not scan
 * the rendered copy, which repeats every finding. It does not scan the mounted
 * `docs/` trees, because they are present only after `docs:mount`.
 */
export function scanRepoDefaults(
  options: ScanOptions = {},
): VocabularyFinding[] {
  const root = resolveRepoRoot();
  return scanPaths(
    [
      path.join(root, 'content'),
    ],
    options,
  );
}

/**
 * The structural shape of a registry action that `scanRegistryActions` needs. It is
 * not imported from `registry.ts`, because a static import loads the large registry
 * module for every importer of this module. The real registry types match this shape.
 */
export interface RegistryActionLike {
  readonly name: string;
  readonly description: string;
}

/** The structural shape of a composite tool. See `RegistryActionLike`. */
export interface RegistryToolLike {
  readonly name: string;
  readonly actions: readonly RegistryActionLike[];
}

/**
 * Injectable loader that returns the exported composite tools, sync or async. Tests
 * inject a throwing or malformed loader to exercise the fail-closed path.
 */
export type RegistryLoader = () =>
  | Promise<readonly RegistryToolLike[]>
  | readonly RegistryToolLike[];

/**
 * Default loader: a dynamic import of the registry, run only when
 * `scanRegistryActions` runs. It adds no static import edge to this module. The
 * registry types pass through with no cast, so the compiler catches a shape change.
 */
async function defaultRegistryLoader(): Promise<
  readonly RegistryToolLike[]
> {
  const { TOOL_REGISTRY } = await import('../registry.js');
  return TOOL_REGISTRY;
}

/**
 * Type guard for a composite tool in the loader payload. A malformed injected loader
 * fails the same check that types the normal path.
 */
function isRegistryToolLike(value: unknown): value is RegistryToolLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'actions' in value &&
    Array.isArray(value.actions)
  );
}

function isRegistryActionLike(value: unknown): value is RegistryActionLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'description' in value &&
    typeof value.description === 'string'
  );
}

/**
 * Scans the `name` and `description` of every action of every exported composite
 * tool for `INV-*` and `DIM-*` tokens that the catalog does not declare. The registry
 * is TypeScript, so a raw file scan matches code and comments. This scan reads only
 * the action strings. The `file` of each finding is `registry.ts#<tool>.<action>`.
 *
 * It fails closed. When `loader` throws or returns a malformed shape, this function
 * throws and does not report zero findings.
 */
export async function scanRegistryActions(
  loader: RegistryLoader = defaultRegistryLoader,
  options: ScanOptions = {},
): Promise<VocabularyFinding[]> {
  const docPath = options.invariantsDoc ?? defaultInvariantsDoc();
  const knownIds = loadInvariantIds(docPath, options.config);

  const tools = await loader();
  if (!Array.isArray(tools)) {
    throw new Error(
      'scanRegistryActions: malformed registry — loader did not resolve an array of composite tools',
    );
  }

  const findings: VocabularyFinding[] = [];
  for (const tool of tools) {
    if (!isRegistryToolLike(tool)) {
      throw new Error(
        `scanRegistryActions: malformed composite tool entry — expected {name: string, actions: [...]}, got ${JSON.stringify(tool)}`,
      );
    }
    const { name: toolName, actions } = tool;
    for (const action of actions) {
      if (!isRegistryActionLike(action)) {
        throw new Error(
          `scanRegistryActions: malformed action entry in tool "${toolName}" — expected {name: string, description: string}, got ${JSON.stringify(action)}`,
        );
      }
      const { name: actionName, description } = action;
      const locator = `registry.ts#${toolName}.${actionName}`;
      findings.push(...scanText(actionName, locator, knownIds));
      findings.push(...scanText(description, locator, knownIds));
    }
  }
  return findings;
}
