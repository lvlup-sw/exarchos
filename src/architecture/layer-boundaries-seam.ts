/**
 * Three import censuses over the shipped source.
 *
 * - Layering: each first-party import edge resolves to a source and a target
 *   layer. A governed layer that imports a layer outside its allowance fails as
 *   `FORBIDDEN_IMPORT`. An allowance that no edge uses fails as
 *   `STALE_LAYER_ALLOWANCE`. A layer without a row is ungoverned.
 * - Declaration seam: a module that imports the declaration contract must not
 *   also import a declaration store. See {@link DECLARATION_SEAM}.
 * - SDK seam: a module other than `contract/sdk/seam.ts` must not import an MCP
 *   SDK package, unless it has a dated exemption. See {@link SDK_SEAM_BOUNDARY}.
 *
 * The two seam rules are separate censuses, because a layer allowance is
 * unconditional and sees only first-party edges.
 */
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

/** A resolved first-party cross-directory import edge. */
export interface LayerEdge {
  /** Repo-relative-to-scan-root source module, forward-slashed. */
  readonly module: string;
  /** The importing module's layer (longest declared prefix, else first path segment or `<root>`). */
  readonly sourceLayer: string;
  /** The resolved target module, forward-slashed. */
  readonly targetModule: string;
  /** The target module's layer (longest declared prefix, else first path segment or `<root>`). */
  readonly targetLayer: string;
  /** The raw import specifier that produced the edge. */
  readonly specifier: string;
}

/** A declared allowance: `layer` can import only the layers in `allow`. */
export interface LayerAllowance {
  /** The governed source id (a first-level directory, a nested prefix, or `<root>`). */
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

/**
 * The layer of each root-level shipped file. Root files count like any other
 * layer, so the census can govern `registry.ts`. `<root>` cannot collide with a
 * directory name, because it is not a legal path segment on Windows.
 */
export const ROOT_LAYER = '<root>';

/**
 * Returns the layer of a module: the longest declared id that is a path prefix
 * of it, else the first path segment. With the longest match, a row can name a
 * nested layer such as `adapters/mcp`, so an edge between two nested siblings
 * is visible. A declared `utils` still owns all of `utils/`.
 */
export function layerOf(module: string, declaredIds: readonly string[] = []): string {
  let owner: string | undefined;
  for (const id of declaredIds) {
    if (module !== id && !module.startsWith(`${id}/`)) continue;
    if (owner === undefined || id.length > owner.length) owner = id;
  }
  if (owner !== undefined) return owner;
  const slash = module.indexOf('/');
  return slash === -1 ? ROOT_LAYER : module.slice(0, slash);
}

/** A root-level shipped file (no directory segment) — a shared-root surface. */
export function isRootFile(module: string): boolean {
  return !module.includes('/');
}

/** The declared layer ids of an allowance table, for {@link layerOf}. */
export function declaredLayerIds(
  allowances: readonly LayerAllowance[] = LAYER_ALLOWED_IMPORTS,
): readonly string[] {
  return allowances.map((a) => a.layer);
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
 * Lists the first-party cross-layer import edges of one module. The specifiers
 * come from the lexer port through {@link extractImportSpecifiers}, so a name in
 * prose is not an edge. It skips intra-layer edges. Type-only imports and
 * `import('…')` type queries are edges, because the question is layering, not
 * runtime effect.
 */
export function detectLayerEdges(
  module: string,
  source: string,
  lex: ModuleLexer,
  declaredIds: readonly string[] = [],
): LayerEdge[] {
  const sourceLayer = layerOf(module, declaredIds);
  const edges: LayerEdge[] = [];
  const seen = new Set<string>();
  for (const specifier of extractImportSpecifiers(source, lex)) {
    const targetModule = resolveTarget(module, specifier);
    if (targetModule === undefined) continue;
    const targetLayer = layerOf(targetModule, declaredIds);
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
  declaredIds: readonly string[] = [],
): Promise<readonly LayerEdge[]> {
  const files = await collectScannableFiles(sourceRoot);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const module = relative(sourceRoot, file).replaceAll('\\', '/');
      return detectLayerEdges(module, await readFile(file, 'utf8'), lex, declaredIds);
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

/**
 * Pure layering verdict over an edge set and an allowance set. It reports
 * `FORBIDDEN_IMPORT` for an edge from a governed layer to a layer that the row
 * does not allow. It reports `STALE_LAYER_ALLOWANCE` for an allowance that no
 * edge uses. It skips an edge from an ungoverned layer.
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
    if (allow === undefined) continue;
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

/**
 * Collects the live layer edges and returns the census verdict for the real
 * tree. The declared ids come from the table that the census judges with, so a
 * new nested row governs its layer at once.
 */
export async function auditLayerBoundaries(
  sourceRoot: string,
  lex: ModuleLexer,
  allowances: readonly LayerAllowance[] = LAYER_ALLOWED_IMPORTS,
): Promise<LayerBoundaryResult> {
  const edges = await scanLayerEdges(sourceRoot, lex, declaredLayerIds(allowances));
  return runLayerBoundaryCensus(edges, allowances);
}

/** Builds one {@link LayerAllowance}. */
const allowance = (layer: string, allow: readonly string[], note: string): LayerAllowance => ({
  layer,
  allow: Object.freeze([...allow]),
  note,
});

/**
 * The declared layering, one row for each governed layer. Each `allow` is the
 * exact measured outbound surface. Thus a new edge fails as `FORBIDDEN_IMPORT`,
 * and a removed edge fails as `STALE_LAYER_ALLOWANCE`. A wide row records how
 * coupled that layer is, and the census keeps it from growing.
 */
export const LAYER_ALLOWED_IMPORTS: readonly LayerAllowance[] = Object.freeze([
  allowance('utils', [], 'Foundation leaf — cross-OS/process/format primitives; imports no first-party directory.'),
  allowance('ndjson', [], 'Foundation leaf — NDJSON framing primitives; imports no first-party directory.'),

  /**
   * Layer L9 in `tools/audit/layer-map.json`. Cooperative agents drive worktrees
   * and launches, so the edges to verbs, workflow and events are intended.
   */
  allowance(
    'runtime',
    ['dispatch', 'events', 'storage', 'utils', 'verbs', 'workflow', ROOT_LAYER],
    'L9 cooperative agents — drives launches and worktrees through the dispatch core, the verb surface, the workflow primitives and the event store.',
  ),
  allowance('pruner', ['workflow'], 'Pruner safeguards read the topology contract, which task 013 folded into workflow/.'),
  allowance('hooks', ['config'], 'Hook wiring reads only config; hooks are an advisory side-channel.'),
  allowance(
    'runbooks',
    ['utils', ROOT_LAYER],
    'Runbooks render through a schema utility and the shared root surface. The edge to the adapters ' +
      'IO facade is gone — it existed only to reach a pure Zod-to-JSON-Schema converter that was ' +
      'filed under `adapters/` and is now a foundation leaf.',
  ),
  allowance(
    'projections',
    [
      'architecture', 'config', 'contract', 'describe',
      'dispatch', 'events', 'verbs', 'storage', 'utils', 'workflow',
      ROOT_LAYER,
    ],
    'The WIDEST allowance in this table, and deliberately so: task 012 folded ' +
      'views/, telemetry/, quality/, session/ and task-store/ into projections/, so this ' +
      'layer now carries the UNION of five directories\' import surfaces. Every edge here ' +
      'existed before the fold — `views/` has always called into the verb layer and workflow — ' +
      'but each was invisible to this census while the five had separate layer names and ' +
      'their couplings read as ordinary cross-layer traffic. Phase 1 is a pure move with ' +
      'zero semantic edits, so the surface is RECORDED here rather than narrowed. That the ' +
      'read side reaches the verb layer at all is the finding; acting on it is separate work, ' +
      'and this row is what keeps it measurable in the meantime.',
  ),
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
  allowance('review', [ROOT_LAYER, 'events', 'vcs', 'verbs'], 'Review reads event state and drives verbs through the VCS surface.'),
  allowance(
    'architecture',
    [ROOT_LAYER, 'config', 'contract', 'review', 'verbs'],
    'The censuses in this directory read the contract and the verb surface they audit.',
  ),
  allowance(
    'describe',
    [ROOT_LAYER, 'config', 'events', 'utils', 'workflow'],
    'Self-description renders the workflow + event vocabulary. Its edge to the adapters facade was ' +
      'only the schema converter, which is now a foundation leaf.',
  ),
  allowance(
    'install',
    ['contract', 'dispatch', 'runtime', 'storage', 'utils'],
    'Installer wiring; the ONLY governed layer with no root-surface edge, so a new one is a real change.',
  ),
  allowance(
    'storage',
    [ROOT_LAYER, 'events', 'projections', 'utils', 'workflow'],
    'Persistence reaches the event store and the projections it materialises.',
  ),
  allowance(
    'config',
    [ROOT_LAYER, 'events', 'projections', 'registry', 'utils', 'verbs', 'workflow'],
    'Config resolution reaches the verb surface — the narrowest row that is arguably inverted, and now visible. ' +
      'The `registry` edge is the action-contract declaration: `config/register.ts` stamps a contract onto an ' +
      'action through the declaration helpers, so it reaches the directory that OWNS the declaration rather ' +
      'than restating its shape.',
  ),
  allowance(
    'contract',
    [
      ROOT_LAYER, 'adapters/cli', 'architecture', 'describe', 'dispatch', 'events',
      'registry', 'runtime', 'utils', 'workflow',
    ],
    'The contract layer reaches its own generators and the dispatch core, plus the schema-conversion ' +
      'leaf every compiler stage uses. The adapters edge is the CLI presentation client ' +
      '(`cli-contract-seam` loads `adapters/cli`), not the IO facade parent. The `events` edge is ' +
      'the reachability census resolving its `event` hop: that census exists to read AUTHORITIES ' +
      'across the tree — it already reaches `architecture` for the effect ledger and `runtime` for ' +
      'the wiring — and the event catalog is one more. It is deliberately NOT resolved from the ' +
      'compiled contract, because a hop re-derived from the pass that supplies the denominator is ' +
      'tautological by construction; reaching the independently-authored table is what gives the ' +
      'hop teeth, and this row is the cost of that independence. `registry` is the same relationship ' +
      'one level down: an action contract is DECLARED once under `registry/` and the compiler stages ' +
      'here are projections of that declaration, so the edge points at the authority instead of ' +
      'copying it. `workflow` is the admission decision — the closure census asks whether an ActionId ' +
      'would be ADMITTED, and admission is the HSM\'s judgement to make, not a fact the contract layer ' +
      'may re-derive from its own compiled output.',
  ),
  allowance(
    'sync',
    [ROOT_LAYER, 'contract', 'dispatch', 'events', 'storage', 'utils'],
    'Marketplace/plugin sync over the contract and the event store.',
  ),
  allowance(
    'vcs',
    [ROOT_LAYER, 'config', 'dispatch', 'events', 'utils', 'workflow'],
    'VCS providers reach config, the dispatch core and the workflow primitives.',
  ),
  allowance(
    'lifecycle',
    ['config', 'events', 'ndjson', 'projections', 'runtime', 'utils', 'verbs'],
    'Process lifecycle; no root-surface edge, and frames output as NDJSON like the CLI does.',
  ),
  allowance(
    'mcp',
    ['cli', 'contract', 'dispatch', 'events', 'ndjson', 'projections', 'workflow'],
    'The MCP surface. Its edge to `cli` is the one worth watching: two sibling front-ends coupled directly.',
  ),
  allowance(
    ROOT_LAYER,
    [
      'adapters/cli', 'adapters/mcp', 'contract', 'dispatch', 'events', 'lifecycle',
      'projections', 'registry', 'storage', 'utils', 'verbs', 'workflow',
    ],
    'The shared-root surface itself. It was dominated by `registry.ts`, the largest module in the ' +
      'tree, and this row is what made decomposing it a MEASURABLE change: when the declarations ' +
      'moved into `registry/`, the `config` and `runtime` edges here went stale and had to be ' +
      'dropped, because the only root file drawing them was the one that moved. What is left is ' +
      'what the remaining root files genuinely draw, plus the single edge to `registry` itself.',
  ),
  allowance(
    'registry',
    [
      'config', 'contract', 'events', 'projections', 'runtime', 'verbs', 'workflow', ROOT_LAYER,
    ],
    'The tool-declaration authority, split out of the root surface. It is WIDE and cannot honestly ' +
      'be narrow: an action declares the schema of what it accepts, so the declarations reference ' +
      'schema shapes owned by nearly every layer they describe. The edges are references to ' +
      'SCHEMAS, not calls into behavior, which is the distinction that makes this width acceptable ' +
      'where the same set would be alarming on a layer that executes. Governed rather than left ' +
      'implicit so a declaration that starts importing a handler trips the row.',
  ),
  allowance(
    'adapters',
    ['events'],
    'The IO facade remainder after the nested cli/mcp rows took their own edges. What is left ' +
      'under this id is `adapters/channel/` — the transport — which reaches the delivery algebra ' +
      'and priority table the event core owns.',
  ),
  allowance(
    'adapters/mcp',
    [ROOT_LAYER, 'contract', 'dispatch', 'mcp', 'projections', 'registry', 'runtime'],
    'The MCP wire adapter. The `registry` edge appends the compact action contracts to the advertised ' +
      'tool schemas — the wire surface is a PROJECTION of the declarations, so it reads them from the ' +
      'directory that owns them. Empty of sibling-adapter targets: an edge to `adapters/cli` would make ' +
      'the wire contract depend on a presentation client, and is FORBIDDEN here, not merely unlisted ' +
      'on the parent row.',
  ),
  allowance(
    'adapters/cli',
    [
      ROOT_LAYER, 'adapters/mcp', 'cli', 'config', 'contract', 'dispatch',
      'events', 'lifecycle', 'ndjson', 'runtime', 'utils', 'workflow',
    ],
    'The CLI presentation client. The one nested-sibling edge the tree actually carries — ' +
      '`adapters/cli/cli.ts -> adapters/mcp/mcp.ts` — lives here, so the census can reject the ' +
      'reverse without a second scanner.',
  ),
  allowance(
    'events',
    [
      ROOT_LAYER, 'architecture', 'contract', 'describe',
      'dispatch', 'hooks', 'projections', 'storage', 'utils', 'verbs',
      'workflow',
    ],
    'The event store. That the WRITE side reaches the verb surface is still the finding — an event ' +
      'store is the one place a narrow surface should be achievable. The edge to the adapters ' +
      'facade is gone: the core reached into it for a delivery algebra and a priority table, both ' +
      'pure functions, which now sit under `events/channel/` where the core may own them.',
  ),
  allowance(
    'workflow',
    [
      ROOT_LAYER, 'config', 'contract', 'describe', 'dispatch',
      'events', 'projections', 'runtime', 'storage', 'utils', 'verbs',
    ],
    'The workflow HSM and its primitives, reaching nearly everything below it — but no longer the ' +
      'adapters IO facade, whose single edge was the schema converter now living under `utils/`.',
  ),
  allowance(
    'dispatch',
    [
      ROOT_LAYER, 'adapters', 'adapters/cli', 'config', 'contract', 'events', 'hooks',
      'install', 'projections', 'registry', 'review', 'runtime', 'storage', 'sync',
      'utils', 'vcs', 'verbs', 'workflow',
    ],
    'The dispatch core — 18 targets after the nested CLI adapter split out of the parent facade and the ' +
      'action contract took up residence under `registry/`, which dispatch reads to decide admission. ' +
      'It is the hub, so breadth is expected; the row exists so the breadth stops growing silently. ' +
      'The `utils` edge is the store-path resolver: the chokepoint refuses a mutation whose resolved ' +
      'event store diverges from the other surface\'s, and the resolution cascade it consults is a ' +
      'foundation leaf that imports no first-party directory. Every other core layer already reaches ' +
      'it; dispatch was the last one that did not, and this row records the edge rather than hiding ' +
      'it by rehoming path resolution somewhere it does not belong.',
  ),
  allowance(
    'verbs',
    [
      ROOT_LAYER, 'architecture', 'config', 'contract', 'describe',
      'dispatch', 'events', 'install', 'lifecycle', 'projections', 'pruner',
      'review', 'runbooks', 'runtime', 'storage', 'utils', 'vcs',
      'workflow',
    ],
    'The WIDEST row in the table at 18 targets, and the honest reading is that `verbs/` is coupled to ' +
      'nearly the whole tree. It is recorded rather than narrowed for the same reason `projections` ' +
      'is: Phase 1 moves code without changing meaning. The row buys the ratchet — target 19 has to ' +
      'be argued for — and it makes the number quotable, which is the first step to reducing it.',
  ),
]);

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
  /** The stores that a consumer must not import. */
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
 * Classifies how one module takes part in the declaration seam. It reads the
 * imports through {@link extractImportSpecifiers}, so a store named in prose is
 * not an import. It returns `undefined` for a module that touches neither side.
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
    const storageKey = `${target}\0${specifier}`;
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
 * Returns true when `source` still exports `symbol`. The match is anchored at
 * line start, so a mention in a comment cannot keep a moved store alive.
 */
export function exportsDeclarationSymbol(source: string, symbol: string): boolean {
  return new RegExp(String.raw`^export\s+(?:declare\s+)?(?:const|let|var|function|class)\s+${symbol}\b`, 'm').test(
    source,
  );
}

/**
 * Pure declaration-seam verdict over a scan. It reports:
 *
 * - `DIRECT_STORAGE_READ`: a consumer, other than a source adapter, imports a store.
 * - `EMPTY_SEAM_DENOMINATOR`: no module is a consumer, or no store is declared.
 * - `UNRESOLVED_DECLARATION_STORAGE`: a store is absent or does not export its symbol.
 * - `SEAM_ACCESSOR_MISSING`: the accessor is not in the tree.
 * - `STALE_SOURCE_ADAPTER`: a source adapter imports no store.
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

/** Builds one {@link DeclarationStorageSite}. */
const storageSite = (module: string, symbol: string, note: string): DeclarationStorageSite => ({
  module,
  symbol,
  note,
});

/**
 * The declaration seam. A module that imports a contract module is a consumer,
 * and a consumer must not import a store. A module that reads a store without
 * the contract is not a violation. A source adapter lifts a store into
 * declarations, so it can import both sides.
 */
export const DECLARATION_SEAM: DeclarationSeamRule = Object.freeze({
  accessor: 'contract/declaration-seam.ts',

  /**
   * An import of either module makes a consumer. The envelope counts too,
   * because a module typed on the envelope can fill it from a store and bypass
   * the accessor.
   */
  contractModules: Object.freeze(['contract/declaration.ts', 'contract/declaration-seam.ts']),

  storage: Object.freeze([
    storageSite(
      'registry/tools.ts',
      'TOOL_REGISTRY',
      'Holds the ACTION and CLI-VERB declarations: every composite tool with its per-action ' +
        'contract and `cli` hints. The registry directory names itself "the DECLARATION ' +
        'AUTHORITY", which is exactly why a declaration consumer must not read it directly. ' +
        'This names the module that ASSEMBLES the registry, not the `registry.ts` barrel ' +
        'consumers import: the barrel re-exports a star, so a name-based resolution check ' +
        'cannot see the symbol through it and would read clean against a store that had moved.',
    ),
    storageSite(
      'events/schemas.ts',
      'EVENT_EMISSION_REGISTRY',
      'Holds the EVENT declarations: the emission source of every registered event type, and ' +
        'the store `registerEventType` writes through (DR-1 task 008 lifts it into the envelope).',
    ),
  ]),

  /** One reviewed entry for each lift. `STALE_SOURCE_ADAPTER` fails an entry that imports no store. */
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
 * A dated, owned and expiring licence for a module to import an SDK package
 * directly. The census reports an expired licence, and a licence for a module
 * that imports no SDK package.
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
  /** The modules that import an SDK package. */
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
 * Classifies the direct SDK imports of one module. It reads the imports through
 * `parse`, so a specifier in a comment, string or template is not an import.
 * It returns `undefined` for a module that imports no SDK package.
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
 * Pure SDK-seam verdict over a scan. The caller can inject `today`, so a test
 * can check the expiry of an exemption without a real date.
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
 * Lists each module file under `root`, `.js` and `.mjs` included. It does not
 * use {@link collectScannableFiles}, because the SDK rule also covers tests,
 * evals and `test-helpers`. It skips `node_modules`, `dist` and dot-directories,
 * so a repo-root scan does not walk the sibling checkouts in `.claude/worktrees/`.
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

  /**
   * No production module has a licence. These entries are test harnesses that
   * drive a real MCP server over stdio, so they need a real client. A root test
   * fixture must not import the production seam.
   */
  exemptions: Object.freeze([
    {
      module: 'tests/helpers/mcp-client.ts',
      owner: 'exarchos-core',
      expires: '2027-02-28',
      reason:
        'Root-package process fixture: spawns the shipped binary over stdio and drives it ' +
        'with a real client. Cannot route through the MCP package’s production seam without ' +
        'the root test tree importing server internals. Migrated v1 → v2 (DR-0/DR-26).',
    },
    {
      module: 'tests/helpers/__helpers__/mock-mcp-server.mjs',
      owner: 'exarchos-core',
      expires: '2027-02-28',
      reason:
        'The mock stdio SERVER the fixture above connects to; both ends must be the same ' +
        'generation or the pair hangs rather than erroring. Same rationale as its client.',
    },
    {
      module: 'tests/core/process/_helpers.ts',
      owner: 'exarchos-core',
      expires: '2027-02-28',
      reason:
        'Packaged-binary process tests: exercise the real transport end-to-end, which is ' +
        'precisely what the seam abstracts away, so the seam cannot stand in for it here.',
    },
  ]),
});
