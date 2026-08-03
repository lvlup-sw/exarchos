import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { EXCLUDED_DIRS, isScannableFile, extractImportSpecifiers } from './effect-ledger.js';

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
 * comment/string-aware via {@link extractImportSpecifiers}. Intra-layer edges and
 * edges to a root-level file are excluded (see the scope note above).
 */
export function detectLayerEdges(module: string, source: string): LayerEdge[] {
  if (isRootFile(module)) return [];
  const sourceLayer = layerOf(module);
  const edges: LayerEdge[] = [];
  const seen = new Set<string>();
  for (const specifier of extractImportSpecifiers(source)) {
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
export async function scanLayerEdges(sourceRoot: string): Promise<readonly LayerEdge[]> {
  const files = await collectScannableFiles(sourceRoot);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const module = relative(sourceRoot, file).replaceAll('\\', '/');
      return detectLayerEdges(module, await readFile(file, 'utf8'));
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
  allowances: readonly LayerAllowance[] = LAYER_ALLOWED_IMPORTS,
): Promise<LayerBoundaryResult> {
  const edges = await scanLayerEdges(sourceRoot);
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
  allowance('topology', [], 'Foundation leaf — topology reads; imports no first-party directory.'),

  // ── peripheral layers: bounded, intentional dependency surfaces ────────────
  allowance('runtime', ['utils'], 'Runtime resource reads lean only on the utils foundation.'),
  allowance('onramp', ['utils'], 'Onboarding scaffold leans only on the utils foundation.'),
  allowance('pruner', ['topology'], 'Pruner safeguards read only the topology layer.'),
  allowance('hooks', ['config'], 'Hook wiring reads only config; hooks are an advisory side-channel.'),
  allowance('runbooks', ['adapters'], 'Runbooks render only through the adapters IO facade.'),
  allowance('task-store', ['event-store'], 'The task store persists only via the event store.'),
  allowance('stack', ['event-store', 'views'], 'Stack renders event-store state through views.'),
  allowance('cli', ['event-store', 'ndjson'], 'CLI surface reads event-store state and frames it as NDJSON.'),
  allowance(
    'workspace',
    ['capabilities', 'event-store', 'storage'],
    'Workspace resolves capabilities and persists via event-store/storage.',
  ),
  allowance(
    'agents',
    ['capabilities', 'utils', 'workflow'],
    'Agent definition loading resolves capabilities/workflow through the utils foundation.',
  ),
]);
