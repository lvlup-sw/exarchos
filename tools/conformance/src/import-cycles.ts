// ─── Runtime Import-Cycle Detection (DR-4, debloat task 009) ─────────────────
//
// Pure graph analysis over a dependency-cruiser JSON graph. dependency-cruiser
// is the SOLE acceptance instrument for the import surface: it counts RUNTIME
// edges only. With the repo config's default `tsPreCompilationDeps: false`, the
// TypeScript emit ELIDES `import type` statements, so they never appear as
// edges (type-only excluded); dynamic `import()` survives compilation and IS
// counted. This module treats depcruise's edge classification as ground truth
// and adds only the graph theory (Tarjan SCC) needed to name the cycles.
//
// The detector is deliberately pure — it takes the depcruise JSON *text*, not a
// live depcruise run — so it is unit-testable without shelling the tool. The
// co-located test shells the real depcruise and feeds the output here.

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
 * Build the first-party runtime adjacency from a depcruise graph.
 *
 * - Only modules whose `source` is under `srcPrefix` are nodes (first-party).
 * - An edge is kept only when its `resolved` target is also under `srcPrefix`
 *   AND the edge is not tagged `type-only`. The `type-only` guard is defensive:
 *   with `tsPreCompilationDeps: false` such edges are already absent, but the
 *   filter keeps the runtime-only semantics explicit and robust to config drift.
 */
function buildAdjacency(
  output: DepcruiseOutput,
  srcPrefix: string,
): Map<string, Set<string>> {
  const prefix = toPosix(srcPrefix);
  const isLocal = (s: string): boolean => toPosix(s).startsWith(prefix);
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
 * Detect every runtime import cycle in a dependency-cruiser JSON graph.
 *
 * @param depcruiseJson The raw `depcruise --output-type json` stdout.
 * @param srcPrefix     Repo-relative source root (default: the MCP server src).
 * @returns One {@link RuntimeCycle} per strongly-connected component with a
 *   cycle (SCCs of size > 1, plus self-loops). Empty when the graph is acyclic.
 */
export function detectRuntimeCycles(
  depcruiseJson: string,
  srcPrefix = 'servers/exarchos-mcp/src',
): RuntimeCycle[] {
  const output = JSON.parse(depcruiseJson) as DepcruiseOutput;
  const adj = buildAdjacency(output, srcPrefix);

  // Tarjan's strongly-connected-components algorithm (iterative-safe recursion
  // is fine here: the module graph depth is well under the stack limit).
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
 * Used to pin a single seam (e.g. "the projection must NOT import the store").
 * Paths are matched repo-relative and forward-slashed.
 */
export function runtimeEdgeExists(
  depcruiseJson: string,
  from: string,
  to: string,
  srcPrefix = 'servers/exarchos-mcp/src',
): boolean {
  const output = JSON.parse(depcruiseJson) as DepcruiseOutput;
  const adj = buildAdjacency(output, srcPrefix);
  return adj.get(toPosix(from))?.has(toPosix(to)) ?? false;
}

/**
 * A baselined (accepted, tracked) runtime cycle edge. Task 010 finalizes this
 * shape and its validating schema; the fields here are the DRAFT contract.
 */
export interface CycleBaselineEntry {
  /** The depcruise rule that flagged the edge (e.g. `no-circular`). */
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
   *
   * `| undefined` deliberately: `cycle-gate.ts` feeds this interface entries
   * produced by `z.infer`, whose `.optional()` fields are `T | undefined` under
   * `exactOptionalPropertyTypes`. `cycle-gate.ts`'s own header already claimed
   * its validated entry type "flows unchanged" into these helpers — a claim no
   * typechecker had ever read, because `scripts/` was compiled by nothing until
   * task 066. It does now.
   */
  readonly expires?: string | undefined;
  /** `true` when the edge is an accepted permanent exception (no expiry). */
  readonly permanent?: boolean | undefined;
}

/** The `cycle-baseline.json` document shape (DRAFT — task 010 finalizes). */
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
 * PHANTOM baseline entries: the ones whose `from -> to` edge matches NO current
 * runtime cycle edge. The symmetric partner to {@link unbaselinedCycleEdges}, and
 * the sharpest tooth of the ratchet (DR-4 no-mask): a baselined edge that no live
 * cycle exercises is stale cover — it silently pre-authorizes a future cycle on
 * that exact seam, so the gate must fail on it rather than let it linger. (Unlike
 * knip's `stale`, which is a mere hygiene warning, a phantom cycle-baseline entry
 * is a hard failure.)
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

// ─── Forbidden Runtime Back-Edge Registry (P07-06) ───────────────────────────
//
// The baseline machinery above ACCEPTS existing cycles; this registry PREVENTS
// specific cycle-closing back-edges from ever forming. The debloat gate already
// pins one such seam by hand in the co-located test (the projection MUST NOT
// runtime-import the store, or the mutual cycle re-forms). P07-06 generalizes
// that ad-hoc pin into a declared, ratcheted set so new forbidden seams are a
// one-line entry rather than a bespoke test — extending the detector's
// *enforcement*, not just its detection. Like every gate on this ladder it is a
// two-way ratchet: a present forbidden edge fails, AND a rule whose endpoints are
// not both real modules in the graph fails as stale cover (a phantom guard could
// silently pass while the module it names was renamed away).

/** A declared runtime edge that must never exist (a cycle-closing back-edge). */
export interface ForbiddenEdgeRule {
  /** Source module (scan-root-relative, forward-slashed, matching `srcPrefix`). */
  readonly from: string;
  /** Target module the source must not runtime-import. */
  readonly to: string;
  /** Why this seam must stay one-way (usually: it would re-form a cycle). */
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
  const prefix = toPosix(srcPrefix);
  const isLocal = (s: string): boolean => toPosix(s).startsWith(prefix);
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
 * The set of first-party module paths present in the graph — as an import source
 * OR a resolved local target. Used to validate that a forbidden-edge rule names
 * real modules; a rule whose endpoints are absent is phantom cover.
 */
export function firstPartyModules(
  depcruiseJson: string,
  srcPrefix = 'servers/exarchos-mcp/src',
): Set<string> {
  return nodesFromOutput(JSON.parse(depcruiseJson) as DepcruiseOutput, srcPrefix);
}

/**
 * The two-way forbidden-edge verdict over a depcruise graph:
 *   - FORBIDDEN_RUNTIME_EDGE — a declared forbidden edge that actually exists;
 *   - STALE_FORBIDDEN_EDGE   — a rule whose `from`/`to` is not a real graph node
 *                              (phantom guard), so the pin protects nothing.
 */
export function runForbiddenEdgeCensus(
  depcruiseJson: string,
  rules: readonly ForbiddenEdgeRule[] = FORBIDDEN_RUNTIME_EDGES,
  srcPrefix = 'servers/exarchos-mcp/src',
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
