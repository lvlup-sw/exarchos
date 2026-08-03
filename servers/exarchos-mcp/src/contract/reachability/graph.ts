// ─── Generated reachability graph — the closure model (P05-05) ───────────────
//
// PROGRAM-05, the CLOSURE CAPSTONE (CTR-013). Program objective: every public
// action reaches ONE implementation, ONE owned effect path where applicable, ONE
// output contract, and ONE packaged proof. This module is the pure model that
// proves it: it assembles the reachability graph from the upstream authorities'
// projections and evaluates CLOSURE — every public action must have exactly ONE
// complete path from authored ActionId all the way to its packaged fixture.
//
// ── The node chain (one path per public action) ──────────────────────────────
//
//   ActionId  →  schema  →  route  →  handler  →  [owner]  →  output  →  artifact  →  fixture
//   (authored)  (P03-03)   (P03-04)  (P03-04)   (P04-01)   (P03-02)   (P03-03)    (packaged)
//
//   • schema   — the compiled contract carries the action's descriptor + I/O schema.
//   • route    — the generated MCP registration routes the ActionId to its tool
//                (the dispatch route).
//   • handler  — exactly one non-serializable implementation binding serves the
//                tool (the ActionId→handler hop).
//   • owner    — CONDITIONAL ("where applicable"): a MUTATING action's effect
//                path resolves to exactly one effect owner (via the provider map,
//                backed by the P04-01 ledger). A pure action skips this hop.
//   • output   — the action binds a non-empty output-kind + error-family contract
//                (the P03-02 total output surface).
//   • artifact — the compiler emits the action's in-memory proof fixture.
//   • fixture  — the action's fixture is present in the checked-in / packaged
//                proof-fixture baseline (the packaged proof).
//
// A break at ANY applicable hop — or AMBIGUITY (two handlers, two owners) at one
// — is a closure failure that names the action and the broken hop. The pure core
// here takes fully-materialized inputs so every one of the five seeded break
// classes (missing route / handler / owner / output / fixture) and ambiguity is
// unit-testable with no filesystem. The impure `collect.ts` assembles the real
// inputs from the live authorities.
//
// ── The authored-workflow seam (P07-02) ──────────────────────────────────────
// The chain's origin is the authored ActionId (authored in the tool registry).
// Binding each ActionId to a specific shared-IR built-in workflow definition is
// the P07-02 surface, which is authored in parallel; that refinement is a
// PLUGGABLE origin attribute, not a required hop here (see `collect.ts`).
// ────────────────────────────────────────────────────────────────────────────

import { digestText } from '../authority-digest.js';
import { canonicalJson } from '../request-context.js';

// ─── Hops ────────────────────────────────────────────────────────────────────

/** The ordered reachability hops from authored ActionId to packaged fixture. */
export const REACHABILITY_HOPS = [
  'schema',
  'route',
  'handler',
  'owner',
  'output',
  'artifact',
  'fixture',
] as const;
export type ReachabilityHop = (typeof REACHABILITY_HOPS)[number];

/** Resolution status of one hop for one action. */
export type HopStatus = 'ok' | 'missing' | 'ambiguous' | 'not-applicable';

// ─── Graph inputs (materialized projections of the upstream authorities) ─────

/** An authored public action — the graph's origin node. */
export interface ActionNode {
  readonly actionId: string;
  readonly tool: string;
  readonly action: string;
  /** True when the action's effect policy mutates — the `owner` hop applies. */
  readonly mutates: boolean;
}

/** The compiled action carries a descriptor + input/output schema (P03-03). */
export interface SchemaEntry {
  readonly actionId: string;
}

/** The registration routes the ActionId to a tool (the dispatch route, P03-04). */
export interface RouteEntry {
  readonly actionId: string;
  readonly tool: string;
}

/** A tool bound to exactly one implementation handler (P03-04). */
export interface HandlerEntry {
  readonly tool: string;
}

/** A tool's effect path resolved to one effect owner (P04-01 via the provider map). */
export interface OwnerEntry {
  readonly tool: string;
  readonly owner: string;
}

/** The action's output contract: bound output kinds + error families (P03-02). */
export interface OutputEntry {
  readonly actionId: string;
  readonly outputKinds: readonly string[];
  readonly errorCodes: readonly string[];
}

/** The compiler emitted an in-memory proof fixture for the action (P03-03). */
export interface ArtifactEntry {
  readonly actionId: string;
}

/** The action's fixture is present in the checked-in / packaged baseline. */
export interface FixtureEntry {
  readonly actionId: string;
}

/**
 * A governed known-unclosed action + hop, with a human reason. An action listed
 * here is expected to fail closure at that hop and is NOT counted as a closure
 * failure — but a listed action that is actually CLOSED is a STALE exception
 * (the same two-way ratchet as the census pattern). The live tree carries an
 * EMPTY list; entries are added only with a conscious, reviewed reason.
 */
export interface ClosureException {
  readonly actionId: string;
  readonly hop: ReachabilityHop;
  readonly reason: string;
}

/** The fully-materialized graph inputs the pure core consumes. */
export interface ReachabilityInputs {
  readonly surfaceVersion: string;
  readonly actions: readonly ActionNode[];
  readonly schemas: readonly SchemaEntry[];
  readonly routes: readonly RouteEntry[];
  readonly handlers: readonly HandlerEntry[];
  readonly owners: readonly OwnerEntry[];
  readonly outputs: readonly OutputEntry[];
  readonly artifacts: readonly ArtifactEntry[];
  readonly fixtures: readonly FixtureEntry[];
  /** Governed known-unclosed exceptions (empty in a fully-closed tree). */
  readonly exceptions?: readonly ClosureException[];
}

// ─── Hop resolution ──────────────────────────────────────────────────────────

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One hop's resolution for one action. */
export interface HopResolution {
  readonly hop: ReachabilityHop;
  readonly applicable: boolean;
  readonly resolverCount: number;
  readonly status: HopStatus;
}

function statusFor(applicable: boolean, count: number): HopStatus {
  if (!applicable) return 'not-applicable';
  if (count === 0) return 'missing';
  if (count > 1) return 'ambiguous';
  return 'ok';
}

/**
 * Count the resolvers each hop offers this action, in the fixed hop order. The
 * `owner` hop is APPLICABLE only for a mutating action ("one owned effect path
 * where applicable"); every other hop is always applicable. `handler` and
 * `owner` resolve by the action's tool, so a duplicate binding/provider for that
 * tool surfaces as `ambiguous` (count > 1), not just absence.
 */
export function resolveHops(action: ActionNode, inputs: ReachabilityInputs): readonly HopResolution[] {
  const schemaCount = inputs.schemas.filter((s) => s.actionId === action.actionId).length;
  const routeCount = inputs.routes.filter((r) => r.actionId === action.actionId).length;
  const handlerCount = inputs.handlers.filter((h) => h.tool === action.tool).length;
  const ownerCount = inputs.owners.filter((o) => o.tool === action.tool).length;
  const outputCount = inputs.outputs.filter(
    (o) => o.actionId === action.actionId && o.outputKinds.length > 0 && o.errorCodes.length > 0,
  ).length;
  const artifactCount = inputs.artifacts.filter((a) => a.actionId === action.actionId).length;
  const fixtureCount = inputs.fixtures.filter((f) => f.actionId === action.actionId).length;

  const counts: Record<ReachabilityHop, { applicable: boolean; count: number }> = {
    schema: { applicable: true, count: schemaCount },
    route: { applicable: true, count: routeCount },
    handler: { applicable: true, count: handlerCount },
    owner: { applicable: action.mutates, count: ownerCount },
    output: { applicable: true, count: outputCount },
    artifact: { applicable: true, count: artifactCount },
    fixture: { applicable: true, count: fixtureCount },
  };

  return REACHABILITY_HOPS.map((hop): HopResolution => {
    const { applicable, count } = counts[hop];
    return { hop, applicable, resolverCount: count, status: statusFor(applicable, count) };
  });
}

// ─── Closure evaluation ──────────────────────────────────────────────────────

/** The per-action closure verdict: is there exactly one complete path? */
export interface ActionClosure {
  readonly actionId: string;
  readonly tool: string;
  readonly mutates: boolean;
  readonly closed: boolean;
  readonly hops: readonly HopResolution[];
}

/** A closure failure that names the action and the broken hop. */
export interface ClosureDiagnostic {
  readonly actionId: string;
  readonly hop: ReachabilityHop;
  readonly kind: 'missing' | 'ambiguous' | 'stale-exception';
  readonly message: string;
}

export interface ClosureReport {
  readonly ok: boolean;
  readonly totalActions: number;
  readonly closedActions: number;
  readonly actions: readonly ActionClosure[];
  readonly diagnostics: readonly ClosureDiagnostic[];
  /** The governed exceptions honoured (a listed action that genuinely broke). */
  readonly honouredExceptions: readonly ClosureException[];
}

function diagnosticMessage(action: ActionNode, res: HopResolution): string {
  const target =
    res.hop === 'handler' || res.hop === 'owner' ? `tool '${action.tool}'` : `ActionId '${action.actionId}'`;
  if (res.status === 'missing') {
    return `ActionId '${action.actionId}' has no ${res.hop} — the reachability path breaks at the ${res.hop} hop (${target} resolves to 0)`;
  }
  return `ActionId '${action.actionId}' has ${res.resolverCount} ${res.hop} resolvers — the ${res.hop} hop is AMBIGUOUS (${target}); exactly one complete path is required`;
}

/**
 * Evaluate closure over the materialized inputs. Pure and total: every public
 * action is resolved along every applicable hop; an action is CLOSED iff every
 * applicable hop resolves to exactly one. A `missing`/`ambiguous` hop yields a
 * diagnostic naming the action and the broken hop.
 *
 * Governed exceptions cut both ways (census two-way ratchet): a listed
 * `(actionId, hop)` that genuinely breaks is HONOURED (not a failure, not a
 * diagnostic); a listed pair that is actually OK is a `stale-exception`
 * diagnostic — remove it. `ok === true` is the closure green light.
 */
export function evaluateClosure(inputs: ReachabilityInputs): ClosureReport {
  const exceptions = inputs.exceptions ?? [];
  const exceptionKey = (actionId: string, hop: ReachabilityHop): string => `${actionId}\u0000${hop}`;
  const exceptionByKey = new Map<string, ClosureException>();
  for (const exc of exceptions) exceptionByKey.set(exceptionKey(exc.actionId, exc.hop), exc);
  const usedExceptions = new Set<string>();

  const diagnostics: ClosureDiagnostic[] = [];
  const actions: ActionClosure[] = [];

  const sortedActions = [...inputs.actions].sort((a, b) => byString(a.actionId, b.actionId));
  for (const action of sortedActions) {
    const hops = resolveHops(action, inputs);
    let closed = true;
    for (const res of hops) {
      if (res.status === 'ok' || res.status === 'not-applicable') continue;
      const key = exceptionKey(action.actionId, res.hop);
      const excepted = exceptionByKey.get(key);
      if (excepted) {
        usedExceptions.add(key);
        continue; // honoured governed exception — not a closure failure
      }
      closed = false;
      diagnostics.push({
        actionId: action.actionId,
        hop: res.hop,
        kind: res.status === 'missing' ? 'missing' : 'ambiguous',
        message: diagnosticMessage(action, res),
      });
    }
    actions.push({
      actionId: action.actionId,
      tool: action.tool,
      mutates: action.mutates,
      closed,
      hops,
    });
  }

  // Stale exceptions: a governed exception that never fired (the action is
  // actually closed at that hop). Remove it — it masks nothing.
  for (const exc of exceptions) {
    if (!usedExceptions.has(exceptionKey(exc.actionId, exc.hop))) {
      diagnostics.push({
        actionId: exc.actionId,
        hop: exc.hop,
        kind: 'stale-exception',
        message:
          `governed closure exception for ActionId '${exc.actionId}' at the ${exc.hop} hop is STALE ` +
          `— the action is fully closed there (reason on file: "${exc.reason}"). Remove the exception.`,
      });
    }
  }

  const honoured = exceptions.filter((exc) => usedExceptions.has(exceptionKey(exc.actionId, exc.hop)));
  diagnostics.sort((a, b) =>
    byString(`${a.actionId}\u0000${a.hop}\u0000${a.kind}`, `${b.actionId}\u0000${b.hop}\u0000${b.kind}`),
  );

  return {
    ok: diagnostics.length === 0,
    totalActions: actions.length,
    closedActions: actions.filter((a) => a.closed).length,
    actions,
    diagnostics,
    honouredExceptions: honoured,
  };
}

// ─── The generated graph artifact ────────────────────────────────────────────

/** The current reachability-graph artifact schema version. */
export const REACHABILITY_GRAPH_VERSION = 1 as const;

/** One action's ordered hop chain in the serialized graph. */
export interface GraphHop {
  readonly hop: ReachabilityHop;
  readonly status: HopStatus;
  readonly resolverCount: number;
}

/** One action's path through the graph (its node chain + edges, compact form). */
export interface GraphActionPath {
  readonly actionId: string;
  readonly tool: string;
  readonly mutates: boolean;
  readonly closed: boolean;
  readonly hops: readonly GraphHop[];
}

export interface GraphSummary {
  readonly totalActions: number;
  readonly closedActions: number;
  readonly fullyClosed: boolean;
  readonly mutatingActions: number;
  readonly exceptionCount: number;
}

export interface ReachabilityGraph {
  readonly graphVersion: typeof REACHABILITY_GRAPH_VERSION;
  readonly surfaceVersion: string;
  readonly hops: readonly ReachabilityHop[];
  readonly actions: readonly GraphActionPath[];
  readonly exceptions: readonly ClosureException[];
  readonly summary: GraphSummary;
  /** `sha256:` over the canonical graph body (excludes this digest itself). */
  readonly contentDigest: string;
}

/**
 * Build the deterministic reachability graph from the materialized inputs.
 * Byte-stable: actions are sorted by ActionId, hops are in the fixed order, and
 * the content digest is over canonical JSON — so regeneration from identical
 * inputs is byte-identical (mirrors P03-03's proof-fixture discipline).
 */
export function buildReachabilityGraph(inputs: ReachabilityInputs): ReachabilityGraph {
  const report = evaluateClosure(inputs);
  const actions: GraphActionPath[] = report.actions.map((a) => ({
    actionId: a.actionId,
    tool: a.tool,
    mutates: a.mutates,
    closed: a.closed,
    hops: a.hops.map((h) => ({ hop: h.hop, status: h.status, resolverCount: h.resolverCount })),
  }));
  const exceptions = [...(inputs.exceptions ?? [])].sort((x, y) =>
    byString(`${x.actionId}\u0000${x.hop}`, `${y.actionId}\u0000${y.hop}`),
  );
  const summary: GraphSummary = {
    totalActions: report.totalActions,
    closedActions: report.closedActions,
    fullyClosed: report.closedActions === report.totalActions && report.ok,
    mutatingActions: actions.filter((a) => a.mutates).length,
    exceptionCount: exceptions.length,
  };
  const body = {
    graphVersion: REACHABILITY_GRAPH_VERSION,
    surfaceVersion: inputs.surfaceVersion,
    hops: [...REACHABILITY_HOPS],
    actions,
    exceptions,
    summary,
  };
  return { ...body, contentDigest: digestText(canonicalJson(body)) };
}

/** Canonical, byte-stable serialization of the graph (trailing newline). */
export function serializeReachabilityGraph(graph: ReachabilityGraph): string {
  return canonicalJson(graph) + '\n';
}

// ─── Explicit node/edge expansion (the graph, spelled out) ───────────────────

export interface GraphNode {
  /** Stable node id, `${actionId}::${hop}` (or `${actionId}::origin`). */
  readonly id: string;
  readonly actionId: string;
  /** `origin` for the authored ActionId node; otherwise the hop it represents. */
  readonly kind: 'origin' | ReachabilityHop;
  readonly status: HopStatus;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly hop: ReachabilityHop;
  /** True when the source node resolved to exactly one target (the edge holds). */
  readonly complete: boolean;
}

/**
 * Expand the compact graph into explicit nodes: one `origin` node per action
 * plus one node per hop the action carries. `not-applicable` hops (a pure
 * action's `owner`) are omitted — the path legitimately skips that node.
 */
export function reachabilityNodes(graph: ReachabilityGraph): readonly GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const action of graph.actions) {
    nodes.push({ id: `${action.actionId}::origin`, actionId: action.actionId, kind: 'origin', status: 'ok' });
    for (const h of action.hops) {
      if (h.status === 'not-applicable') continue;
      nodes.push({
        id: `${action.actionId}::${h.hop}`,
        actionId: action.actionId,
        kind: h.hop,
        status: h.status,
      });
    }
  }
  return nodes;
}

/**
 * Expand the compact graph into explicit edges: the origin→…→fixture chain for
 * each action, skipping `not-applicable` hops (the edge bridges to the next
 * applicable node). An edge is `complete` when its source hop resolved to
 * exactly one.
 */
export function reachabilityEdges(graph: ReachabilityGraph): readonly GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const action of graph.actions) {
    let prevId = `${action.actionId}::origin`;
    let prevComplete = true;
    for (const h of action.hops) {
      if (h.status === 'not-applicable') continue;
      const toId = `${action.actionId}::${h.hop}`;
      edges.push({ from: prevId, to: toId, hop: h.hop, complete: prevComplete && h.status === 'ok' });
      prevId = toId;
      prevComplete = h.status === 'ok';
    }
  }
  return edges;
}
