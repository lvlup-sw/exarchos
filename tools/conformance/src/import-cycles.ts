// Finds runtime import cycles in a dependency-cruiser JSON graph.
//
// dependency-cruiser is the acceptance instrument for the import surface, and it counts runtime
// edges only. With the default `tsPreCompilationDeps: false`, an `import type` is not an edge, and
// a dynamic `import()` is an edge. This module trusts that classification and adds Tarjan SCC.
//
// The detector takes the depcruise JSON text, not a live run, so a unit test needs no tool.
// It reports the first-party node count and fails closed on zero, because a scan that resolved
// nothing also reports no cycle. See `EmptyCycleGraphError`.

/** A dependency-cruiser dependency edge (the subset we consume). */
interface DepcruiseDependency {
  readonly resolved: string;
  readonly dependencyTypes?: readonly string[];
}

/** A dependency-cruiser module node (the subset we consume). */
interface DepcruiseModule {
  readonly source: string;
  readonly dependencies?: readonly DepcruiseDependency[];
}

/** The top-level dependency-cruiser JSON shape (the subset we consume). */
interface DepcruiseOutput {
  readonly modules?: readonly DepcruiseModule[];
}

/** A single runtime import edge. Paths are repo-relative, forward-slashed. */
export interface ImportEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * A detected runtime cycle: the strongly-connected component's member modules
 * plus the concrete intra-component edges that close the loop. A size-1 SCC
 * with a self-edge (a module importing itself) is also reported.
 */
export interface RuntimeCycle {
  readonly members: readonly string[];
  readonly edges: readonly ImportEdge[];
}

/** Canonical, order-stable key for an edge — used to match against the baseline. */
export function edgeKey(edge: ImportEdge): string {
  return `${edge.from} -> ${edge.to}`;
}

/** Normalize a depcruise path to forward slashes (Windows emits `\` in some setups). */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Returns a test for "inside `srcPrefix`", anchored on a path boundary.
 * A bare `startsWith('src')` also matches a sibling such as `src-legacy/`, which adds cycles from outside the tree.
 * Trailing separators are stripped, so both spellings of the prefix behave the same.
 */
function localToPrefix(srcPrefix: string): (candidate: string) => boolean {
  const prefix = toPosix(srcPrefix).replace(/\/+$/, '');
  return (candidate: string): boolean => {
    const p = toPosix(candidate);
    return p === prefix || p.startsWith(`${prefix}/`);
  };
}

/**
 * Builds the first-party runtime adjacency from a depcruise graph.
 * Nodes are the modules under `srcPrefix`. An edge stays when its target is under `srcPrefix` and it is not `type-only`.
 * With `tsPreCompilationDeps: false`, no edge is `type-only`. The filter keeps the result runtime-only if the config changes.
 */
function buildAdjacency(
  output: DepcruiseOutput,
  srcPrefix: string,
): Map<string, Set<string>> {
  const isLocal = localToPrefix(srcPrefix);
  const adj = new Map<string, Set<string>>();

  for (const mod of output.modules ?? []) {
    const from = toPosix(mod.source);
    if (!isLocal(from)) continue;
    if (!adj.has(from)) adj.set(from, new Set());
    for (const dep of mod.dependencies ?? []) {
      const to = toPosix(dep.resolved);
      if (!isLocal(to)) continue;
      if ((dep.dependencyTypes ?? []).includes('type-only')) continue;
      adj.get(from)!.add(to);
    }
  }
  return adj;
}

/**
 * Thrown when the graph resolves zero first-party nodes under `srcPrefix`.
 * A prefix that matches nothing gives an empty cycle list, the same value as a clean tree.
 * A moved tree, a renamed directory, a wrong depcruise scope, or a leading `./` can cause it.
 * The phantom check of the baseline does not cover this case, because it reads only baselined entries.
 */
export class EmptyCycleGraphError extends Error {
  constructor(
    readonly srcPrefix: string,
    readonly totalModules: number,
  ) {
    super(
      `No first-party module resolved under "${srcPrefix}" (the graph reported ` +
        `${totalModules} module(s) in total). An empty node set yields an empty cycle ` +
        'list, which is indistinguishable from an acyclic tree — so this fails closed ' +
        'rather than reporting a clean surface. The source root moved, the prefix is ' +
        'wrong, or depcruise was pointed somewhere else.',
    );
    this.name = 'EmptyCycleGraphError';
  }
}

/** A completed graph scan: the cycles, and the population they were found in. */
export interface RuntimeCycleScan {
  readonly cycles: readonly RuntimeCycle[];
  /** First-party modules resolved under `srcPrefix` — the denominator. */
  readonly nodeCount: number;
  /** First-party runtime edges between them. */
  readonly edgeCount: number;
}

/**
 * Detects the runtime import cycles in a dependency-cruiser JSON graph, and reports the population of the scan.
 * This function returns the counts because downstream, an empty cycle array does not show a scan with no nodes.
 *
 * @throws {EmptyCycleGraphError} when no first-party node resolves.
 */
export function scanRuntimeCycleGraph(
  depcruiseJson: string,
  srcPrefix = 'servers/exarchos-mcp/src',
): RuntimeCycleScan {
  const output = JSON.parse(depcruiseJson) as DepcruiseOutput;
  const adj = buildAdjacency(output, srcPrefix);
  if (adj.size === 0) {
    throw new EmptyCycleGraphError(srcPrefix, (output.modules ?? []).length);
  }
  let edgeCount = 0;
  for (const targets of adj.values()) edgeCount += targets.size;
  return {
    cycles: detectCyclesIn(adj),
    nodeCount: adj.size,
    edgeCount,
  };
}

/**
 * Detects every runtime import cycle in a dependency-cruiser JSON graph.
 *
 * @param depcruiseJson The raw `depcruise --output-type json` stdout.
 * @param srcPrefix     Repo-relative source root (default: `src`).
 * @returns One {@link RuntimeCycle} per strongly-connected component with a
 *   cycle (SCCs of size > 1, plus self-loops). Empty when the graph is acyclic.
 * @throws {EmptyCycleGraphError} when no first-party node resolves under `srcPrefix`.
 */
export function detectRuntimeCycles(
  depcruiseJson: string,
  srcPrefix = 'src',
): RuntimeCycle[] {
  return [...scanRuntimeCycleGraph(depcruiseJson, srcPrefix).cycles];
}

/** Tarjan SCC over a built first-party adjacency. The recursion is safe, because the module graph is far less deep than the stack limit. */
function detectCyclesIn(adj: Map<string, Set<string>>): RuntimeCycle[] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const strongconnect = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      components.push(comp);
    }
  };

  for (const v of adj.keys()) {
    if (!idx.has(v)) strongconnect(v);
  }

  const cycles: RuntimeCycle[] = [];
  for (const comp of components) {
    const first = comp[0];
    const isSelfLoop =
      comp.length === 1 && first !== undefined && (adj.get(first)?.has(first) ?? false);
    if (comp.length < 2 && !isSelfLoop) continue;
    const members = new Set(comp);
    const edges: ImportEdge[] = [];
    for (const from of comp) {
      for (const to of adj.get(from) ?? []) {
        if (members.has(to)) edges.push({ from, to });
      }
    }
    cycles.push({ members: comp.slice().sort(), edges });
  }
  return cycles;
}

/**
 * Whether a specific runtime edge `from -> to` exists in the depcruise graph.
 * A test uses it to pin one seam, for example "the projection must NOT import the store".
 * Paths are matched repo-relative and forward-slashed.
 */
export function runtimeEdgeExists(
  depcruiseJson: string,
  from: string,
  to: string,
  srcPrefix = 'src',
): boolean {
  const output = JSON.parse(depcruiseJson) as DepcruiseOutput;
  const adj = buildAdjacency(output, srcPrefix);
  return adj.get(toPosix(from))?.has(toPosix(to)) ?? false;
}

/** A baselined (accepted, tracked) runtime cycle edge. */
export interface CycleBaselineEntry {
  /** The depcruise rule that flagged the edge (for example `no-circular`). */
  readonly rule: string;
  /** Repo-relative source of the back-edge. */
  readonly from: string;
  /** Repo-relative target of the back-edge. */
  readonly to: string;
  /** Owning team/person accountable for retiring the edge. */
  readonly owner: string;
  /** Why the edge is tolerated for now. */
  readonly rationale: string;
  /** Tracking issue for the fix. */
  readonly issue: string;
  /**
   * ISO date the waiver lapses, XOR `permanent`.
   * The type includes `undefined`, because `cycle-gate.ts` passes entries from `z.infer`.
   * Under `exactOptionalPropertyTypes`, those `.optional()` fields are `T | undefined`.
   */
  readonly expires?: string | undefined;
  /** `true` when the edge is an accepted permanent exception (no expiry). */
  readonly permanent?: boolean | undefined;
}

/** The `cycle-baseline.json` document shape. */
export interface CycleBaseline {
  readonly entries: readonly CycleBaselineEntry[];
}

/** The set of baselined edge keys, for O(1) membership tests. */
export function baselineEdgeKeys(baseline: CycleBaseline): Set<string> {
  return new Set(
    baseline.entries.map((e) => edgeKey({ from: toPosix(e.from), to: toPosix(e.to) })),
  );
}

/**
 * The cycle edges NOT covered by the baseline — the acceptance signal. Zero
 * means every detected runtime cycle is acknowledged in `cycle-baseline.json`.
 */
export function unbaselinedCycleEdges(
  cycles: readonly RuntimeCycle[],
  baseline: CycleBaseline,
): ImportEdge[] {
  const allowed = baselineEdgeKeys(baseline);
  const out: ImportEdge[] = [];
  for (const cycle of cycles) {
    for (const edge of cycle.edges) {
      if (!allowed.has(edgeKey(edge))) out.push(edge);
    }
  }
  return out;
}

/** The set of edge keys exercised by the currently-detected runtime cycles. */
function liveCycleEdgeKeys(cycles: readonly RuntimeCycle[]): Set<string> {
  const live = new Set<string>();
  for (const cycle of cycles) {
    for (const edge of cycle.edges) live.add(edgeKey(edge));
  }
  return live;
}

/**
 * Returns the phantom baseline entries: those whose `from -> to` edge matches no live runtime cycle edge.
 * This is the partner of {@link unbaselinedCycleEdges}. A phantom entry pre-authorizes a future cycle on
 * that edge, so the gate fails on it.
 */
export function phantomBaselineEntries(
  cycles: readonly RuntimeCycle[],
  baseline: CycleBaseline,
): CycleBaselineEntry[] {
  const live = liveCycleEdgeKeys(cycles);
  return baseline.entries.filter(
    (entry) => !live.has(edgeKey({ from: toPosix(entry.from), to: toPosix(entry.to) })),
  );
}

/**
 * A declared runtime edge that must never exist, because it closes a cycle.
 * The baseline accepts existing cycles. These rules stop specific back-edges from forming.
 */
export interface ForbiddenEdgeRule {
  /** Source module (scan-root-relative, forward-slashed, matching `srcPrefix`). */
  readonly from: string;
  /** Target module the source must not runtime-import. */
  readonly to: string;
  /** Why this seam must stay one-way. Usually the edge re-forms a cycle. */
  readonly reason: string;
}

export type ForbiddenEdgeDiagnostic =
  | {
      readonly code: 'FORBIDDEN_RUNTIME_EDGE';
      readonly from: string;
      readonly to: string;
      readonly reason: string;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_FORBIDDEN_EDGE';
      readonly from: string;
      readonly to: string;
      readonly missing: 'from' | 'to' | 'both';
      readonly message: string;
    };

export interface ForbiddenEdgeResult {
  readonly ok: boolean;
  readonly diagnostics: readonly ForbiddenEdgeDiagnostic[];
}

/** Collect the first-party module nodes present in an already-parsed graph. */
function nodesFromOutput(output: DepcruiseOutput, srcPrefix: string): Set<string> {
  const isLocal = localToPrefix(srcPrefix);
  const nodes = new Set<string>();
  for (const mod of output.modules ?? []) {
    const from = toPosix(mod.source);
    if (isLocal(from)) nodes.add(from);
    for (const dep of mod.dependencies ?? []) {
      const to = toPosix(dep.resolved);
      if (isLocal(to)) nodes.add(to);
    }
  }
  return nodes;
}

/**
 * Returns the first-party module paths in the graph, as an import source or a resolved local target.
 * A forbidden-edge rule whose endpoints are absent is phantom cover.
 */
export function firstPartyModules(
  depcruiseJson: string,
  srcPrefix = 'src',
): Set<string> {
  return nodesFromOutput(JSON.parse(depcruiseJson) as DepcruiseOutput, srcPrefix);
}

/**
 * Returns the two-way forbidden-edge verdict over a depcruise graph.
 * `FORBIDDEN_RUNTIME_EDGE` marks a declared forbidden edge that exists.
 * `STALE_FORBIDDEN_EDGE` marks a rule whose `from` or `to` is not a graph node, so the rule protects nothing.
 */
export function runForbiddenEdgeCensus(
  depcruiseJson: string,
  rules: readonly ForbiddenEdgeRule[] = FORBIDDEN_RUNTIME_EDGES,
  srcPrefix = 'src',
): ForbiddenEdgeResult {
  const output = JSON.parse(depcruiseJson) as DepcruiseOutput;
  const adj = buildAdjacency(output, srcPrefix);
  const nodes = nodesFromOutput(output, srcPrefix);
  const diagnostics: ForbiddenEdgeDiagnostic[] = [];

  for (const rule of rules) {
    const from = toPosix(rule.from);
    const to = toPosix(rule.to);
    const fromPresent = nodes.has(from);
    const toPresent = nodes.has(to);
    if (!fromPresent || !toPresent) {
      const missing: 'from' | 'to' | 'both' =
        !fromPresent && !toPresent ? 'both' : !fromPresent ? 'from' : 'to';
      diagnostics.push({
        code: 'STALE_FORBIDDEN_EDGE',
        from: rule.from,
        to: rule.to,
        missing,
        message:
          `Forbidden-edge rule ${rule.from} -> ${rule.to} names a module absent from the ` +
          `graph (${missing}) — stale cover. Update FORBIDDEN_RUNTIME_EDGES to the module's ` +
          `new path or remove the rule.`,
      });
      continue;
    }
    if (adj.get(from)?.has(to) ?? false) {
      diagnostics.push({
        code: 'FORBIDDEN_RUNTIME_EDGE',
        from: rule.from,
        to: rule.to,
        reason: rule.reason,
        message:
          `Forbidden runtime import ${rule.from} -> ${rule.to}: ${rule.reason} Break the edge ` +
          `(extract the shared leaf both sides can import) rather than re-forming the cycle.`,
      });
    }
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

/**
 * The declared cycle-closing back-edges. Each `from` must NOT runtime-import its
 * `to`. Paths use the package-root-relative `src/…` convention the co-located
 * gate runs depcruise under (so callers pass `srcPrefix = 'src'`).
 */
export const FORBIDDEN_RUNTIME_EDGES: readonly ForbiddenEdgeRule[] = Object.freeze([
  {
    from: 'src/projections/views/workflow-state-projection.ts',
    to: 'src/workflow/state-store.ts',
    reason:
      'The store value-imports the projection (folds events through its apply), so a ' +
      'projection→store runtime edge re-forms the mutual cycle; import the shared helpers ' +
      'from workflow/state-mutation.ts instead (DR-4).',
  },
]);
