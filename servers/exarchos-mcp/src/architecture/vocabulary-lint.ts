/**
 * Vocabulary-lint scanner for invariant references (issue #1260).
 *
 * Walks markdown files under the given roots, finds tokens matching
 * `/\b(INV-\d+[a-d]?|DIM-\d+)\b/`, and cross-checks them against the IDs
 * declared in `.exarchos/invariants.md` (the dev catalog, relocated from
 * `docs/architecture/invariants.md` in T19). Unknown references are
 * returned as findings.
 *
 * Designed to be a thin library that the `npm run lint:invariants` CLI
 * wrapper can call.
 *
 * `scanRegistryActions` (DR-4/DR-5, issue #1706 task 004) extends the
 * corpus beyond markdown: MCP action `name`/`description` strings in
 * `registry.ts` are agent-facing normative text too. It shares the same
 * `scanText` token-scan core as the file-path scanners above, fed by a
 * structured (not raw-text) extraction of the registry's action metadata.
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
   * `<repoRoot>/.exarchos/invariants.md`.
   */
  invariantsDoc?: string;
  /** Skip these directory names while walking. */
  skipDirs?: string[];
  /**
   * Optional Exarchos config — dependency injection for tests so they don't
   * depend on the state of the repo's `.exarchos.yml`. When omitted, the
   * underlying `loadInvariantIds` walks up from the catalog file to find the
   * closest `.exarchos.yml` and honours its `invariants.catalogs`
   * REGISTRATIONS (DR-31). When the catalog file is not registered there, the
   * known-ID set is empty and every token surfaces as a finding — consumers
   * using Exarchos as a plugin therefore opt into vocabulary-lint by
   * registering their catalog in their own `.exarchos.yml`, e.g.
   * `invariants: { catalogs: [{ path: .exarchos/invariants.md, tier: dev }] }`.
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
  return path.join(resolveRepoRoot(), '.exarchos/invariants.md');
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

/**
 * Core token-scan loop (DR-5): scan `text` line-by-line for `INV-*`/`DIM-*`
 * tokens not present in `knownIds`, tagging each finding with `locator`.
 *
 * Factored out of the original file-IO-bound `scanFileWithKnown` so the
 * same matching/dedup logic can run over file contents (via
 * {@link scanFileWithKnown}, `locator` = the file path — unchanged
 * behavior) OR over an in-memory string that never touched disk (via
 * {@link scanRegistryActions}, `locator` = an action reference). `scanText`
 * itself has no file-IO dependency, so it is directly unit-testable.
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
      // De-dup within a line so a token repeated on the same line is one
      // finding (line:token uniqueness).
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

/**
 * Default scan: walks the *live normative* invariant-vocabulary surfaces from
 * the repo root and returns aggregated findings:
 *
 *   - `skills-src/` and `commands/` — templated surfaces rendered into skills
 *     and command bodies that instruct agents using `INV-*` vocabulary.
 *   - `docs/architecture/` — the catalog itself plus its reference prose.
 *   - `docs/guides/` — consumer-facing guides that cite `INV-*` IDs.
 *
 * It intentionally does NOT walk all of `docs/`. The {@link DATED_RECORD_TREES}
 * are point-in-time artifacts: a token that was valid vocabulary when the doc was
 * written (e.g. the `DIM-*` axiom dimensions, retired in #1477) should not
 * retroactively fail the lint forever. Policing only the live surfaces keeps the
 * gate meaningful — a stale reference in a templated or architecture doc still
 * surfaces — without churning historical record. (The exclusion also omits
 * `skills/<runtime>/` generated content; drift there surfaces via `skills:guard`.)
 */
/**
 * Dated record trees — point-in-time artifacts NOT walked by the vocabulary lint
 * (the depth-axis sibling of why the live surfaces above ARE walked). `docs/specs/`
 * is included (#1581 task 019): the collapsed flow's unified design+plan artifact
 * is a dated record like the former `docs/designs/` + `docs/plans/` it replaces,
 * so it must be classified the same way — never retroactively linted.
 */
export const DATED_RECORD_TREES: readonly string[] = Object.freeze([
  'docs/designs/',
  'docs/plans/',
  'docs/specs/',
  'docs/research/',
  'docs/rca/',
  'docs/contexts/',
  'docs/followups/',
  'docs/proposals/',
]);

export function scanRepoDefaults(
  options: ScanOptions = {},
): VocabularyFinding[] {
  const root = resolveRepoRoot();
  return scanPaths(
    [
      path.join(root, 'docs/architecture'),
      path.join(root, 'docs/guides'),
      path.join(root, 'skills-src'),
      path.join(root, 'commands'),
    ],
    options,
  );
}

// The coverage-closure scan (DR-8) was removed with the axiom excision
// (#1477). It verified that every `DIM-*` axiom-dimension entry was
// specialized by an `INV-*` via `axiom_overlap` or exempted with a
// `coverage: n/a` marker; both the DIM-* entries and the `axiom_overlap`
// field are now gone, so the scan has no work to do. The token scanner
// above still recognizes the `DIM-\d+` shape so a stale DIM-N reference in
// `docs/`, `skills-src/`, or `commands/` surfaces as an unknown-invariant
// finding.

// ─── Registry action corpus (DR-4/DR-5, issue #1706 task 004) ─────────────
//
// MCP action `name`/`description` strings (`registry.ts`) are agent-facing
// normative text on par with the four `.md` surfaces above, but they are
// TypeScript source, not markdown — relaxing the `.md` file walk to read
// `registry.ts` raw would fire TOKEN_RE on code and comments (rejected in
// the spec's alternatives). Instead we pull ONLY the action metadata
// strings out via a structured extractor and feed them through the same
// `scanText` core the file scanners use.

/**
 * The minimal structural shape `scanRegistryActions` needs from a composite
 * tool. Deliberately NOT `import`ed (type or value) from `registry.ts` — a
 * static import edge would parse the ~4k-line registry module at
 * `vocabulary-lint` module-load (paid by every importer, including callers
 * that never scan the registry) and would defeat the lazy-load contract
 * DR-5 requires. `registry.ts`'s real `CompositeTool`/`ToolAction` shapes
 * are structurally compatible with this interface, so no cast is needed at
 * the loader boundary beyond narrowing `unknown`.
 */
export interface RegistryActionLike {
  readonly name: string;
  readonly description: string;
}

/** The minimal structural shape of a composite tool, mirroring the above. */
export interface RegistryToolLike {
  readonly name: string;
  readonly actions: readonly RegistryActionLike[];
}

/**
 * Injectable loader seam (DR-5): resolves the full set of exported
 * composite tools. May be sync or async — `scanRegistryActions` awaits
 * either. Tests inject a throwing or malformed loader to exercise the
 * fail-closed path without touching the real registry.
 */
export type RegistryLoader = () =>
  | Promise<readonly RegistryToolLike[]>
  | readonly RegistryToolLike[];

/**
 * Default loader: a lazy `import()` of `../registry.js`, evaluated only
 * when `scanRegistryActions` actually runs (lint-time), never at this
 * module's own load time. This is a dynamic `import()` call inside a
 * function body — not a static top-level `import` declaration — so it adds
 * no static registry import edge to `vocabulary-lint.ts`.
 */
async function defaultRegistryLoader(): Promise<
  readonly RegistryToolLike[]
> {
  // No cast: `CompositeTool`/`ToolAction` are structurally assignable to the
  // local `RegistryToolLike`/`RegistryActionLike` shapes, so the real export
  // type flows straight through. Widening it through `unknown` first would
  // only discard the compiler's ability to catch a registry shape change here.
  const { TOOL_REGISTRY } = await import('../registry.js');
  return TOOL_REGISTRY;
}

/**
 * Runtime shape checks for the loader's payload (DR-5 fail-closed path).
 *
 * These are type-guard predicates over `unknown`, not assertion probes:
 * `in`-narrowing lets the compiler carry the narrowed type out of the check,
 * so each call site destructures a genuinely narrowed value instead of
 * re-asserting one. An injected malformed loader is therefore rejected by the
 * same code path that types the happy path.
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
 * Scan the `name` + `description` of every action across every exported
 * composite tool (`exarchos_workflow` / `exarchos_event` /
 * `exarchos_orchestrate` / `exarchos_view`, DR-4) for `INV-*`/`DIM-*`
 * tokens absent from the invariants catalog.
 *
 * Fails closed (DR-5): if `loader` throws/rejects, or resolves to a shape
 * that is not an array of `{name, actions: [{name, description}, ...]}`
 * entries, this function throws rather than silently reporting zero
 * findings — a lint that goes quiet on a broken registry is worse than no
 * lint.
 *
 * Each finding's `file` carries a stable locator: `registry.ts#<tool
 * name>.<action name>` (registry.ts where resolvable, plus the action
 * name — DR-5).
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
