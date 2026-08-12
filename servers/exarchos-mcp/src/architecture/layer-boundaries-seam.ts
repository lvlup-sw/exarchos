import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  EXCLUDED_DIRS,
  isScannableFile,
  extractImportSpecifiers,
  type ModuleLexer,
} from './effect-ledger.js';
import {
  SDK_SEAM_MODULE,
  collectSdkImports,
  isOwnedSeamModule,
  type SdkGeneration,
  type SpecifierParser,
} from './sdk-generation-seam.js';

/**
 * P07-06 — allowed-dependency layering census (structural conformance).
 *
 * The structural-closure plan (BASE-003, WFQ-016) requires the module graph to
 * declare *which layer may import which* and for **mechanical checks to reject
 * forbidden imports**. This module is that check: a comment/string-aware static
 * scan of the shipped source that resolves every first-party import edge to a
 * (sourceLayer → targetLayer) directory edge and fails closed when a *governed*
 * layer reaches a directory its declared allowance does not permit.
 *
 * It follows the established `architecture/effect-ledger.ts` /
 * `architecture/vcs-ownership.ts` census pattern — a source scan yielding a typed
 * verdict over the *real* tree, so a regression (a new forbidden cross-layer
 * edge) trips it rather than a hand-maintained mirror — and it reuses the ledger's
 * comment/string-aware {@link extractImportSpecifiers} so the two censuses agree
 * on what counts as an import. Like the ledger it is a **two-way ratchet**:
 *
 *   - FORBIDDEN_IMPORT       — a governed layer imports a directory its declared
 *                              allowance does not list (names BOTH module ends);
 *   - STALE_LAYER_ALLOWANCE  — a declared allowance no live edge exercises
 *                              (phantom cover), so the allowlist can never rot.
 *
 * ── Governed layers (incremental coverage) ──────────────────────────────────
 * The layering is declared INCREMENTALLY: {@link LAYER_ALLOWED_IMPORTS} governs
 * the foundational / peripheral directories whose cross-directory dependency
 * surface is small, well-understood, and architecturally intended to stay
 * bounded. Directories NOT listed are UNGOVERNED (the tangled application core is
 * not frozen by this pass — that would demand a large baseline that says little).
 * Each governed layer's `allow` set is the EXACT current cross-directory surface,
 * so both ratchet teeth bite: adding an outbound dependency trips FORBIDDEN, and
 * removing a declared one trips STALE.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Edges are resolved at DIRECTORY granularity: a module's layer is its first path
 * segment. Intra-layer edges (same first segment) are ignored. Edges to a
 * *root-level* file (a shipped `.ts` directly under the scan root, e.g.
 * `format.ts`, `logger.ts`, `registry.ts`) are treated as a shared-root surface
 * and are NOT layer edges — a deliberate, documented scoping choice mirroring the
 * bounded scope `vcs-ownership.ts` documents. Type-only and runtime imports are
 * both counted: a type dependency is still an architectural coupling for layering.
 *
 * ── Second census in this module: the DECLARATION SEAM (DR-1) ───────────────
 * The bottom half of this file carries a second, independent census over the
 * same scan: DR-1's rule that declarations are consumed ONLY through
 * `contract/declaration-seam.ts`. It lives here because DR-1 names this module
 * its enforcement point, and it is a separate census rather than a row in
 * {@link LAYER_ALLOWED_IMPORTS} for a mechanical reason — the biggest
 * declaration store, `registry.ts`, is a ROOT-LEVEL file, and the layering
 * census above deliberately excludes root-file imports from the layer-edge set.
 * An allowance row could therefore never see the edge it needs to reject. See
 * {@link DECLARATION_SEAM}.
 *
 * ── Third census in this module: the SDK GENERATION SEAM (DR-26) ────────────
 * The last section carries a third census, and it is the same rule applied to a
 * third boundary: DR-26's requirement that `contract/sdk/seam.ts` is the SOLE importer of
 * either MCP SDK generation. A module reaching a `@modelcontextprotocol/*`
 * package directly fails it. See {@link SDK_SEAM_BOUNDARY}.
 *
 * It is a separate census rather than a {@link LAYER_ALLOWED_IMPORTS} row for
 * the same mechanical reason DR-1's is: the layering census resolves FIRST-PARTY
 * edges only ({@link resolveTarget} returns `undefined` for a bare package
 * specifier), so no allowance row can see an SDK import at all. That blind spot
 * is not incidental — it is exactly why the coupling went unmodelled until
 * DR-26 named it.
 */

/** A resolved first-party cross-directory import edge. */
export interface LayerEdge {
  /** Repo-relative-to-scan-root source module, forward-slashed. */
  readonly module: string;
  /** The importing module's layer (its first path segment). */
  readonly sourceLayer: string;
  /** The resolved target module, forward-slashed. */
  readonly targetModule: string;
  /** The target module's layer (its first path segment). */
  readonly targetLayer: string;
  /** The raw import specifier that produced the edge. */
  readonly specifier: string;
}

/** A declared allowance: `layer` may import the directories in `allow` (only). */
export interface LayerAllowance {
  /** The governed source directory (first path segment). */
  readonly layer: string;
  /** The exact set of directories `layer` is permitted to import. */
  readonly allow: readonly string[];
  /** Why this layer's dependency surface is bounded the way it is. */
  readonly note: string;
}

export type LayerBoundaryDiagnostic =
  | {
      readonly code: 'FORBIDDEN_IMPORT';
      readonly module: string;
      readonly sourceLayer: string;
      readonly targetModule: string;
      readonly targetLayer: string;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_LAYER_ALLOWANCE';
      readonly layer: string;
      readonly target: string;
      readonly message: string;
    };

export interface LayerBoundaryResult {
  readonly ok: boolean;
  readonly edgeCount: number;
  readonly diagnostics: readonly LayerBoundaryDiagnostic[];
}

// ─── Detection ──────────────────────────────────────────────────────────────

/** The layer (first path segment) of a repo-relative module path. */
export function layerOf(module: string): string {
  const slash = module.indexOf('/');
  return slash === -1 ? module : module.slice(0, slash);
}

/** A root-level shipped file (no directory segment) — a shared-root surface. */
export function isRootFile(module: string): boolean {
  return !module.includes('/');
}

/**
 * Resolve a relative import specifier against the importing module to a
 * repo-relative, forward-slashed target module path. Returns `undefined` for a
 * non-first-party specifier (bare package / `node:` builtin) or one that escapes
 * the scan root. The NodeNext `.js` specifier is mapped back to its `.ts` source.
 */
export function resolveTarget(module: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const stack = module.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) return undefined;
  return stack.join('/').replace(/\.(js|jsx|mjs|cjs)$/, '.ts');
}

/**
 * Enumerate the first-party cross-directory import edges of one module. Pure;
 * the specifiers come from the ledger's lexer PORT via {@link
 * extractImportSpecifiers}, so a store named only in prose is not an edge and a
 * nested template literal cannot manufacture one. Intra-layer edges and edges to
 * a root-level file are excluded (see the scope note above).
 *
 * Type-only imports and `import('…')` type queries ARE edges here — the question
 * is layering, not runtime effect — which is why this consumes the full
 * specifier surface rather than the ledger's value-import filter.
 */
export function detectLayerEdges(
  module: string,
  source: string,
  lex: ModuleLexer,
): LayerEdge[] {
  if (isRootFile(module)) return [];
  const sourceLayer = layerOf(module);
  const edges: LayerEdge[] = [];
  const seen = new Set<string>();
  for (const specifier of extractImportSpecifiers(source, lex)) {
    const targetModule = resolveTarget(module, specifier);
    if (targetModule === undefined) continue;
    if (isRootFile(targetModule)) continue;
    const targetLayer = layerOf(targetModule);
    if (targetLayer === sourceLayer) continue;
    const key = `${targetModule}\u0000${specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ module, sourceLayer, targetModule, targetLayer, specifier });
  }
  return edges;
}

async function collectScannableFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && isScannableFile(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** Scan the shipped source under `sourceRoot` and enumerate every layer edge. */
export async function scanLayerEdges(
  sourceRoot: string,
  lex: ModuleLexer,
): Promise<readonly LayerEdge[]> {
  const files = await collectScannableFiles(sourceRoot);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const module = relative(sourceRoot, file).replaceAll('\\', '/');
      return detectLayerEdges(module, await readFile(file, 'utf8'), lex);
    }),
  );
  return Object.freeze(
    perFile.flat().sort((a, b) =>
      a.module === b.module
        ? a.targetModule < b.targetModule
          ? -1
          : 1
        : a.module < b.module
          ? -1
          : 1,
    ),
  );
}

// ─── Census ─────────────────────────────────────────────────────────────────

/**
 * Pure layering verdict over an already-collected edge set and allowance set.
 *
 * Two independent, complementary checks, each with its own diagnostic:
 *   - FORBIDDEN_IMPORT      — a governed layer's edge to a non-allowed directory;
 *   - STALE_LAYER_ALLOWANCE — an allowance no live edge exercises (phantom cover).
 */
export function runLayerBoundaryCensus(
  edges: readonly LayerEdge[],
  allowances: readonly LayerAllowance[] = LAYER_ALLOWED_IMPORTS,
): LayerBoundaryResult {
  const byLayer = new Map<string, ReadonlySet<string>>();
  for (const allowance of allowances) byLayer.set(allowance.layer, new Set(allowance.allow));

  const diagnostics: LayerBoundaryDiagnostic[] = [];

  for (const edge of edges) {
    const allow = byLayer.get(edge.sourceLayer);
    if (allow === undefined) continue; // ungoverned source layer
    if (allow.has(edge.targetLayer)) continue;
    diagnostics.push({
      code: 'FORBIDDEN_IMPORT',
      module: edge.module,
      sourceLayer: edge.sourceLayer,
      targetModule: edge.targetModule,
      targetLayer: edge.targetLayer,
      message:
        `Forbidden import: "${edge.module}" (layer "${edge.sourceLayer}") imports ` +
        `"${edge.targetModule}" (layer "${edge.targetLayer}"). The "${edge.sourceLayer}" ` +
        `layer may only import [${[...(allow ?? [])].sort().join(', ') || '<none>'}]. ` +
        `Break the dependency or widen LAYER_ALLOWED_IMPORTS for "${edge.sourceLayer}".`,
    });
  }

  for (const allowance of allowances) {
    for (const target of allowance.allow) {
      const live = edges.some(
        (edge) => edge.sourceLayer === allowance.layer && edge.targetLayer === target,
      );
      if (!live) {
        diagnostics.push({
          code: 'STALE_LAYER_ALLOWANCE',
          layer: allowance.layer,
          target,
          message:
            `Layer allowance "${allowance.layer}" -> "${target}" is exercised by no live ` +
            `import — stale cover. Remove it from LAYER_ALLOWED_IMPORTS or restore the edge.`,
        });
      }
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    edgeCount: edges.length,
    diagnostics,
  });
}

/** Collect the live layer edges and return the census verdict over the real tree. */
export async function auditLayerBoundaries(
  sourceRoot: string,
  lex: ModuleLexer,
  allowances: readonly LayerAllowance[] = LAYER_ALLOWED_IMPORTS,
): Promise<LayerBoundaryResult> {
  const edges = await scanLayerEdges(sourceRoot, lex);
  return runLayerBoundaryCensus(edges, allowances);
}

// ─── The declared layering ──────────────────────────────────────────────────
//
// One entry per governed source directory. `allow` is the EXACT current
// cross-directory surface (edges to root-level files excluded, see scope note),
// so both ratchet teeth are live: a NEW outbound edge trips FORBIDDEN_IMPORT and
// a REMOVED one trips STALE_LAYER_ALLOWANCE. Adding a new outbound dependency to
// any governed layer is a conscious decision recorded here.

const allowance = (layer: string, allow: readonly string[], note: string): LayerAllowance => ({
  layer,
  allow: Object.freeze([...allow]),
  note,
});

export const LAYER_ALLOWED_IMPORTS: readonly LayerAllowance[] = Object.freeze([
  // ── foundation leaves: import NO other first-party directory ───────────────
  allowance('utils', [], 'Foundation leaf — cross-OS/process/format primitives; imports no first-party directory.'),
  allowance('lib', [], 'Foundation leaf — pure library helpers; imports no first-party directory.'),
  allowance('shared', [], 'Foundation leaf — shared value types/helpers; imports no first-party directory.'),
  allowance('ndjson', [], 'Foundation leaf — NDJSON framing primitives; imports no first-party directory.'),
  allowance('schemas', [], 'Foundation leaf — shared schema declarations; imports no first-party directory.'),

  // ── peripheral layers: bounded, intentional dependency surfaces ────────────
  allowance('runtime', ['utils'], 'Runtime resource reads lean only on the utils foundation.'),
  allowance('onramp', ['utils'], 'Onboarding scaffold leans only on the utils foundation.'),
  allowance('pruner', ['workflow'], 'Pruner safeguards read the topology contract, which task 013 folded into workflow/.'),
  allowance('hooks', ['config'], 'Hook wiring reads only config; hooks are an advisory side-channel.'),
  allowance('runbooks', ['adapters'], 'Runbooks render only through the adapters IO facade.'),
  allowance(
    'projections',
    [
      'adapters', 'architecture', 'capabilities', 'config', 'contract', 'describe',
      'dispatch', 'events', 'verbs', 'stack', 'storage', 'utils', 'workflow',
    ],
    'The WIDEST allowance in this table, and deliberately so: task 012 folded ' +
      'views/, telemetry/, quality/, session/ and task-store/ into projections/, so this ' +
      'layer now carries the UNION of five directories\' import surfaces. Every edge here ' +
      'existed before the fold — `views/` has always called into orchestrate and workflow — ' +
      'but each was invisible to this census while the five had separate layer names and ' +
      'their couplings read as ordinary cross-layer traffic. Phase 1 is a pure move with ' +
      'zero semantic edits, so the surface is RECORDED here rather than narrowed. That the ' +
      'read side reaches the verb layer at all is the finding; acting on it is separate work, ' +
      'and this row is what keeps it measurable in the meantime.',
  ),
  allowance('stack', ['events', 'projections'], 'Stack renders event state through the projections layer.'),
  allowance(
    'cli',
    ['events', 'ndjson', 'contract', 'projections'],
    'CLI surface reads event state and frames it as NDJSON. The `contract` and ' +
      '`projections` edges are DR-26 / task 053: `cli/follow-loop.ts` and ' +
      '`cli/follow-formatter.ts` render the protocol `Task` payload and ask whether ' +
      'a status is terminal. Both used to reach `@modelcontextprotocol/sdk` DIRECTLY, ' +
      'so the coupling is not new — it was invisible to this census, which resolves ' +
      'FIRST-PARTY edges only. Routing it through the owned seam is what makes it ' +
      'visible, and a bare package import is the one form of coupling a layering ' +
      'census structurally cannot see. `task-store` carries `isTaskTerminal` because ' +
      'v2 deleted the SDK predicate; it is generation-neutral and imports nothing.',
  ),
  allowance(
    'workspace',
    ['capabilities', 'events', 'storage'],
    'Workspace resolves capabilities and persists via events/storage.',
  ),
  allowance(
    'agents',
    ['capabilities', 'utils', 'workflow'],
    'Agent definition loading resolves capabilities/workflow through the utils foundation.',
  ),
]);

// ════════════════════════════════════════════════════════════════════════════
// DR-1 — the DECLARATION SEAM census
// ════════════════════════════════════════════════════════════════════════════
//
// DR-1: "Declarations are consumed ONLY through the seam accessor; a direct read
// of registry storage from a consumer fails `layer-boundaries-seam.ts`."
//
// ── The rule, stated precisely ──────────────────────────────────────────────
// A module is a declaration CONSUMER when it imports the declaration contract
// (`contract/declaration.ts` — the envelope — or `contract/declaration-seam.ts`
// — the accessor). A consumer must NOT also import a declaration-STORAGE module.
// Those are the only two places a declaration can be obtained, so forbidding the
// second leaves the seam the sole supply route. That is DR-1's rung-2
// mechanism verbatim: "consumers may import only the declaration accessor's
// type, never the storage module", which is what makes #1258's relocation a
// COMPILE-TIME substitution rather than an edit across every consumer.
//
// ── Scope, stated honestly ──────────────────────────────────────────────────
// The rule is CONDITIONAL on consumer-hood, and that is deliberate. A module
// that reads `EVENT_EMISSION_REGISTRY` today and knows nothing about
// declarations is NOT a violation — it is un-migrated, and Waves 1b–4 move it.
// The census therefore needs no grandfather list and cannot rot into one: the
// moment such a module is migrated onto the envelope it becomes a consumer, and
// its leftover storage import fails on that same commit. The population is
// derived from the tree, never enumerated.
//
// ── Non-empty denominator (the vacuity guard) ───────────────────────────────
// A seam check that resolves nothing must FAIL, not report clean. Three
// independent ways this census could quietly become vacuous are each their own
// diagnostic:
//   - EMPTY_SEAM_DENOMINATOR('consumers')     — the contract modules were moved
//                                               or renamed, so no module still
//                                               resolves to a consumer;
//   - EMPTY_SEAM_DENOMINATOR('storage-sites') — the declared storage population
//                                               is empty, so no import could be
//                                               a violation by construction;
//   - UNRESOLVED_DECLARATION_STORAGE          — a declared store is gone from
//                                               the tree, or no longer exports
//                                               the symbol that made it a store.
// The third is the one #1258 will trip on purpose: relocating declarations into
// the IR unbinds `EVENT_EMISSION_REGISTRY` / `TOOL_REGISTRY`, and the gate then
// demands {@link DECLARATION_SEAM} be re-pointed rather than silently ranging
// over a store nobody writes to.
//
// ── The other tooth ─────────────────────────────────────────────────────────
// STALE_SOURCE_ADAPTER keeps the one legitimate exemption from becoming phantom
// cover: a module declared a {@link DeclarationSourceAdapter} — the lift FROM
// storage INTO the envelope, which necessarily touches both sides — but which
// imports no storage is not an adapter and loses the exemption.

/**
 * A declaration store: the module that currently holds declarations of some
 * kind, plus the exported symbol that makes it one.
 */
export interface DeclarationStorageSite {
  /** Repo-relative-to-scan-root module path, forward-slashed. */
  readonly module: string;
  /** The exported binding that holds the declarations. */
  readonly symbol: string;
  /** Which declaration kinds this store holds, and why the module is storage. */
  readonly note: string;
}

/**
 * The narrow exemption: a module whose JOB is to lift registrations out of
 * storage into declarations. It is the only shape that legitimately imports
 * both sides, and naming one is a deliberate, reviewed act.
 */
export interface DeclarationSourceAdapter {
  /** Repo-relative-to-scan-root module path, forward-slashed. */
  readonly module: string;
  /** Which store it adapts and why the double import is intended. */
  readonly note: string;
}

/** The declared shape of the declaration seam. */
export interface DeclarationSeamRule {
  /** The accessor consumers read declarations through. Must exist in the tree. */
  readonly accessor: string;
  /** Importing any of these makes a module a declaration consumer. */
  readonly contractModules: readonly string[];
  /** The stores a consumer may not import. */
  readonly storage: readonly DeclarationStorageSite[];
  /** Modules exempt from the no-storage rule, each with a rationale. */
  readonly sourceAdapters: readonly DeclarationSourceAdapter[];
}

/** One resolved import from a module into a declaration store. */
export interface DeclarationStorageImport {
  /** The resolved store module. */
  readonly storageModule: string;
  /** The raw import specifier that produced it. */
  readonly specifier: string;
}

/** A module's participation in the declaration seam, from its source alone. */
export interface DeclarationSeamUsage {
  /** Repo-relative-to-scan-root module path, forward-slashed. */
  readonly module: string;
  /** Specifiers resolving to a declaration-contract module (non-empty ⇒ consumer). */
  readonly contractImports: readonly string[];
  /** Imports reaching a declaration store. */
  readonly storageImports: readonly DeclarationStorageImport[];
}

/** Whether a declared store still resolves to a real, still-exporting module. */
export interface DeclarationStorageResolution {
  readonly module: string;
  readonly symbol: string;
  /** The module exists under the scan root AND still exports {@link symbol}. */
  readonly resolved: boolean;
}

/** Everything the declaration-seam census needs, collected from one scan. */
export interface DeclarationSeamScan {
  /** Every module touching either side of the seam. */
  readonly usages: readonly DeclarationSeamUsage[];
  /** Resolution status of every declared store. */
  readonly storage: readonly DeclarationStorageResolution[];
  /** Whether {@link DeclarationSeamRule.accessor} exists under the scan root. */
  readonly accessorPresent: boolean;
}

export type DeclarationSeamDiagnostic =
  | {
      readonly code: 'DIRECT_STORAGE_READ';
      readonly module: string;
      readonly storageModule: string;
      readonly specifier: string;
      readonly message: string;
    }
  | {
      readonly code: 'EMPTY_SEAM_DENOMINATOR';
      readonly population: 'consumers' | 'storage-sites';
      readonly message: string;
    }
  | {
      readonly code: 'UNRESOLVED_DECLARATION_STORAGE';
      readonly module: string;
      readonly symbol: string;
      readonly message: string;
    }
  | {
      readonly code: 'SEAM_ACCESSOR_MISSING';
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_SOURCE_ADAPTER';
      readonly module: string;
      readonly message: string;
    };

export interface DeclarationSeamResult {
  readonly ok: boolean;
  /** Modules that resolved to declaration consumers — the denominator. */
  readonly consumerCount: number;
  /** Declared stores that still resolve — the other denominator. */
  readonly resolvedStorageCount: number;
  readonly diagnostics: readonly DeclarationSeamDiagnostic[];
}

/**
 * Classify one module's participation in the declaration seam. Pure, and
 * comment/string-aware through the same {@link extractImportSpecifiers} the
 * layering census uses — a store named only in prose is not an import.
 *
 * Returns `undefined` for a module touching neither side, which is almost all of
 * them; the census only ever holds the modules that matter.
 *
 * Unlike {@link detectLayerEdges} this does NOT skip root-level targets: the
 * action and CLI-verb store is `registry.ts`, a root-level file, so skipping
 * them would blind the rule to its largest subject.
 */
export function detectDeclarationSeamUsage(
  module: string,
  source: string,
  lex: ModuleLexer,
  rule: DeclarationSeamRule = DECLARATION_SEAM,
): DeclarationSeamUsage | undefined {
  const contractModules = new Set(rule.contractModules);
  const storageModules = new Set(rule.storage.map((site) => site.module));

  const contractImports: string[] = [];
  const storageImports: DeclarationStorageImport[] = [];
  const seenContract = new Set<string>();
  const seenStorage = new Set<string>();

  for (const specifier of extractImportSpecifiers(source, lex)) {
    const target = resolveTarget(module, specifier);
    if (target === undefined || target === module) continue;
    if (contractModules.has(target) && !seenContract.has(specifier)) {
      seenContract.add(specifier);
      contractImports.push(specifier);
    }
    const storageKey = `${target} ${specifier}`;
    if (storageModules.has(target) && !seenStorage.has(storageKey)) {
      seenStorage.add(storageKey);
      storageImports.push({ storageModule: target, specifier });
    }
  }

  if (contractImports.length === 0 && storageImports.length === 0) return undefined;
  return Object.freeze({
    module,
    contractImports: Object.freeze(contractImports),
    storageImports: Object.freeze(storageImports),
  });
}

/**
 * Does `source` still export `symbol`, the binding that makes it a store?
 *
 * Anchored at line start so a mention inside a block comment (` * export const
 * TOOL_REGISTRY …`) or a doc line cannot keep a relocated store looking alive —
 * the failure mode this check exists to catch is precisely a store that MOVED
 * while its name lingered in prose.
 */
export function exportsDeclarationSymbol(source: string, symbol: string): boolean {
  return new RegExp(String.raw`^export\s+(?:declare\s+)?(?:const|let|var|function|class)\s+${symbol}\b`, 'm').test(
    source,
  );
}

/**
 * Pure declaration-seam verdict over an already-collected scan.
 *
 * Five independent checks; see the header block above for what each protects.
 */
export function runDeclarationSeamCensus(
  scan: DeclarationSeamScan,
  rule: DeclarationSeamRule = DECLARATION_SEAM,
): DeclarationSeamResult {
  const adapters = new Set(rule.sourceAdapters.map((adapter) => adapter.module));
  const diagnostics: DeclarationSeamDiagnostic[] = [];

  const consumers = scan.usages.filter((usage) => usage.contractImports.length > 0);

  for (const consumer of consumers) {
    if (adapters.has(consumer.module)) continue;
    for (const storageImport of consumer.storageImports) {
      diagnostics.push({
        code: 'DIRECT_STORAGE_READ',
        module: consumer.module,
        storageModule: storageImport.storageModule,
        specifier: storageImport.specifier,
        message:
          `Direct declaration-storage read: "${consumer.module}" consumes declarations ` +
          `(it imports ${consumer.contractImports.join(', ')}) AND imports the store ` +
          `"${storageImport.storageModule}" via "${storageImport.specifier}". DR-1 requires ` +
          `declarations to arrive through "${rule.accessor}" only — a consumer that also ` +
          `reaches into storage pins the declaration site in place and breaks the #1258 ` +
          `relocation. Read through the seam, or declare this module a source adapter in ` +
          `DECLARATION_SEAM.sourceAdapters if lifting registrations IS its job.`,
      });
    }
  }

  if (consumers.length === 0) {
    diagnostics.push({
      code: 'EMPTY_SEAM_DENOMINATOR',
      population: 'consumers',
      message:
        'Declaration-seam census resolved ZERO consumers. A check with an empty subject ' +
        'population passes for the wrong reason, so it fails instead. Either the contract ' +
        `modules [${rule.contractModules.join(', ')}] moved or were renamed, or the scan root ` +
        'is wrong — repoint DECLARATION_SEAM.contractModules.',
    });
  }

  if (rule.storage.length === 0) {
    diagnostics.push({
      code: 'EMPTY_SEAM_DENOMINATOR',
      population: 'storage-sites',
      message:
        'Declaration-seam census declares ZERO storage sites, so no import could ever be a ' +
        'direct storage read and the census is vacuous. Declare the stores DR-1 hides in ' +
        'DECLARATION_SEAM.storage.',
    });
  }

  for (const resolution of scan.storage) {
    if (resolution.resolved) continue;
    diagnostics.push({
      code: 'UNRESOLVED_DECLARATION_STORAGE',
      module: resolution.module,
      symbol: resolution.symbol,
      message:
        `Declared declaration store "${resolution.module}" does not resolve: the module is ` +
        `absent from the scanned tree or no longer exports "${resolution.symbol}". A store ` +
        'that moved must not read clean — repoint DECLARATION_SEAM.storage at where ' +
        'the declarations live now (this is the expected signal when #1258 relocates them ' +
        'into the IR).',
    });
  }

  if (!scan.accessorPresent) {
    diagnostics.push({
      code: 'SEAM_ACCESSOR_MISSING',
      module: rule.accessor,
      message:
        `The declaration seam accessor "${rule.accessor}" is absent from the scanned tree. ` +
        'With no accessor there is nothing for consumers to read through, so the census ' +
        'cannot be satisfied — restore it or repoint DECLARATION_SEAM.accessor.',
    });
  }

  for (const adapter of rule.sourceAdapters) {
    const usage = scan.usages.find((candidate) => candidate.module === adapter.module);
    if (usage !== undefined && usage.storageImports.length > 0) continue;
    diagnostics.push({
      code: 'STALE_SOURCE_ADAPTER',
      module: adapter.module,
      message:
        `Declared declaration-source adapter "${adapter.module}" imports no declaration ` +
        'store — stale cover. An exemption nothing exercises is a hole waiting for a ' +
        'violation to fall through it. Remove it from DECLARATION_SEAM.sourceAdapters or ' +
        'restore the lift.',
    });
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    consumerCount: consumers.length,
    resolvedStorageCount: scan.storage.filter((resolution) => resolution.resolved).length,
    diagnostics,
  });
}

/** Collect every declaration-seam usage and store resolution under `sourceRoot`. */
export async function scanDeclarationSeam(
  sourceRoot: string,
  lex: ModuleLexer,
  rule: DeclarationSeamRule = DECLARATION_SEAM,
): Promise<DeclarationSeamScan> {
  const files = await collectScannableFiles(sourceRoot);
  const modules = new Map<string, string>();
  for (const file of files) {
    modules.set(relative(sourceRoot, file).replaceAll('\\', '/'), file);
  }

  const usages: DeclarationSeamUsage[] = [];
  for (const module of [...modules.keys()].sort()) {
    const file = modules.get(module);
    if (file === undefined) continue;
    const usage = detectDeclarationSeamUsage(module, await readFile(file, 'utf8'), lex, rule);
    if (usage !== undefined) usages.push(usage);
  }

  const storage: DeclarationStorageResolution[] = [];
  for (const site of rule.storage) {
    const file = modules.get(site.module);
    const source = file === undefined ? undefined : await readFile(file, 'utf8');
    storage.push({
      module: site.module,
      symbol: site.symbol,
      resolved: source !== undefined && exportsDeclarationSymbol(source, site.symbol),
    });
  }

  return Object.freeze({
    usages: Object.freeze(usages),
    storage: Object.freeze(storage),
    accessorPresent: modules.has(rule.accessor),
  });
}

/** Scan the shipped source and return the declaration-seam verdict over the real tree. */
export async function auditDeclarationSeam(
  sourceRoot: string,
  lex: ModuleLexer,
  rule: DeclarationSeamRule = DECLARATION_SEAM,
): Promise<DeclarationSeamResult> {
  return runDeclarationSeamCensus(await scanDeclarationSeam(sourceRoot, lex, rule), rule);
}

// ─── The declared declaration seam ──────────────────────────────────────────

const storageSite = (module: string, symbol: string, note: string): DeclarationStorageSite => ({
  module,
  symbol,
  note,
});

export const DECLARATION_SEAM: DeclarationSeamRule = Object.freeze({
  accessor: 'contract/declaration-seam.ts',

  // Importing EITHER makes a module a declaration consumer. The envelope counts
  // alongside the accessor because holding a `Declaration` is the thing the rule
  // governs — a module that types itself against the envelope and then fills it
  // from storage has bypassed the seam just like one calling the store
  // directly, and would slip through an accessor-only definition.
  contractModules: Object.freeze(['contract/declaration.ts', 'contract/declaration-seam.ts']),

  storage: Object.freeze([
    storageSite(
      'registry.ts',
      'TOOL_REGISTRY',
      'Holds the ACTION and CLI-VERB declarations: every composite tool with its per-action ' +
        'contract and `cli` hints. Its own header names it "the DECLARATION AUTHORITY", which ' +
        'is exactly why a declaration consumer must not read it directly.',
    ),
    storageSite(
      'events/schemas.ts',
      'EVENT_EMISSION_REGISTRY',
      'Holds the EVENT declarations: the emission source of every registered event type, and ' +
        'the store `registerEventType` writes through (DR-1 task 008 lifts it into the envelope).',
    ),
  ]),

  // One reviewed entry per lift, as Wave 1a anticipated. STALE_SOURCE_ADAPTER
  // keeps an entry from outliving the lift it covers, so an exemption cannot
  // decay into cover for a violation.
  sourceAdapters: Object.freeze([
    {
      module: 'events/event-declarations.ts',
      note:
        'DR-1 task 008 — the EVENT declaration lift. Reads `EventTypes` + `EVENT_EMISSION_REGISTRY` ' +
        'out of `events/schemas.ts` and projects them into `Declaration<\'event\', …>`, which is ' +
        'the one job that necessarily names both sides of the seam. The exemption is narrow: this ' +
        'module exports no store handle and no write path, so consumers reach the catalog through ' +
        '`openEventDeclarationSeam` and never acquire a storage import of their own. #1258 replaces ' +
        'this module\'s `DeclarationSource` with an IR read and the exemption moves with it.',
    },
  ]),
});

/**
 * A module licensed to import an SDK package directly despite DR-26.
 *
 * There are none today — the list is EMPTY, and that is the deliverable: task
 * 053 migrated all 22 measured subjects rather than exempting any. The shape
 * exists so that a future exemption must be a dated, owned, expiring, reviewed
 * record instead of a quiet edit to the rule, and so {@link
 * SdkSeamBoundaryDiagnostic}'s stale/expired teeth have something to bite.
 */
export interface SdkSeamExemption {
  /** Scan-root-relative, forward-slashed module path. */
  readonly module: string;
  /** Who owns removing it. */
  readonly owner: string;
  /** ISO date (`YYYY-MM-DD`) after which the exemption is itself a failure. */
  readonly expires: string;
  /** Why this module cannot go through the seam yet. */
  readonly reason: string;
}

/** The declared shape of the SDK generation seam. */
export interface SdkSeamBoundaryRule {
  /** The one module licensed to import either generation. */
  readonly seamModule: string;
  /** Dated, owned, expiring bypass licences. Empty is the healthy state. */
  readonly exemptions: readonly SdkSeamExemption[];
}

/** One module's direct SDK imports, from its source alone. */
export interface SdkSeamUsage {
  /** Scan-root-relative, forward-slashed module path. */
  readonly module: string;
  /** True when this module IS {@link SdkSeamBoundaryRule.seamModule}. */
  readonly isSeam: boolean;
  /** Every SDK specifier the module imports, with its generation and line. */
  readonly imports: readonly {
    readonly specifier: string;
    readonly generation: SdkGeneration;
    readonly line: number;
  }[];
}

/** Everything the SDK-seam census needs, collected from one whole-tree walk. */
export interface SdkSeamBoundaryScan {
  /** Only modules that import an SDK package; the rest are irrelevant. */
  readonly usages: readonly SdkSeamUsage[];
  /** How many modules the walk VISITED — the population, not the hits. */
  readonly moduleCount: number;
  /** Whether {@link SdkSeamBoundaryRule.seamModule} exists under the scan root. */
  readonly seamModulePresent: boolean;
}

export type SdkSeamBoundaryDiagnostic =
  | {
      readonly code: 'DIRECT_SDK_IMPORT';
      readonly module: string;
      readonly specifier: string;
      readonly generation: SdkGeneration;
      readonly line: number;
      readonly message: string;
    }
  | {
      readonly code: 'EMPTY_SDK_SEAM_DENOMINATOR';
      readonly population: 'modules' | 'seam-imports';
      readonly message: string;
    }
  | {
      readonly code: 'SDK_SEAM_MODULE_ABSENT';
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_SDK_SEAM_EXEMPTION';
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly code: 'EXPIRED_SDK_SEAM_EXEMPTION';
      readonly module: string;
      readonly expires: string;
      readonly message: string;
    };

export interface SdkSeamBoundaryResult {
  readonly ok: boolean;
  /** Modules the walk visited. Zero is a failure, never a pass. */
  readonly moduleCount: number;
  /** SDK imports made from inside the seam. Zero is a failure, never a pass. */
  readonly seamImportCount: number;
  /** Modules importing the SDK directly and not exempt — the violation set. */
  readonly bypassModuleCount: number;
  readonly diagnostics: readonly SdkSeamBoundaryDiagnostic[];
}

/**
 * Classify one module's direct SDK imports. Pure, and parse-based via `parse`
 * so a specifier inside a comment, a string or a template literal is not an
 * import — it is absent from the syntax tree by construction rather than
 * filtered out afterwards.
 *
 * Returns `undefined` for a module importing no SDK package, which after the
 * migration is all but one of them.
 */
export function detectSdkSeamUsage(
  module: string,
  source: string,
  parse: SpecifierParser,
  rule: SdkSeamBoundaryRule = SDK_SEAM_BOUNDARY,
): SdkSeamUsage | undefined {
  const imports = collectSdkImports(source, parse, module);
  if (imports.length === 0) return undefined;
  const normalised = module.replaceAll('\\', '/');
  const isSeam =
    normalised === rule.seamModule || normalised.endsWith(`/${rule.seamModule}`);
  return Object.freeze({ module, isSeam, imports: Object.freeze(imports) });
}

/**
 * Pure SDK-seam verdict over an already-collected scan.
 *
 * `today` is injected rather than read from the clock so the expiry tooth is
 * testable without waiting for a date to pass — the same shape the wave's other
 * expiring allowlists use.
 */
export function runSdkSeamBoundaryCensus(
  scan: SdkSeamBoundaryScan,
  rule: SdkSeamBoundaryRule = SDK_SEAM_BOUNDARY,
  today: string = new Date().toISOString().slice(0, 10),
): SdkSeamBoundaryResult {
  const exempt = new Map<string, SdkSeamExemption>();
  for (const entry of rule.exemptions) exempt.set(entry.module, entry);

  const diagnostics: SdkSeamBoundaryDiagnostic[] = [];
  const seamImports = scan.usages
    .filter((usage) => usage.isSeam)
    .reduce((total, usage) => total + usage.imports.length, 0);

  const bypassModules: string[] = [];
  for (const usage of scan.usages) {
    if (usage.isSeam) continue;
    if (exempt.has(usage.module)) continue;
    bypassModules.push(usage.module);
    for (const imported of usage.imports) {
      diagnostics.push({
        code: 'DIRECT_SDK_IMPORT',
        module: usage.module,
        specifier: imported.specifier,
        generation: imported.generation,
        line: imported.line,
        message:
          `Direct MCP SDK import: "${usage.module}:${imported.line}" imports ` +
          `"${imported.specifier}" (generation ${imported.generation}). DR-26 makes ` +
          `"${rule.seamModule}" the SOLE importer of either generation, so this ` +
          `bypasses the seam: the value it yields carries no generation brand, and ` +
          `an unbranded value is admitted by either generation's position — which ` +
          `is how a cross-generation pair compiles clean and then exchanges no ` +
          `messages at runtime. Re-point the import at "${rule.seamModule}". If the ` +
          `seam does not re-export the surface you need, ADD it there; a surface ` +
          `the tree uses and the seam lacks is a seam with a hole, not a case for ` +
          `an exemption.`,
      });
    }
  }

  if (scan.moduleCount <= 0) {
    diagnostics.push({
      code: 'EMPTY_SDK_SEAM_DENOMINATOR',
      population: 'modules',
      message:
        'The SDK-seam rule visited ZERO modules, so "no direct imports" is true ' +
        'for a reason that has nothing to do with the tree — a moved scan root, a ' +
        'renamed package directory or a broken walker all present this way, and ' +
        'all three read as a fully migrated tree. Reported as a failure rather ' +
        'than a pass (DR-26 non-empty denominator).',
    });
  }

  if (scan.seamModulePresent && seamImports === 0) {
    diagnostics.push({
      code: 'EMPTY_SDK_SEAM_DENOMINATOR',
      population: 'seam-imports',
      message:
        `"${rule.seamModule}" exists but the scan resolved ZERO SDK imports inside ` +
        'it. Both generations are declared dependencies, so a seam drawing from ' +
        'neither brands nothing and every consumer of it is unprotected — and a ' +
        'specifier parser that has stopped matching presents exactly this way, ' +
        'while every bypass check below silently reports clean.',
    });
  }

  if (!scan.seamModulePresent) {
    diagnostics.push({
      code: 'SDK_SEAM_MODULE_ABSENT',
      module: rule.seamModule,
      message:
        `The owned SDK seam "${rule.seamModule}" is absent from the scanned tree. ` +
        'With no seam there is nothing for consumers to import through, so every ' +
        'module is a bypass by definition — restore it or repoint ' +
        'SDK_SEAM_BOUNDARY.seamModule.',
    });
  }

  for (const entry of rule.exemptions) {
    const usage = scan.usages.find((candidate) => candidate.module === entry.module);
    if (usage === undefined || usage.imports.length === 0) {
      diagnostics.push({
        code: 'STALE_SDK_SEAM_EXEMPTION',
        module: entry.module,
        message:
          `Declared SDK-seam exemption "${entry.module}" imports no SDK package — ` +
          'stale cover. An exemption nothing exercises is a hole waiting for a ' +
          'violation to fall through it. Remove it from SDK_SEAM_BOUNDARY.exemptions.',
      });
      continue;
    }
    if (entry.expires < today) {
      diagnostics.push({
        code: 'EXPIRED_SDK_SEAM_EXEMPTION',
        module: entry.module,
        expires: entry.expires,
        message:
          `SDK-seam exemption "${entry.module}" expired on ${entry.expires} (owner: ` +
          `${entry.owner}). Migrate the module onto "${rule.seamModule}" or record a ` +
          'new, reviewed expiry — an exemption without an end date is a permanent ' +
          'bypass wearing a deadline.',
      });
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    moduleCount: scan.moduleCount,
    seamImportCount: seamImports,
    bypassModuleCount: bypassModules.length,
    diagnostics,
  });
}

/** Module extensions an SDK import can hide in. */
const MODULE_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/**
 * Every module under `root`, EXCLUDING only what is not source at all.
 *
 * Deliberately NOT {@link collectScannableFiles}: that walk drops tests, evals
 * and `test-helpers`, which between them held 12 of the 22 modules DR-26
 * measured. See the section header for why a test's SDK import is in scope for
 * this rule and out of scope for the layering one.
 *
 * Exclusion is by PROPERTY, never by naming subtrees: `node_modules` and `dist`
 * are build/vendor output, and dot-directories are tooling state — which also
 * keeps a repo-root scan out of `.claude/worktrees/`, where sibling checkouts of
 * this same repository would otherwise be walked as if they were source.
 *
 * `.mjs`/`.js` are collected, not just `.ts`: the last live v1 import in the
 * repository sat in a `.mjs` test helper, invisible to a TypeScript-only walk.
 */
async function collectAllModuleFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        if (entry.name.startsWith('.')) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && MODULE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        files.push(join(dir, entry.name));
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** Walk `sourceRoot` and collect every module's direct SDK imports. */
export async function scanSdkSeamBoundary(
  sourceRoot: string,
  parse: SpecifierParser,
  rule: SdkSeamBoundaryRule = SDK_SEAM_BOUNDARY,
): Promise<SdkSeamBoundaryScan> {
  const files = await collectAllModuleFiles(sourceRoot);
  const usages: SdkSeamUsage[] = [];
  let seamModulePresent = false;

  for (const file of files) {
    const module = relative(sourceRoot, file).replaceAll('\\', '/');
    if (isOwnedSeamModule(module)) seamModulePresent = true;
    const usage = detectSdkSeamUsage(module, await readFile(file, 'utf8'), parse, rule);
    if (usage !== undefined) usages.push(usage);
  }

  return Object.freeze({
    usages: Object.freeze(usages),
    moduleCount: files.length,
    seamModulePresent,
  });
}

/** Scan the tree and return the SDK-seam verdict over it. */
export async function auditSdkSeamBoundary(
  sourceRoot: string,
  parse: SpecifierParser,
  rule: SdkSeamBoundaryRule = SDK_SEAM_BOUNDARY,
): Promise<SdkSeamBoundaryResult> {
  return runSdkSeamBoundaryCensus(await scanSdkSeamBoundary(sourceRoot, parse, rule), rule);
}

export const SDK_SEAM_BOUNDARY: SdkSeamBoundaryRule = Object.freeze({
  seamModule: SDK_SEAM_MODULE,

  // Task 053 migrated all 22 measured modules instead of licensing any of them,
  // and the production tree still licenses NONE. The three entries below are
  // process-level test harnesses that drive a real MCP server over stdio: they
  // need a real client, and the seam is a production module a root-package test
  // fixture must not reach into. They are recorded rather than hidden because the
  // alternative was the scan root itself — the audit used to run only at
  // `servers/exarchos-mcp/src`, so these modules were not exempt, they were
  // INVISIBLE, and the rule's "SOLE importer" claim was simply false outside the
  // subtree it measured. An exemption is a debt with an owner and a date; a narrow
  // scan root is a debt nobody can see.
  exemptions: Object.freeze([
    {
      module: 'test/fixtures/mcp-client.ts',
      owner: 'exarchos-core',
      expires: '2027-02-28',
      reason:
        'Root-package process fixture: spawns the shipped binary over stdio and drives it ' +
        'with a real client. Cannot route through the MCP package’s production seam without ' +
        'the root test tree importing server internals. Migrated v1 → v2 (DR-0/DR-26).',
    },
    {
      module: 'test/fixtures/__helpers__/mock-mcp-server.mjs',
      owner: 'exarchos-core',
      expires: '2027-02-28',
      reason:
        'The mock stdio SERVER the fixture above connects to; both ends must be the same ' +
        'generation or the pair hangs rather than erroring. Same rationale as its client.',
    },
    {
      module: 'servers/exarchos-mcp/test/process/_helpers.ts',
      owner: 'exarchos-core',
      expires: '2027-02-28',
      reason:
        'Packaged-binary process tests: exercise the real transport end-to-end, which is ' +
        'precisely what the seam abstracts away, so the seam cannot stand in for it here.',
    },
  ]),
});
